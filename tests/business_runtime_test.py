"""Hermetic tests: temporary Makefiles, no real business repo or production calls."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))

SPEC = importlib.util.spec_from_file_location('business_runtime', Path(__file__).resolve().parents[1] / 'scripts/business_runtime.py')
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='business runtime fixture ')
        self.root = Path(self.temp.name).resolve() / 'service'
        self.state = Path(self.temp.name) / 'state'
        (self.root / '.venv/bin').mkdir(parents=True)
        (self.root / '.venv/bin/python').symlink_to(sys.executable)
        (self.root / runtime.SCRIPT).parent.mkdir(parents=True)
        (self.root / runtime.SCRIPT).write_text('FULL_REFRESH_TIME = (8, 50)\n')
        self.make('data-pipeline:\n\t@echo fixture-only\n\t@touch completed\nallupdate:\n\t@exit 3\n')
        self.manager = runtime.Runtime(self.root, self.state)
        self.runners = []

    def tearDown(self):
        for runner in self.runners:
            runner.wait(timeout=8)
        self.temp.cleanup()

    def make(self, text):
        (self.root / 'Makefile').write_text(text)

    def live_fixture_runners(self):
        rows = {}
        for path in (self.state / 'controls').glob('*.json'):
            record = json.loads(path.read_text())
            if 'runnerPid' in record:
                rows[record['runnerPid']] = {'command': f'business_runtime.py --execute {record["controlId"]}'}
        return rows

    def approve(self, record):
        spawn = runtime.subprocess.Popen
        def retain_runner(*args, **kwargs):
            runner = spawn(*args, **kwargs)
            self.runners.append(runner)
            return runner
        with patch.object(runtime, 'process_table', self.live_fixture_runners), patch.object(runtime.subprocess, 'Popen', retain_runner):
            return self.manager.approve(record['controlId'])

    def await_result(self, record, desired=None):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            value = self.manager.get(record['controlId'])
            if value['status'] == desired if desired else value['status'] in runtime.TERMINAL:
                return value
            time.sleep(.03)
        self.fail(f'Fixture did not settle: {value}')

    def test_request_is_inert_and_unknown_commands_rejected(self):
        record = self.manager.request('daily', 'run')
        self.assertEqual(record['status'], 'AWAITING_PERMISSION')
        self.assertFalse((self.root / 'completed').exists())
        for target, op in [('daily', 'restart'), ('scheduler', 'run'), ('shell', 'run')]:
            with self.assertRaises(ValueError): self.manager.request(target, op)
        with self.assertRaises(ValueError): self.manager.get('../secrets')
        self.assertEqual(self.manager.cancel(record['controlId'])['status'], 'CANCELLED')
        self.assertFalse((self.root / 'completed').exists())

    def test_detached_execution_logs_and_history_survive_new_client(self):
        record = self.manager.request('daily', 'run')
        self.approve(record)
        result = self.await_result(record)
        self.assertEqual(result['status'], 'COMPLETED')
        self.assertTrue((self.root / 'completed').exists())
        restored = runtime.Runtime(self.root, self.state)
        self.assertEqual(restored.history({})[0]['status'], 'COMPLETED')
        self.assertIn('fixture-only', restored.logs(record['controlId'])['text'])
        with self.assertRaises(RuntimeError): self.approve(record)

    def test_nonzero_is_not_reported_as_completed(self):
        record = self.manager.request('allupdate', 'run')
        self.approve(record)
        result = self.await_result(record)
        self.assertEqual(result['status'], 'FAILED')
        self.assertNotEqual(result['code'], 0)

    def test_running_operation_blocks_second_approval_and_can_cancel(self):
        self.make('data-pipeline:\n\t@sleep 20\n\t@touch should-not-exist\nallupdate:\n\t@touch second-should-not-exist\n')
        first = self.manager.request('daily', 'run')
        second = self.manager.request('allupdate', 'run')
        self.approve(first)
        self.await_result(first, 'RUNNING')
        try:
            with self.assertRaisesRegex(RuntimeError, '已有执行中'): self.approve(second)
            self.manager.cancel(first['controlId'])
            self.assertEqual(self.await_result(first)['status'], 'CANCELLED')
            self.assertFalse((self.root / 'second-should-not-exist').exists())
            self.assertFalse((self.root / 'should-not-exist').exists())
        finally:
            if self.manager.get(first['controlId'])['status'] not in runtime.TERMINAL:
                self.manager.cancel(first['controlId']); self.await_result(first)

    def test_crashed_runner_becomes_unknown_and_requires_explicit_review(self):
        record = self.manager.request('daily', 'run')
        self.manager.update(record['controlId'], status='RUNNING', runnerPid=999999, startedAt=runtime.now())
        self.assertEqual(self.manager.history({})[0]['status'], 'UNKNOWN')
        with patch.object(runtime, 'process_table', return_value={}):
            reviewed = self.manager.review(record['controlId'])
        self.assertEqual(reviewed['status'], 'REVIEWED')
        self.assertFalse((self.root / 'completed').exists())

    def test_state_probe_failure_is_not_offline(self):
        with patch.object(runtime, 'process_table', side_effect=RuntimeError('probe unavailable')):
            with self.assertRaisesRegex(RuntimeError, 'probe unavailable'): self.manager.status()

    def test_duplicate_schedulers_block_manual_approval(self):
        record = self.manager.request('daily', 'run')
        with patch.object(runtime, 'scheduler_pids', return_value=[101, 102]):
            with self.assertRaisesRegex(RuntimeError, '重复调度器'):
                self.approve(record)
        self.assertEqual(self.manager.get(record['controlId'])['status'], 'AWAITING_PERMISSION')
        self.assertFalse((self.root / 'completed').exists())

    def test_scheduler_identity_requires_python_script_and_exact_root(self):
        rows = {101: {'command': '/Library/Frameworks/Python.framework/Versions/3.11/Resources/Python.app/Contents/MacOS/Python workspace/utility_scripts/sales_scheduler.py'},
                102: {'command': 'rg sales_scheduler.py'},
                103: {'command': '/usr/bin/python3 workspace/utility_scripts/sales_scheduler.py'}}
        with patch.object(runtime, 'process_cwd', side_effect=[self.root, Path('/other/repo')]):
            self.assertEqual(runtime.scheduler_pids(self.root, rows), [101])

    def test_scheduled_log_has_steps_failure_and_incomplete_state(self):
        start = '[2026-11-05 08:50:00] ▶ refresh_daily: fixture\n'
        self.assertEqual(runtime.parse_daily_log(start, False)['status'], 'UNKNOWN')
        failed = start + '[2026-11-05 08:52:00] ■ refresh_daily exit=1\n[2026-11-05 08:52:00] 跳过 dataset_validate：上游失败\n'
        value = runtime.parse_daily_log(failed, False)
        self.assertEqual(value['status'], 'FAILED')
        self.assertEqual(value['skipped'], ['dataset_validate'])
        complete = start + '\n'.join(f'[2026-11-05 08:53:00] ■ {step} exit=0' for step in runtime.STEPS)
        self.assertEqual(runtime.parse_daily_log(complete, False)['status'], 'COMPLETED')

    def test_status_reads_schedule_and_existing_logs_without_running_make(self):
        with patch.object(runtime, 'process_table', return_value={}):
            status = self.manager.status()
        self.assertTrue(status['available'])
        self.assertIn('08:50', status['snapshot']['services'][0]['description'])
        self.assertEqual(status['snapshot']['services'][0]['status'], 'OFFLINE')
        self.assertFalse((self.root / 'completed').exists())

    def test_today_business_window_and_actual_process_coverage_are_separate(self):
        from datetime import date
        config = self.root / 'shared/schema/business_definition.json'
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({'time_periods': {'CM3': {'finish': '2026-10-23'},
            'LS8Neo': {'finish': '2026-11-30'}}, 'monitor': {'freshness': {'key_day_hours': [20,21,22,23]}}}))
        module = self.root / 'workspace/utils/monitors/phase.py'
        module.parent.mkdir(parents=True)
        module.write_text('''
def detect_active(bdef, today):
    return [dict(generation='LS8Neo', label='LS8 NEO', phase='launch', end='2026-11-05', start='2026-10-29')]
def is_key_day(bdef, today): return True
def monitor_until(bdef, generation): return None
def phase_of(bdef, generation, today): return 'launch' if generation == 'LS8Neo' else None
''')
        self.make('sales-scheduler: SERIES ?= CM3\n')
        default = runtime.today_overview(self.root, {}, [], today=date(2026,11,5))
        self.assertIn('今日上市', default)
        self.assertIn('未被执行范围覆盖', default)
        self.assertIn('CM3：2026-10-23 已结束', default)
        self.assertIn('20:00、21:00、22:00、23:00', default)
        self.assertIn('尚无今日批次日志', default)
        current = runtime.today_overview(self.root, {1: {'command': 'python sales_scheduler.py --series LS8Neo'}}, [1], today=date(2026,11,5))
        self.assertIn('当前进程范围：LS8Neo', current)
        self.assertIn('在监控范围内', current)
        self.assertNotIn('未被执行范围覆盖', current)
        self.assertIn('CM3：2026-10-23 已结束', current)
        dashboard = runtime.today_overview(self.root, {1: {'command': 'python sales_scheduler.py --series LS8Neo'}}, [1], today=date(2026,11,5), structured=True)
        self.assertEqual([model['name'] for model in dashboard['models']], ['LS8Neo'])
        self.assertEqual([task['time'] for task in dashboard['tasks']], ['08:50', '20:00', '21:00', '22:00', '23:00'])
        self.assertTrue(dashboard['models'][0]['covered'])
        self.assertEqual(dashboard['tasks'][0]['detail'], '等待核实执行结果')

    def test_monitor_uses_existing_make_target_and_rejects_other_models(self):
        config = self.root / 'shared/schema/business_definition.json'
        config.parent.mkdir(parents=True)
        config.write_text('{"time_periods":{"LS8Neo":{}}}')
        module = self.root / 'workspace/utils/monitors/phase.py'
        module.parent.mkdir(parents=True)
        module.write_text("""
