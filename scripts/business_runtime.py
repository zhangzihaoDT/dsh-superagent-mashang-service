#!/usr/bin/env python3
"""Local, allowlisted Mashang runtime controller. No Hub, Worker or Agent dependency.

Only `approve` starts work. Runners outlive the UI; status/logs never run business
commands. Business implementations and credentials remain in mashang-service.
"""
import argparse
import ast
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import importlib.util
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import time
import uuid
from zoneinfo import ZoneInfo


def today_overview(root, rows, pids, daily=None, today=None, structured=False):
    """Read business phase rules without invoking monitoring or scheduling."""
    today = today or datetime.now(ZoneInfo('Asia/Shanghai')).date()
    try:
        definition = read_json(root / 'shared/schema/business_definition.json')
        if not definition:
            raise ValueError('业务配置缺失')
        workspace = str(root / 'workspace')
        sys.path.insert(0, workspace)
        try:
            spec = importlib.util.spec_from_file_location('_mashang_phase', root / 'workspace/utils/monitors/phase.py')
            phase = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(phase)
        finally:
            sys.path.remove(workspace)
        active = phase.detect_active(definition, today)
        key = phase.is_key_day(definition, today)
        hours = sorted(int(h) for h in ((definition.get('monitor') or {}).get('freshness') or {}).get('key_day_hours', [17,18,19,20,21,22,23]))
        scope = None
        phases = ['presale', 'launch']
        if len(pids) == 1:
            words = shlex.split(rows[pids[0]]['command'])
            for option in ['--series', '--phase']:
                value = next((word.split('=', 1)[1] for word in words if word.startswith(option + '=')), None)
                if option in words:
                    value = words[words.index(option) + 1]
                if option == '--series': scope = value.split(',') if value else None
                elif value: phases = value.split(',')
            binding = '当前进程范围'
        else:
            match = re.search(r'^sales-scheduler:\s*SERIES\s*\?=\s*(.*)$', (root / 'Makefile').read_text(), re.M)
            scope = match.group(1).strip().split(',') if match and match.group(1).strip() else None
            binding = '启动入口默认范围'
        models = []
        lines = [f'{today.isoformat()} · 上海时间',
                 '每日数据与日报｜08:50 刷新 → 校验 → 每日观察同步 → 销售监控；' +
                 ('今日批次有日志，结果见下方。' if daily and daily['startedAt'][:10] == today.isoformat() else '尚无今日批次日志，不能确认已完成。')]
        for item in active:
            generation = item['generation']
            launch = item['phase'] == 'launch'
            until = (phase.monitor_until(definition, generation) or definition['time_periods'][generation].get('finish')) if launch else item['presale_close']
            if launch and until is None:
                from datetime import timedelta, date
                until = date.fromisoformat(item['end']) + timedelta(days=phase.launch_window_days(definition))
            covered = (scope is None or generation in scope) and item['phase'] in phases
            models.append({'name': generation, 'until': str(until), 'covered': covered,
                           'phase': '上市监控' if launch else '预售监控', 'start': item.get('start') or item.get('end')})
            event = ' · 今日上市' if item['end'] == today.isoformat() else ' · 今日开启预售' if item['start'] == today.isoformat() else ''
            lines.append(f'{item["label"]}（{generation}）｜' + ('上市监控窗口活跃' if launch else '预售监控窗口活跃') + event +
                         f' · 截止 {until}' + ('（不含）' if not launch else '') +
                         (' · 在监控范围内' if covered else ' · 未被执行范围覆盖'))
        if not active: lines.append('车型监控｜今日无活跃预售 / 上市监控窗口。')
        ended = []
        for generation, period in definition.get('time_periods', {}).items():
            cutoff = phase.monitor_until(definition, generation) or period.get('finish')
            if cutoff and str(cutoff) < today.isoformat():
                ended.append((str(cutoff), generation))
        if ended:
            lines.append('最近结束｜' + '；'.join(f'{generation}：{cutoff} 已结束' for cutoff, generation in sorted(ended, reverse=True)[:3]) + '。不属于今日活跃业务。')
        for generation in scope or []:
            if phase.phase_of(definition, generation, today) is None:
                lines.append(f'{generation}｜当前无活跃监控窗口，不能因启动参数而视为活跃。')
        lines.append('事件监控｜' + ('今日关键日，' + '、'.join(f'{hour:02}:00' for hour in hours) + ' 刷新订单并监控。' if key else '今日非关键日，无额外整点批次。'))
        lines.append('执行保障｜Scheduler ' + ('运行中' if len(pids) == 1 else '已停止' if not pids else '进程重复，需核验') +
                     f'；{binding}：' + ('全部活跃车型' if scope is None else '、'.join(scope)) + '。业务窗口活跃不代表任务已执行。')
        text = '\n'.join(lines)
        if not structured:
            return text
        sampled = datetime.now(ZoneInfo('Asia/Shanghai'))
        current_daily = daily if daily and daily['startedAt'][:10] == today.isoformat() else None
        result = {'COMPLETED': '命令执行结束 · 日报送达待核验', 'FAILED': '执行失败，请查看日志',
                  'RUNNING': '正在执行', 'UNKNOWN': '结果未知，等待核实'}
        daily_status = result.get(current_daily['status'], '等待核实执行结果') if current_daily else ('待执行' if sampled.date() == today and (sampled.hour, sampled.minute) < (8, 50) else '等待核实执行结果')
        tasks = [{'time': '08:50', 'title': '每日数据与日报', 'detail': daily_status,
                  'symbol': 'clock' if daily_status == '待执行' else 'questionmark.circle'}]
        names = '、'.join(item['name'] for item in models) or '车型'
        if key:
            for hour in hours:
                future = sampled.date() == today and hour > sampled.hour
                tasks.append({'time': f'{hour:02}:00', 'title': f'{names} 订单监控',
                              'detail': ('待执行 · 关键日' if future else '待核实执行结果 · 关键日') +
                                        (' · 存在车型覆盖缺口' if any(not item['covered'] for item in models) else '') +
                                        (' · 调度器未在线' if len(pids) != 1 else ''), 'symbol': 'clock' if future else 'questionmark.circle'})
        return {'date': today.isoformat(), 'models': models, 'tasks': tasks, 'overview': text,
                'todayStatus': daily_status, 'ended': '；'.join(f'{generation} · {cutoff} 已结束' for cutoff, generation in sorted(ended, reverse=True)[:3]),
                'coverage': binding + '：' + ('全部活跃车型' if scope is None else '、'.join(scope))}
    except Exception as error:
        message = f'{today.isoformat()} · 今日业务进程不可核验：{error}；请检查业务配置后手动刷新。'
        return {'date': today.isoformat(), 'models': [], 'tasks': [], 'overview': message, 'todayStatus': '不可核验', 'ended': '', 'coverage': message} if structured else message


