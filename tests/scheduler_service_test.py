"""Scheduler settings and recovery regressions, using isolated business fixtures."""
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import business_runtime as runtime
from scheduler_service import SchedulerService


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='scheduler fixture ')
        self.root = Path(self.temp.name) / 'service'
        (self.root / 'shared/schema').mkdir(parents=True)
        (self.root / 'shared/schema/business_definition.json').write_text(json.dumps({'time_periods': {'LS8Neo': {}, 'CM3': {}}}))
        self.manager = runtime.Runtime(self.root, Path(self.temp.name) / 'state')
        self.service = SchedulerService(self.manager)
        self.service.plist = Path(self.temp.name) / 'LaunchAgents' / (self.service.label + '.plist')
        self.fields = dict(series='LS8Neo', phase='launch', autoRestore=False)

    def tearDown(self):
        self.temp.cleanup()

    def save(self, **changes):
        with patch.object(runtime, 'process_table', return_value={}):
            return self.service.save(dict(self.fields, **changes))

    def test_history_is_only_a_proposal_until_saved(self):
        folder = self.root / 'logs/scheduler'; folder.mkdir(parents=True)
        (folder / 'last_process.json').write_text(json.dumps(self.fields))
        proposal = self.service.settings()
        self.assertEqual(proposal['series'], 'LS8Neo')
        self.assertFalse(proposal['confirmed'])
        with self.assertRaisesRegex(RuntimeError, '先核对'):
            self.service.set_desired(True)
        self.assertFalse((self.manager.state / 'scheduler-settings.json').exists())

    def test_save_persists_scope_without_starting_and_toggle_removes_login_file(self):
        self.save(autoRestore=True)
        self.assertTrue(self.service.plist.exists())
        self.assertFalse(self.service.settings()['desired'])
        self.save(autoRestore=False)
        self.assertFalse(self.service.plist.exists())
        self.assertEqual(self.service.settings()['series'], 'LS8Neo')
        self.assertFalse((self.manager.state / 'scheduler-health.json').exists())

    def test_unknown_scope_and_pending_approval_block_configuration_changes(self):
        with self.assertRaises(ValueError): self.save(series='UNKNOWN')
        self.save()
        runtime.atomic_json(self.manager.state / 'controls/local_pending.json',
                            dict(serviceRoot=str(self.manager.root), status='AWAITING_PERMISSION', createdAt=1))
        with self.assertRaisesRegex(RuntimeError, '待确认'): self.save(series='CM3')
        self.assertEqual(self.service.settings()['series'], 'LS8Neo')

    def test_desired_running_scope_is_immutable_and_stop_is_durable(self):
        self.save()
        self.service.set_desired(True)
        with self.assertRaisesRegex(RuntimeError, '先停止'): self.save(series='CM3')
        self.service.set_desired(False)
        self.save(series='CM3')
        self.assertFalse(SchedulerService(self.manager).settings()['desired'])

    def test_install_failure_does_not_enable_recovery_setting(self):
        self.save()
        with patch.object(self.service, 'install', side_effect=OSError('fixture denied')):
            with self.assertRaises(OSError): self.save(autoRestore=True)
        self.assertFalse(self.service.settings()['autoRestore'])

    @unittest.skipUnless(os.environ.get('DSH_TEST_NATIVE_PROCESSES') == '1', 'requires macOS launchd; temporary fixtures only')
    def test_launchd_crash_restart_graceful_stop_and_session_reload(self):
        (self.root / '.venv/bin').mkdir(parents=True)
        (self.root / '.venv/bin/python').symlink_to(sys.executable)
        script = self.root / runtime.SCRIPT; script.parent.mkdir(parents=True)
        script.write_text('''import signal, time
from pathlib import Path
stop = False
def shutdown(signum, frame):
    global stop
    stop = True
signal.signal(signal.SIGTERM, shutdown)
with open('starts', 'a') as out: out.write('started\\n')
while not stop: time.sleep(.1)
time.sleep(2)
Path('graceful').write_text('finished')
''')
        self.save()
        def wait_for(predicate, timeout=45):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if predicate(): return
                time.sleep(.3)
            self.fail('fixture timed out: ' + self.manager.tail(self.manager.state / 'scheduler.log'))
        def pids(): return runtime.scheduler_pids(self.manager.root, runtime.process_table())
        try:
            self.service.start()
            wait_for(lambda: (self.root / 'starts').exists())
            pid = pids()[0]
            with self.assertRaisesRegex(RuntimeError, '已有调度进程'): self.service.start()
            os.kill(pid, signal.SIGKILL)
            wait_for(lambda: len((self.root / 'starts').read_text().splitlines()) == 2)
            self.assertNotEqual(pids()[0], pid)
            self.service.stop()
            self.assertTrue((self.root / 'graceful').exists())
            self.assertEqual(pids(), [])
            # Reload the launchd job, as a new login would, with a durable stop intent.
            supervisor = self.service.details()['supervisorPid']
            self.service.ctl('bootout', self.service.domain + '/' + self.service.label)
            wait_for(lambda: supervisor not in runtime.process_table() and not self.service.loaded())
            self.service.ctl('bootstrap', self.service.domain, str(self.manager.state / 'scheduler-agent.plist'))
            time.sleep(3)
            self.assertEqual(pids(), [])
            self.service.start()
            self.assertEqual(len(pids()), 1)
        finally:
            self.service.stop()
            self.service.ctl('bootout', self.service.domain + '/' + self.service.label, check=False)
