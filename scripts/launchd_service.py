"""User LaunchAgent backend. Imported only for an explicitly installed profile."""
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time

LABEL = 'local.dsh.superagent'

def paths(host, args):
    if args.profile != 'superagent':
        raise RuntimeError('LaunchAgent installation is scoped to superagent only.')
    return Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist'), f'gui/{os.getuid()}', host.ARTIFACTS / 'launchd'

def ctl(*args, check=True):
    result = subprocess.run(['/bin/launchctl', *args], capture_output=True, text=True)
    if check and result.returncode:
        raise RuntimeError('launchctl ' + ' '.join(args) + ': ' + result.stderr.strip())
    return result

def loaded(domain):
    return ctl('print', domain + '/' + LABEL, check=False).returncode == 0

def install(host, args):
    plist, domain, logs = paths(host, args)
    if host.processes(args.profile) or loaded(domain):
        raise RuntimeError('Stop the existing service before installing/updating the LaunchAgent.')
    node = shutil.which('node')
    dsh = host.PROJECT_SETUP / 'runtime/node_modules/.bin/dsh'
    if not node or not dsh.is_file():
        raise RuntimeError('Project DSH runtime or node is missing.')
    logs.mkdir(parents=True, exist_ok=True)
    config = {'Label': LABEL, 'ProgramArguments': [sys.executable, str(host.ROOT / 'scripts/launchd-exec'), str(host.PROJECT_SETUP / 'dsh-home/state/superagent'), node, str(dsh.resolve()), '--profile', args.profile, '--no-open'],
              'WorkingDirectory': str(host.ROOT), 'EnvironmentVariables': {'HOME': str(Path.home()),
              'DSH_HOME': str(host.PROJECT_SETUP / 'dsh-home'),
              'PATH': str(Path(node).parent) + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
              'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10, 'ExitTimeOut': 330,
              'StandardOutPath': str(logs / 'stdout.log'), 'StandardErrorPath': str(logs / 'stderr.log'), 'Umask': 63}
    plist.parent.mkdir(parents=True, exist_ok=True)
    if plist.exists():
        old = plistlib.loads(plist.read_bytes())
        if old.get('WorkingDirectory') != str(host.ROOT):
            raise RuntimeError('Existing LaunchAgent belongs to another checkout; refusing replacement.')
    temporary = plist.with_suffix('.tmp')
    temporary.write_bytes(plistlib.dumps(config)); temporary.chmod(0o600); temporary.replace(plist)
    (host.control(args.profile) / 'launchd-installed').write_text(str(plist))
    print('Installed ' + str(plist))
    return start(host, args)

def stop(host, args):
    plist, domain, logs = paths(host, args)
    # Persistently disable first: login and KeepAlive must respect an intentional stop.
    ctl('disable', domain + '/' + LABEL)
    (host.control(args.profile) / 'manually-stopped').touch()
    if loaded(domain):
        ctl('bootout', domain + '/' + LABEL)
    deadline = time.monotonic() + args.stop_timeout
    while host.processes(args.profile):
        if time.monotonic() > deadline:
            raise RuntimeError('Shutdown timed out; launchd job is disabled. Logs: ' + str(logs))
        time.sleep(.5)
    print('LaunchAgent stopped and disabled until explicit start.')
    return 0

def start(host, args):
    plist, domain, logs = paths(host, args)
    if not plist.exists():
        raise RuntimeError('LaunchAgent plist missing; run install.')
    if not loaded(domain) and host.processes(args.profile):
        raise RuntimeError('Unmanaged DSH process exists; refusing duplicate startup.')
    if not loaded(domain) and host.state(args.url) is not None:
        raise RuntimeError('Service URL already occupied; refusing duplicate startup.')
    ctl('enable', domain + '/' + LABEL)
    if not loaded(domain):
        ctl('bootstrap', domain, str(plist))
    (host.control(args.profile) / 'manually-stopped').unlink(missing_ok=True)
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        current = host.state(args.url)
        if host.runtime_up(current):
            return host.status(args)
        time.sleep(1)
    host.startup_error('LaunchAgent startup health check timed out. Diagnostics: scripts/dsh-superagent diagnose', logs / 'stderr.log')

def dispatch(host, args):
    plist, domain, logs = paths(host, args)
    if args.action == 'install': return install(host, args)
    if args.action == 'diagnose':
        print(ctl('print', domain + '/' + LABEL, check=False).stdout)
        print(ctl('print-disabled', domain, check=False).stdout)
        print('Plist:', plist, '\nLogs:', logs)
        return host.status(args)
    if args.action == 'stop': return stop(host, args)
    if args.action == 'uninstall':
        stop(host, args)
        plist.unlink(missing_ok=True)
        # Retain marker to prevent accidental fallback to tmux after uninstall.
        print('LaunchAgent removed; runtime, profiles and state retained. Run install to restore.')
        return 0
    if args.action == 'restart': stop(host, args)
    return start(host, args)