def scheduled_batches(text, active=False):
    """Keep batch boundaries and receipts; timestamps alone never imply success."""
    batches = []
    batch = None
    for line in text.splitlines():
        match = re.match(r'^\[([^\]]+)\] (.*)$', line)
        message = match.group(2) if match else ''
        start = re.match(r'▶ (refresh_daily|refresh_full|refresh_order_data):', message)
        if start:
            batch = {'startedAt': datetime.fromisoformat(match.group(1)).replace(tzinfo=ZoneInfo('Asia/Shanghai')).isoformat(),
                     'kind': 'daily' if start.group(1) != 'refresh_order_data' else 'event', 'steps': {}, 'text': '', 'source': 'scheduler'}
            batches.append(batch)
        if batch is not None:
            batch['text'] += line + '\n'
            done = re.match(r'■ (\S+) exit=(-?\d+)', message)
            if done: batch['steps'][done.group(1)] = int(done.group(2))
    if batches: batches[-1]['active'] = active
    return batches


def evidence_state(record, kind):
    if record is None: return 'UNKNOWN', '缺少对应时点的完成证据'
    status = record.get('status', '')
    if status in {'DISPATCHED', 'RUNNING', 'CANCELLING'}: return 'RUNNING', '已受理，正在执行' if status != 'CANCELLING' else '正在取消'
    if status == 'AWAITING_PERMISSION': return 'PENDING_APPROVAL', '操作已登记，等待确认'
    text = record.get('text', '')
    if record.get('source') == 'scheduler':
        parts = re.split(r'(?m)^\[[^\]]+\] ▶ monitor:', text, maxsplit=1)
        text = parts[0] if kind == 'daily' else parts[-1] if len(parts) > 1 else ''
    for marker in ['飞书消息发送失败', '多维表格写入失败', 'Traceback (most recent call last)']:
        if marker in text:
            line = next(line for line in text.splitlines() if marker in line)
            return 'FAILED', line[:140]
    steps = record.get('steps', {})
    needed = ['refresh_daily', 'dataset_validate', 'daily_observation_sync'] if kind == 'daily' else ['refresh_order_data', 'monitor']
    if kind == 'monitor' and record.get('kind') == 'daily': needed = ['refresh_daily', 'dataset_validate', 'daily_observation_sync', 'monitor']
    failed = next(((name, code) for name, code in steps.items() if name in needed and code != 0), None)
    if status in {'FAILED', 'TIMEOUT', 'CANCELLED'} or record.get('code', 0) not in (0, None) or failed:
        return 'FAILED', (f'{failed[0]} 退出码 {failed[1]}' if failed else record.get('reason') or f'退出码 {record.get("code")}')[:140]
    completed = status == 'COMPLETED' and record.get('code') == 0 if record.get('source') != 'scheduler' else all(steps.get(name) == 0 for name in needed)
    if not completed:
        return ('RUNNING', '任务正在执行') if record.get('active') and not all(name in steps for name in needed) else ('UNKNOWN', '执行记录不完整，需核实')
    if kind == 'allupdate': return 'SUCCESS', '全量刷新与校验命令完成'
    if kind == 'daily' and '已写入多维表格记录' in text and '飞书消息发送成功' in text:
        return 'SUCCESS', '刷新、校验、表格写入与日报发送均有记录'
    if kind == 'monitor' and '飞书消息发送成功' in text and re.search(r'成功\s+1[，,]\s*失败\s+0', text):
        if '本次指标推送跳过' not in text and '⚠' not in text:
            return 'SUCCESS', '监控计算与消息发送有成功记录'
    return 'UNKNOWN', '命令已结束，业务送达证据不足'


