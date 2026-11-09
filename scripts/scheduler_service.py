"""Persistent settings and a launchd-owned supervisor for the business scheduler."""
import fcntl
import hashlib
import os
from pathlib import Path
import plistlib
import shlex
import signal
import subprocess
import sys
import time


class SchedulerService:
    def __init__(self, runtime):
        self.runtime = runtime
        self.root, self.state = runtime.root, runtime.state
        self.label = 'local.mashang.scheduler.' + hashlib.sha256(str(self.root).encode()).hexdigest()[:12]
        self.plist = Path.home() / 'Library/LaunchAgents' / (self.label + '.plist')
        self.domain = f'gui/{os.getuid()}'

    def settings(self, rows=None, pids=None):
        from business_runtime import read_json
        saved = read_json(self.state / 'scheduler-settings.json')
        if saved:
            if saved.get('serviceRoot') != str(self.root):
                raise RuntimeError('调度配置属于其他业务目录')
            return saved
        series, phase, source = '', 'presale,launch', '待确认，请选择监控范围'
        if pids and len(pids) == 1:
            words = shlex.split(rows[pids[0]]['command'])
            for key in ('--series', '--phase'):
                value = next((w.split('=', 1)[1] for w in words if w.startswith(key + '=')), None)
                if key in words:
                    value = words[words.index(key) + 1]
                if value is not None:
                    if key == '--series': series = value
                    else: phase = value
            source = '当前调度进程，保存后生效'
        else:
            paths = sorted((self.root / 'logs/scheduler').glob('*process.json'), key=lambda p: p.stat().st_mtime, reverse=True)
            for path in paths:
                value = read_json(path, {})
                if isinstance(value.get('series'), str) and isinstance(value.get('phase'), str):
                    series, phase, source = value['series'], value['phase'], '历史启动记录，保存前请核对'
                    break
        return dict(serviceRoot=str(self.root), series=series, phase=phase, timezone='Asia/Shanghai',
                    autoRestore=False, desired=False, confirmed=False, source=source)

    def validate(self, value):
        from business_runtime import read_json
        known = read_json(self.root / 'shared/schema/business_definition.json', {}).get('time_periods', {})
        series = value.get('series', '')
        phase = value.get('phase', '')
        if not isinstance(series, str) or not series or any(s not in known for s in series.split(',')):
            raise ValueError('请选择业务配置中的车型代际，多个用英文逗号分隔')
        if not isinstance(phase, str) or not phase or any(p not in ('presale', 'launch') for p in phase.split(',')):
            raise ValueError('阶段仅支持 presale、launch 或 presale,launch')
        if type(value.get('autoRestore')) is not bool:
            raise ValueError('登录恢复设置无效')
        return dict(series=','.join(dict.fromkeys(series.split(','))), phase=','.join(dict.fromkeys(phase.split(','))),
                    timezone='Asia/Shanghai', autoRestore=value['autoRestore'])

    def ctl(self, *args, check=True):
        result = subprocess.run(['/bin/launchctl', *args], capture_output=True, text=True, timeout=10)
        if check and result.returncode:
            raise RuntimeError('登录服务操作失败：' + result.stderr.strip())
        return result

    def loaded(self):
        return self.ctl('print', self.domain + '/' + self.label, check=False).returncode == 0

    def agent_config(self):
        return {'Label': self.label, 'ProgramArguments': [sys.executable, str(Path(__file__).resolve()),
                str(self.root), str(self.state)], 'WorkingDirectory': str(self.root),
                'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 30, 'ExitTimeOut': 1800,
                'EnvironmentVariables': {'HOME': str(Path.home()), 'TZ': 'Asia/Shanghai',
                    'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
                'StandardOutPath': str(self.state / 'scheduler.log'),
                'StandardErrorPath': str(self.state / 'scheduler.log'), 'Umask': 63}

    def install(self, auto_restore):
        self.state.mkdir(parents=True, exist_ok=True)
        config = self.agent_config()
        loaded = self.ctl('print', self.domain + '/' + self.label, check=False)
        if loaded.returncode == 0 and str(self.state / 'scheduler.log') not in loaded.stdout:
            raise RuntimeError('该业务目录已有另一控制台管理的运行服务')
        # A single label owns this business repository across controller checkouts.
        if self.plist.exists() and plistlib.loads(self.plist.read_bytes()).get('ProgramArguments') != config['ProgramArguments']:
            raise RuntimeError('该业务目录已有另一控制台的登录服务，请先迁移原服务')
        destination = self.plist if auto_restore else self.state / 'scheduler-agent.plist'
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix('.tmp')
        temporary.write_bytes(plistlib.dumps(config)); temporary.chmod(0o600); temporary.replace(destination)
        if not auto_restore:
            self.plist.unlink(missing_ok=True)
        return destination

    def save(self, body):
        from business_runtime import atomic_json, process_table, scheduler_pids, read_json
        fields = self.validate(body)
        self.runtime.history()
        with self.runtime.lock():
            rows = process_table()
            current = self.settings(rows, scheduler_pids(self.root, rows))
            if any(r['status'] not in {'COMPLETED', 'FAILED', 'REFUSED', 'CANCELLED', 'TIMEOUT', 'REVIEWED'}
                   for r in (read_json(p) for p in (self.state / 'controls').glob('local_*.json'))
                   if r.get('serviceRoot') == str(self.root)):
                raise RuntimeError('请先处理执行中或待确认的操作，再修改调度设置')
            if current.get('desired') or scheduler_pids(self.root, rows):
                if any(fields[k] != current[k] for k in ('series', 'phase')):
                    raise RuntimeError('请先停止调度，再修改监控范围')
            value = dict(current, **fields, confirmed=True, source='已保存的调度配置')
            # Install first. A failed write must not advertise an enabled setting.
            self.install(value['autoRestore'])
            atomic_json(self.state / 'scheduler-settings.json', value)
        return value

    def set_desired(self, desired):
        from business_runtime import atomic_json, now
        with self.runtime.lock():
            value = self.settings()
            if desired and not value.get('confirmed'):
                raise RuntimeError('请先核对并保存调度设置')
            if desired:
                self.validate(value)
            value.update(desired=desired, changedAt=now())
            atomic_json(self.state / 'scheduler-settings.json', value)
        return value

    def start(self):
        from business_runtime import process_table, scheduler_pids
        if scheduler_pids(self.root, process_table()):
            raise RuntimeError('已有调度进程，请先停止后交由守护服务启动')
        value = self.settings()
        if not value.get('confirmed'):
            raise RuntimeError('请先核对并保存调度设置')
        destination = self.install(value['autoRestore'])
        self.set_desired(True)
        try:
            self.ctl('enable', self.domain + '/' + self.label)
            if not self.loaded():
                self.ctl('bootstrap', self.domain, str(destination))
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if len(scheduler_pids(self.root, process_table())) == 1:
                    return
                time.sleep(.5)
            raise RuntimeError('启动尚未通过核验：' + self.runtime.tail(self.state / 'scheduler.log'))
        except Exception:
            self.set_desired(False)
            raise

    def stop(self):
        from business_runtime import process_table, scheduler_pids
        self.set_desired(False)
        rows = process_table()
        pids = scheduler_pids(self.root, rows)
        if len(pids) > 1:
            raise RuntimeError('存在重复调度进程，请核验日志')
        # Signal only the scheduler. Its handler lets the current subprocess finish.
        for pid in pids:
            try: os.kill(pid, signal.SIGTERM)
            except ProcessLookupError: pass
        deadline = time.monotonic() + 1800
        while scheduler_pids(self.root, process_table()):
            if time.monotonic() >= deadline:
                raise RuntimeError('已暂停后续调度，当前批次仍在退出中，请查看日志')
            time.sleep(.5)

    def details(self):
        from business_runtime import read_json
        return read_json(self.state / 'scheduler-health.json', {})


def group_alive(pid):
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False


def supervise(runtime):
    from business_runtime import atomic_json, now, process_table, scheduler_pids, SCRIPT
    service = SchedulerService(runtime)
    lock_path = runtime.root / 'logs/scheduler/managed.lock'
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('已有守护进程或尚未结束的调度批次')
        stopping = False
        def shutdown(signum, frame):
            nonlocal stopping
            stopping = True
        signal.signal(signal.SIGTERM, shutdown)
        signal.signal(signal.SIGINT, shutdown)
        child = None
        sleep_guard = None
        stop_sent = False
        retry_at = 0
        health = service.details()
        try:
            while True:
                with runtime.lock():
                    value = service.settings()
                    desired = value.get('confirmed') and value.get('desired') and not stopping
                    if child is not None and child.poll() is not None and not group_alive(child.pid):
                        health.update(lastExitAt=now(), exitCode=child.returncode,
                                      reason='主动停止' if stop_sent or not desired else '调度进程退出，等待恢复')
                        child = None
                        if sleep_guard is not None:
                            sleep_guard.wait(timeout=10)
                            sleep_guard = None
                        retry_at = time.monotonic() + 30
                    if child is None and desired and time.monotonic() >= retry_at:
                        service.validate(value)
                        if scheduler_pids(runtime.root, process_table()):
                            health['reason'] = '发现已有调度进程，等待其退出'
                        else:
                            env = dict(os.environ, TZ='Asia/Shanghai', PYTHONUNBUFFERED='1')
                            child = subprocess.Popen([str(runtime.root / '.venv/bin/python'), str(runtime.root / SCRIPT),
                                '--series', value['series'], '--phase', value['phase']], cwd=runtime.root,
                                env=env, stdin=subprocess.DEVNULL, pass_fds=(lock.fileno(),), start_new_session=True)
                            sleep_guard = subprocess.Popen(['/usr/bin/caffeinate', '-i', '-w', str(child.pid)])
                            stop_sent = False
                            health.update(startedAt=now(), reason='调度进程已启动', series=value['series'], phase=value['phase'])
                    if child is not None and child.poll() is None and not desired and not stop_sent:
                        child.send_signal(signal.SIGTERM)
                        stop_sent = True
                        health['reason'] = '等待当前批次结束'
                    if child is not None and child.poll() is not None:
                        health['reason'] = '调度进程退出，等待残留业务批次结束'
                    health.update(heartbeatAt=now(), supervisorPid=os.getpid(), childPid=child.pid if child else None,
                                  state='STOPPING' if child and stop_sent else 'ONLINE' if child else 'STARTING' if desired else 'OFFLINE')
                    atomic_json(runtime.state / 'scheduler-health.json', health)
                    if stopping and child is None:
                        break
                time.sleep(2)
        finally:
            if child is not None and child.poll() is None:
                child.send_signal(signal.SIGTERM)
                child.wait()
            if sleep_guard is not None:
                sleep_guard.wait(timeout=10)


if __name__ == '__main__':
    from business_runtime import Runtime
    supervise(Runtime(Path(sys.argv[1]), Path(sys.argv[2])))