def detect_active(bdef, today):
    return [dict(generation='LS8Neo', label='LS8Neo', phase='launch', end='2026-11-05', start='2026-10-29')]
def is_key_day(bdef, today): return False
def monitor_until(bdef, generation): return '2026-11-30'
def phase_of(bdef, generation, today): return 'launch'
""")
        script = self.root / 'workspace/business_scripts/vehicle_sales_monitor.py'
        script.parent.mkdir(parents=True)
        script.touch()
        self.make('monitor-sync:\n\t@printf "%s" "$(SERIES)" > model.txt\n')
        for target in ['monitor/CM3', 'monitor/LS8Neo;touch-x']:
            with self.assertRaises(ValueError): self.manager.request(target, 'run')
        record = self.manager.request('monitor/LS8Neo', 'run')
        self.assertFalse((self.root / 'model.txt').exists())
        self.approve(record)
        self.assertEqual(self.manager.wait(record['controlId'])['status'], 'COMPLETED')
        self.assertEqual((self.root / 'model.txt').read_text(), 'LS8Neo')

    def test_plan_evidence_is_scoped_to_due_slot_and_business_steps(self):
        from datetime import datetime
        lines = [
            '[2026-11-05 08:50:01] ▶ refresh_daily: fixture',
            '[2026-11-05 08:50:01] ■ refresh_daily exit=0',
            '[2026-11-05 08:50:01] ■ dataset_validate exit=0',
            '✅ 已写入多维表格记录',
            '✅ 飞书消息发送成功',
            '[2026-11-05 08:50:01] ■ daily_observation_sync exit=0',
            '[2026-11-05 08:50:01] ▶ monitor: fixture --series LS8Neo',
            '❌ 飞书消息发送失败: fixture',
            '[2026-11-05 08:50:01] ■ monitor exit=0',
        ]
        batches = runtime.scheduled_batches('\n'.join(lines))
        dashboard = {'models': [{'name':'LS8Neo','covered':True,'until':'2026-11-30','start':'2026-10-29'}]}
        config = self.root / 'shared/schema/business_definition.json'
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({'time_periods': {'LS8Neo': {'end':'2026-11-05'}},
            'monitor': {'freshness': {'key_day_hours': [20,21,22,23]}}}))
        def plans(at):
            return runtime.build_plans(self.root, dashboard, [], batches, (8,50), sampled=datetime.fromisoformat(at))
        self.assertEqual([p['status'] for p in plans('2026-11-05T10:00:00+08:00')], ['SUCCESS','FAILED','IDLE'])
        key_day = plans('2026-11-05T20:00:00+08:00')
        self.assertEqual([p['nextAt'] for p in key_day], [
            '2026-11-06T08:50:00+08:00', '2026-11-05T21:00:00+08:00', None,
        ])
        next_day = plans('2026-11-06T07:00:00+08:00')
        self.assertEqual(next_day[1]['nextAt'], '2026-11-06T08:50:00+08:00')
        self.assertEqual(next_day[1]['dueAt'], '2026-11-05T23:00:00+08:00')
        self.assertEqual(next_day[1]['status'], 'UNKNOWN')
        self.assertEqual(plans('2026-11-06T10:00:00+08:00')[0]['status'], 'UNKNOWN')

    def test_missing_business_configuration_is_not_an_empty_active_list(self):
        self.assertIn('不可核验', runtime.today_overview(self.root, {}, []))



if __name__ == '__main__':
    unittest.main()