def build_plans(root, dashboard, records, batches, daily_time, sampled=None, log_reader=None):
    from datetime import timedelta
    sampled = sampled or datetime.now(ZoneInfo('Asia/Shanghai'))
    tz = ZoneInfo('Asia/Shanghai')
    definition = read_json(root / 'shared/schema/business_definition.json') or {}
    key_dates = {period.get(key) for period in definition.get('time_periods', {}).values() for key in ['start', 'end']}
    hours = sorted(int(hour) for hour in ((definition.get('monitor') or {}).get('freshness') or {}).get('key_day_hours', [17,18,19,20,21,22,23]))
    def stamp(value): return datetime.fromisoformat(value).astimezone(tz)
    manual = []
    for record in records:
        if not record.get('startedAt') and record.get('status') != 'AWAITING_PERMISSION': continue
        item = dict(record, source='manual', text=log_reader(record['controlId']) if log_reader else '')
        manual.append(item)
    def plan(identifier, name, schedule, kind, target, due, candidates, note=''):
        candidates = sorted(candidates, key=lambda item: stamp(item.get('startedAt') or datetime.fromtimestamp(item['createdAt']/1000, tz).isoformat()), reverse=True)
        latest = candidates[0] if candidates else None
        eligible = next((item for item in candidates if item.get('status') in {'DISPATCHED','RUNNING','CANCELLING','AWAITING_PERMISSION'}), None)
        if eligible is None:
            eligible = next((item for item in candidates if due is None or stamp(item.get('startedAt') or datetime.fromtimestamp(item['createdAt']/1000,tz).isoformat()) >= due), None)
        if eligible:
            state, reason = evidence_state(eligible, kind)
        elif due is None:
            state, reason = ('PENDING', '下一计划时点尚未到达') if kind != 'allupdate' else ('IDLE', '暂无执行记录')
        else:
            state, reason = 'UNKNOWN', '该应执行时点缺少完成证据'
            if latest and latest.get('startedAt'): reason += ' · 最近记录 ' + stamp(latest['startedAt']).strftime('%m-%d')
        result = {'id': identifier, 'name': name, 'schedule': schedule, 'status': state, 'reason': reason,
                  'manualTarget': target, 'dueAt': due.isoformat() if due else None,
                  'lastAt': latest.get('startedAt') if latest else None, 'note': note,
                  'controlId': eligible.get('controlId') if eligible else None}
        result['logDate'] = (stamp(eligible['startedAt']).date().isoformat() if eligible and eligible.get('source') == 'scheduler'
                             else due.date().isoformat() if due and not eligible else None)
        return result
    daily_due = sampled.replace(hour=daily_time[0], minute=daily_time[1], second=0, microsecond=0)
    if daily_due > sampled: daily_due -= timedelta(days=1)
    result = [plan('daily', '每日数据与日报', f'每天 {daily_time[0]:02}:{daily_time[1]:02}', 'daily', 'daily', daily_due,
                   [b for b in batches if b['kind'] == 'daily'] + [r for r in manual if r['targetId'] == 'daily'])]
    # Active models are derived from the canonical phase rules, never Makefile defaults.
    for model in dashboard.get('models', []):
        generation = model['name']
        target = 'monitor/' + generation
        due = daily_due
        model_candidates = []
        for batch in batches:
            command = next((line for line in batch['text'].splitlines() if '▶ monitor:' in line), '')
            if command and (f'--series {generation}' in command or '--series' not in command):
                model_candidates.append(batch)
        event_times = [f'{hour:02}:00' for hour in hours]
        # Before the next daily run, yesterday's final key-day slot is still due.
        for offset in [1, 0]:
            day = sampled - timedelta(days=offset)
            if day.date().isoformat() not in key_dates: continue
            for hour in hours:
                slot = day.replace(hour=hour, minute=0, second=0, microsecond=0)
                if slot <= sampled: due = max(due, slot)
        # A newly active model has no obligation before its business start date.
        start = model.get('start')
        if start and due.date().isoformat() < start: due = None
        candidates = model_candidates + [r for r in manual if r['targetId'] == target]
        schedule = f'每天 {daily_time[0]:02}:{daily_time[1]:02}' + ('；关键日 ' + ' / '.join(event_times) if event_times else '；关键日按业务配置')
        supported = (root / 'workspace/business_scripts/vehicle_sales_monitor.py').exists() and re.search(r'^monitor-sync:', (root/'Makefile').read_text(), re.M)
        result.append(plan(target, generation + ' 订单监控', schedule, 'monitor', target if supported else None, due, candidates,
                           ('未被 Scheduler 范围覆盖；' if not model['covered'] else '') + f'监控截至 {model["until"]}'))
    result.append(plan('allupdate', 'Full data update', '手动执行', 'allupdate', 'allupdate', None,
                       [r for r in manual if r['targetId'] == 'allupdate']))
    return result

TARGETS = {'scheduler': 'Scheduler', 'daily': 'Daily pipeline', 'allupdate': 'Full data update'}
TERMINAL = {'COMPLETED', 'FAILED', 'REFUSED', 'CANCELLED', 'TIMEOUT', 'REVIEWED'}
SCRIPT = 'workspace/utility_scripts/sales_scheduler.py'
STEPS = ['refresh_daily', 'dataset_validate', 'daily_observation_sync', 'monitor']


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with open(temporary, 'x', encoding='utf-8') as file:
        os.chmod(temporary, 0o600)
        json.dump(value, file, ensure_ascii=False)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)


def read_json(path, default=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def process_table():
    # Failure must not turn into "stopped" and enable a duplicate start.
    result = subprocess.run(['/bin/ps', '-axo', 'pid=,ppid=,pgid=,stat=,command='],
                            capture_output=True, text=True, timeout=5, check=True)
    rows = {}
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 4)
        if len(parts) == 5 and all(p.isdigit() for p in parts[:3]) and not parts[3].startswith('Z'):
            pid, parent, group = map(int, parts[:3])
            rows[pid] = {'pid': pid, 'parent': parent, 'group': group, 'command': parts[4]}
    return rows


def process_cwd(pid):
    result = subprocess.run(['/usr/sbin/lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'],
                            capture_output=True, text=True, timeout=5)
    if result.returncode:
        raise RuntimeError(f'无法核验进程 {pid} 的工作目录；操作已禁用')
    paths = [line[1:] for line in result.stdout.splitlines() if line.startswith('n/')]
    if not paths:
        raise RuntimeError(f'进程 {pid} 缺少可核验的工作目录')
    return Path(paths[0]).resolve()


def scheduler_pids(root, rows):
    root = Path(root).resolve()
    result = []
    for pid, row in rows.items():
        if 'sales_scheduler.py' not in row['command']:
            continue
        try:
            words = shlex.split(row['command'])
        except ValueError:
            continue
        if not words or not re.fullmatch(r'python(?:\d+(?:\.\d+)*)?', Path(words[0]).name, re.IGNORECASE):
            continue
        cwd = process_cwd(pid)
        if cwd == root and any((cwd / word).resolve() == root / SCRIPT for word in words[1:] if word.endswith('sales_scheduler.py')):
            result.append(pid)
    return result


def descendants(pids, rows):
    found = set(pids)
    while True:
        more = {pid for pid, row in rows.items() if row['parent'] in found}
        if more <= found:
            return found
        found |= more


def parse_daily_log(text, active):
    batch = None
    for line in text.splitlines():
        match = re.match(r'^\[([^\]]+)\] (.*)$', line)
        if not match:
            continue
        stamp, message = match.groups()
        if re.match(r'▶ (refresh_daily|refresh_full):', message):
            batch = {'status': 'RUNNING', 'startedAt': datetime.fromisoformat(stamp).astimezone().isoformat(),
                     'finishedAt': None, 'steps': [], 'skipped': []}
        if batch is None:
            continue
        result = re.match(r'■ (\S+) exit=(-?\d+)', message)
        skipped = re.match(r'跳过 (\S+)：', message)
        if result:
            name, code = result.group(1), int(result.group(2))
            batch['steps'].append({'name': name, 'code': code})
            if code:
                batch.update(status='FAILED', summary=f'{name} 退出码 {code}')
            completed = {item['name'] for item in batch['steps']}
            if set(STEPS[1:]) <= completed and completed & {'refresh_daily', 'refresh_full'} and batch['status'] != 'FAILED':
                batch['status'] = 'COMPLETED'
            if batch['status'] != 'RUNNING':
                batch['finishedAt'] = datetime.fromisoformat(stamp).astimezone().isoformat()
        if skipped:
            batch['skipped'].append(skipped.group(1))
    if batch and batch['status'] == 'RUNNING' and not active:
        batch.update(status='UNKNOWN', summary='日志缺少批次完成记录，当前无对应执行进程；请核验日志')
    return batch


class Runtime:
    def __init__(self, root, state):
        self.root = Path(root).expanduser().resolve()
        self.state = Path(state).expanduser().resolve()

    @contextmanager
    def lock(self):
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        with open(self.state / 'control.lock', 'a') as file:
            fcntl.flock(file, fcntl.LOCK_EX)
            yield

    def path(self, control_id):
        if not re.fullmatch(r'local_[a-f0-9]{32}', control_id):
            raise ValueError('无效操作编号')
        return self.state / 'controls' / (control_id + '.json')

    def get(self, control_id):
        record = read_json(self.path(control_id))
        if record is None:
            raise ValueError('找不到操作记录')
        if record.get('serviceRoot') != str(self.root):
            raise ValueError('此操作不属于当前业务仓库')
        return record

    def update(self, control_id, **fields):
        with self.lock():
            record = self.get(control_id)
            record.update(fields, updatedAt=time.time() * 1000)
            atomic_json(self.path(control_id), record)
            return record

    def history(self, rows=None):
        rows = process_table() if rows is None else rows
        records = []
        for path in (self.state / 'controls').glob('local_*.json'):
            record = read_json(path)
            if record.get('serviceRoot') != str(self.root):
                continue
            if record['status'] in {'DISPATCHED', 'RUNNING', 'CANCELLING'}:
                pid = record.get('runnerPid')
                owner = rows.get(pid, {}).get('command', '')
                if not (record['controlId'] in owner and 'business_runtime.py' in owner):
                    # Never auto-retry a potentially published operation after a crash.
                    with self.lock():
                        latest = self.get(record['controlId'])
                        if latest['status'] == record['status']:
                            latest.update(status='UNKNOWN', reason='执行监督进程已退出，结果待核验；不会自动重跑', updatedAt=time.time() * 1000)
                            atomic_json(path, latest)
                        record = latest
            records.append(record)
        return sorted(records, key=lambda item: item['createdAt'], reverse=True)

    def validate_root(self):
        for relative in ['Makefile', SCRIPT, '.venv/bin/python']:
            if not (self.root / relative).exists():
                raise RuntimeError(f'业务仓库缺少 {relative}：{self.root}')

    def status(self):
        self.validate_root()
        rows = process_table()
        pids = scheduler_pids(self.root, rows)
        active = bool(descendants(pids, rows) - set(pids))
        records = self.history(rows)
        schedule = '调度规则暂不可读'
        daily_time = None
        batches = []
        try:
            tree = ast.parse((self.root / SCRIPT).read_text())
            times = [ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                     and any(isinstance(target, ast.Name) and target.id == 'FULL_REFRESH_TIME' for target in node.targets)]
            if times:
                hour, minute = times[0]
                daily_time = (hour, minute)
                schedule = f'每天 {hour:02}:{minute:02}（运行主机时间）；关键日整点监控沿用业务配置。'
        except (OSError, SyntaxError, ValueError, TypeError):
            pass
        daily = None
        for path in sorted((self.root / 'logs/scheduler').glob('????-??-??.log'), reverse=True):
            contents = path.read_text(errors='replace')
            batches.extend(scheduled_batches(contents, active and path.name == datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y-%m-%d.log')))
            if daily is None: daily = parse_daily_log(contents, active)
        operations = []
        for target in ['daily', 'allupdate']:
            last = next((record for record in records if record['targetId'] == target and record.get('startedAt')), None)
            run = {'status': last['status'], 'startedAt': last['startedAt'], 'finishedAt': last.get('finishedAt'),
                   'code': last.get('code'), 'summary': last.get('reason')} if last else {'status': 'IDLE'}
            if target == 'daily' and daily and (not run.get('startedAt') or
                datetime.fromisoformat(daily['startedAt']) > datetime.fromisoformat(run['startedAt'])):
                run = daily
            operations.append({'id': target, 'label': TARGETS[target], 'enabled': len(pids) < 2,
                               'cancellationSupported': True, 'lastRun': run})
        dashboard = today_overview(self.root, rows, pids, daily, structured=True)
        plans = build_plans(self.root, dashboard, records, batches, daily_time, log_reader=lambda control: self.tail(self.state / 'logs' / (control + '.log'))) if daily_time else []
        return {'available': True, 'receivedAt': now(), 'serviceRoot': str(self.root),
                'snapshot': {'services': [{'id': 'scheduler', 'label': 'Scheduler',
                    'status': 'ONLINE' if len(pids) == 1 else 'OFFLINE' if not pids else 'UNKNOWN',
                    'description': schedule, 'detail': f'{len(pids)} 个调度进程' + (' · 正在执行批次' if active else '')}],
                    'jobs': [], 'operations': operations, 'schedulerBusy': active or len(pids) > 1, 'todayOverview': dashboard['overview'], 'dashboard': dashboard, 'plans': plans}}

    def validate_operation(self, target, op):
        if target in TARGETS and op in (['up', 'down', 'restart'] if target == 'scheduler' else ['run']): return
        if isinstance(target, str) and re.fullmatch(r'monitor/[A-Za-z0-9_]+', target) and op == 'run':
            dashboard = today_overview(self.root, {}, [], structured=True)
            if any(model['name'] == target[8:] for model in dashboard['models']) and (self.root/'workspace/business_scripts/vehicle_sales_monitor.py').exists() and re.search(r'^monitor-sync:', (self.root/'Makefile').read_text(), re.M): return
        raise ValueError('不允许的操作或车型已不在活跃监控窗口')

    def request(self, target, op):
        self.validate_operation(target, op)
        self.validate_root()
        record = {'controlId': 'local_' + uuid.uuid4().hex, 'targetId': target, 'op': op, 'status': 'AWAITING_PERMISSION',
                  'serviceRoot': str(self.root), 'createdAt': time.time() * 1000, 'updatedAt': time.time() * 1000}
        with self.lock():
            atomic_json(self.path(record['controlId']), record)
        return record

    def approve(self, control_id):
        self.validate_root()
        rows = process_table()
        self.history(rows)
        with self.lock():
            record = self.get(control_id)
            if record['status'] != 'AWAITING_PERMISSION':
                raise RuntimeError('操作已经确认或结束，不能重复执行')
            self.validate_operation(record['targetId'], record['op'])
            # Re-read under the lock; another controller may have just approved.
            for path in (self.state / 'controls').glob('local_*.json'):
                other = read_json(path)
                if other.get('serviceRoot') == str(self.root) and other['status'] not in TERMINAL | {'AWAITING_PERMISSION'}:
                    raise RuntimeError('已有执行中或结果待核验的操作；请先处理该记录')
            if record['targetId'] != 'scheduler':
                pids = scheduler_pids(self.root, rows)
                if len(pids) > 1:
                    raise RuntimeError('检测到重复调度器，请先核验进程')
                if descendants(pids, rows) - set(pids):
                    raise RuntimeError('Scheduler 正在执行批次，请等待完成后再手动运行')
            log = self.state / 'logs' / (control_id + '.log')
            log.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with open(log, 'ab', buffering=0) as output:
                child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--service-root', str(self.root),
                    '--state-dir', str(self.state), '--execute', control_id], stdin=subprocess.DEVNULL,
                    stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            record.update(status='DISPATCHED', runnerPid=child.pid, startedAt=now(), updatedAt=time.time() * 1000)
            atomic_json(self.path(control_id), record)
            return record

    def cancel(self, control_id):
        with self.lock():
            record = self.get(control_id)
            if record['status'] == 'AWAITING_PERMISSION':
                record.update(status='CANCELLED', finishedAt=now())
            elif record['status'] in {'DISPATCHED', 'RUNNING', 'CANCELLING'} and record['op'] == 'run':
                record.update(status='CANCELLING', cancelRequested=True)
            else:
                raise RuntimeError('此操作不能取消；Scheduler 控制请等待状态核验')
            record['updatedAt'] = time.time() * 1000
            atomic_json(self.path(control_id), record)
            return record

    def review(self, control_id):
        rows = process_table()
        with self.lock():
            record = self.get(control_id)
            if record['status'] != 'UNKNOWN':
                raise RuntimeError('仅允许人工解除结果未知的记录')
            if record.get('childPid') in rows or record.get('runnerPid') in rows:
                raise RuntimeError('对应进程仍在运行，不能解除阻塞')
            record.update(status='REVIEWED', reason='人工核验后解除阻塞；不代表业务发布成功', updatedAt=time.time() * 1000)
            atomic_json(self.path(control_id), record)
            return record

    def wait(self, control_id):
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            record = self.get(control_id)
            if record['status'] not in {'DISPATCHED', 'RUNNING', 'CANCELLING'}: return record
            time.sleep(.5)
        self.history()
        return self.get(control_id)

    def logs(self, control_id=None, target=None, log_date=None):
        if log_date:
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', log_date): raise ValueError('无效日志日期')
            datetime.fromisoformat(log_date)
            path = self.root / 'logs/scheduler' / (log_date + '.log')
            return {'text': self.tail(path), 'path': str(path)}
        if target and not control_id:
            latest = next((item for item in self.history() if item["targetId"] == target and item.get("startedAt")), None)
            if latest: control_id = latest["controlId"]
            elif target == 'allupdate': return {'text': '暂无执行记录', 'path': str(self.state / 'logs')}
        if control_id:
            record = self.get(control_id)
            path = self.state / 'logs' / (control_id + '.log')
            if record['targetId'] == 'scheduler':
                paths = [path, self.state / 'scheduler.log']
                return {'text': '\n\n'.join(f'--- {item.name} ---\n{self.tail(item)}' for item in paths),
                        'path': str(path)}
        else:
            paths = sorted((self.root / 'logs/scheduler').glob('????-??-??.log'))
            path = paths[-1] if paths else self.state / 'scheduler.log'
        return {'text': self.tail(path), 'path': str(path)}

    @staticmethod
    def tail(path):
        if not path.exists():
            return '暂无日志'
        with open(path, 'rb') as file:
            file.seek(0, 2)
            file.seek(max(0, file.tell() - 131072))
            return file.read().decode('utf-8', errors='replace')

    def stop_scheduler(self):
        rows = process_table()
        pids = scheduler_pids(self.root, rows)
        if len(pids) > 1:
            raise RuntimeError('检测到重复调度器，拒绝猜测；请先核验进程')
        owned = descendants(pids, rows)
        for pid in owned:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 8
        while owned and time.monotonic() < deadline:
            time.sleep(0.2)
            fresh = process_table()
            owned = {pid for pid in owned if pid in fresh and fresh[pid]['command'] == rows[pid]['command']}
        for pid in owned:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if scheduler_pids(self.root, process_table()):
            raise RuntimeError('Scheduler 停止状态尚未确认')

    def start_scheduler(self):
        pids = scheduler_pids(self.root, process_table())
        if len(pids) > 1:
            raise RuntimeError('检测到重复调度器，拒绝启动')
        if pids:
            return
        env = os.environ.copy(); env.pop('MAKEFLAGS', None); env.pop('MFLAGS', None)
        with open(self.state / 'scheduler.log', 'ab', buffering=0) as output:
            child = subprocess.Popen(['/usr/bin/caffeinate', '-i', '/usr/bin/make', '-j1', 'sales-scheduler'],
                cwd=self.root, env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    raise RuntimeError(f'Scheduler 启动失败，退出码 {child.returncode}；查看调度日志')
                if len(scheduler_pids(self.root, process_table())) == 1:
                    return
                time.sleep(0.3)
            raise RuntimeError('Scheduler 启动核验超时')
        except Exception:
            # Do not leave an unverified process behind if probing fails.
            self.terminate_child(child)
            raise

    @staticmethod
    def terminate_child(child):
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass
        # The group can contain grandchildren even after the leader exits.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()

    def execute(self, control_id):
        # approve holds this same lock across spawn + durable ownership commit.
        with self.lock():
            record = self.get(control_id)
            if record.get('runnerPid') != os.getpid() or record['status'] not in {'DISPATCHED', 'CANCELLING'}:
                raise RuntimeError('执行者与已批准操作不匹配')
            record.update(status='RUNNING', updatedAt=time.time() * 1000)
            atomic_json(self.path(control_id), record)
        print(f'[{now()}] {TARGETS.get(record["targetId"], record["targetId"])} {record["op"]}', flush=True)
        child = None
        try:
            if record.get('cancelRequested'):
                self.update(control_id, status='CANCELLED', finishedAt=now()); return
            if record['targetId'] == 'scheduler':
                if record['op'] in {'down', 'restart'}:
                    self.stop_scheduler()
                if record['op'] in {'up', 'restart'}:
                    self.start_scheduler()
                self.update(control_id, status='COMPLETED', code=0, finishedAt=now(), reason='Scheduler 进程状态已核验')
                return
            self.validate_operation(record['targetId'], record['op'])
            target = 'data-pipeline' if record['targetId'] == 'daily' else 'allupdate'
            arguments = [target]
            if record['targetId'].startswith('monitor/'):
                arguments = ['monitor-sync', 'SERIES=' + record['targetId'][8:]]
            env = os.environ.copy(); env.pop('MAKEFLAGS', None); env.pop('MFLAGS', None)
            child = subprocess.Popen(['/usr/bin/make', '-j1'] + arguments, cwd=self.root, env=env,
                stdin=subprocess.DEVNULL, start_new_session=True)
            self.update(control_id, childPid=child.pid)
            deadline = time.monotonic() + 1800
            while child.poll() is None:
                cancelled = self.get(control_id).get('cancelRequested')
                if cancelled or time.monotonic() >= deadline:
                    self.terminate_child(child)
                    self.update(control_id, status='CANCELLED' if cancelled else 'TIMEOUT', finishedAt=now(),
                                reason='子进程组已终止；已有数据写入不会回滚', code=child.returncode)
                    return
                time.sleep(0.3)
            self.update(control_id, status='COMPLETED' if child.returncode == 0 else 'FAILED', code=child.returncode,
                        finishedAt=now(), reason='命令执行结束；外部送达结果请核验日志')
        except Exception as error:
            if child is not None and child.poll() is None:
                self.terminate_child(child)
            self.update(control_id, status='FAILED', finishedAt=now(), reason=str(error))
            print(str(error), file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--service-root', type=Path, required=True)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--execute')
    parser.add_argument('action', nargs='?', choices=['status', 'history', 'request', 'approve', 'cancel', 'review', 'logs', 'wait'])
    parser.add_argument('payload', nargs='?', default='{}')
    args = parser.parse_args()
    runtime = Runtime(args.service_root, args.state_dir)
    try:
        if args.execute:
            runtime.execute(args.execute)
            return
        body = json.loads(args.payload)
        if args.action == 'status': result = runtime.status()
        elif args.action == 'history': result = runtime.history()
        elif args.action == 'request': result = runtime.request(body.get('targetId'), body.get('op'))
        elif args.action == 'approve': result = runtime.approve(body.get('controlId', ''))
        elif args.action == 'cancel': result = runtime.cancel(body.get('controlId', ''))
        elif args.action == 'review': result = runtime.review(body.get('controlId', ''))
        elif args.action == 'wait': result = runtime.wait(body.get('controlId', ''))
        elif args.action == 'logs': result = runtime.logs(body.get('controlId'), body.get('targetId'), body.get('date'))
        else: raise ValueError('缺少操作')
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
