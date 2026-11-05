import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import termios
import time

root = Path(os.environ['AI_BATTERY_TEST_ROOT'])
cli = os.environ['AI_BATTERY_TEST_CLI']
node = os.environ['AI_BATTERY_TEST_NODE']
home = root / 'home'
state = root / 'state'
data = root / 'data'
original = root / 'original'
for folder in (home, state, data, original, home / '.codex/sessions'):
    folder.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, HOME=str(home), USERPROFILE=str(home), SHELL='/bin/bash',
           XDG_CONFIG_HOME=str(root / 'config'), XDG_DATA_HOME=str(root / 'xdg-data'),
           CODEX_HOME=str(home / '.codex'), AI_BATTERY_STATE_DIR=str(state),
           AI_BATTERY_DATA_DIR=str(data), AI_BATTERY_SHARED_USAGE_STATE_DIR=str(root / 'shared'),
           AI_BATTERY_RC=str(home / '.bashrc'),
           AI_BATTERY_NO_UPDATE_CHECK='1', LANGUAGE='en', TERM='xterm-256color',
           PATH=os.pathsep.join([str(original), str(Path(node).parent), str(Path(sys.executable).parent),
                                 str(Path(shutil.which('tmux') or '/usr/bin/tmux').parent), '/usr/bin', '/bin']),
           PS1='BATTERY_PROMPT> ', AI_BATTERY_INTERVAL='0.5')
for key in ('TMUX', 'TMUX_PANE', 'AI_BATTERY_TMUX_STATUS', 'CLAUDEX_BATTERY_TMUX_STATUS',
            'AI_BATTERY_TMUX', 'CLAUDEX_BATTERY_TMUX', 'AI_BATTERY_WRAPPED_CODEX',
            'AI_BATTERY_SHIM_DIR', 'AI_BATTERY_TMUX_CONF', 'AI_BATTERY_BIN', 'CLAUDEX_BATTERY_BIN'):
    env.pop(key, None)
fake = original / 'codex'
fake.write_text(f'#!{sys.executable}\nimport os\nprint("CODEX_READY wrapped="+os.getenv("AI_BATTERY_WRAPPED_CODEX","0"),flush=True)\nfor line in __import__("sys").stdin:\n if line.strip()=="exit-fixture":break\n print("CODEX_ECHO:"+line.strip(),flush=True)\n')
fake.chmod(0o755)
(home / '.bashrc').write_text('export USER_SETTING=preserved\n')
tmux_conf = home / '.tmux.conf'
tmux_conf.write_text('set -g status-left "KEEP_LEFT"\nset -g status-right "USER_CLOCK"\n')
codex_conf = home / '.codex/config.toml'
codex_conf.write_text('model = "user-model"\n[tui]\nstatus_line = ["context-remaining"]\n')
event = {'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'type': 'event_msg',
         'payload': {'type': 'token_count', 'rate_limits': {'limit_id': 'codex', 'primary': {
             'used_percent': 26, 'window_minutes': 300, 'resets_at': int(time.time()) + 3600}}}}
(home / '.codex/sessions/test.jsonl').write_text(json.dumps(event)+'\n')

def command(args, custom_env=None):
    result = subprocess.run(args, env=custom_env or env, text=True, capture_output=True, timeout=35)
    assert result.returncode == 0, f'{args}: {result.stdout}\n{result.stderr}'
    return result.stdout

def setup(*args, custom_env=None):
    return json.loads(command([node, cli, 'setup', *args, '--json'], custom_env))

terminals = []
class Terminal:
    def __init__(self, argv, child_env):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.execvpe(argv[0], argv, child_env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
        self.pending = b''
        terminals.append(self)
    def send(self, text):
        os.write(self.fd, text.encode())
    def until(self, text, seconds=8):
        token = text.encode()
        deadline = time.monotonic() + seconds
        while token not in self.pending and time.monotonic() < deadline:
            if select.select([self.fd], [], [], .1)[0]:
                try: self.pending += os.read(self.fd, 65536)
                except OSError: break
        assert token in self.pending, f'Missing {text!r} in terminal: {self.pending[-2500:]!r}'
        end = self.pending.index(token) + len(token)
        result, self.pending = self.pending[:end], self.pending[end:]
        return result
    def close(self):
        try: os.close(self.fd)
        except OSError: pass
        try: os.kill(self.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: os.waitpid(self.pid, 0)
        except ChildProcessError: pass

socket = str(root / 'tmux.sock')
checks = []
try:
    first = setup('codex', '--wrap-codex', '--configure-codex-statusline')
    wrapper = Path(first['codex']['wrapperPath'])
    setup('tmux')
    command([node, cli, 'off', 'claude'])
    saved_config = codex_conf.read_bytes()
    saved_shell = (home / '.bashrc').read_bytes()
    running_env = dict(env, PATH=str(wrapper.parent)+os.pathsep+env['PATH'])
    running = Terminal(['/bin/bash', '--noprofile', '--norc', '-i'], running_env)
    running.until('BATTERY_PROMPT> ')
    running.send('hash codex; codex\n')
    running.until('CODEX_READY wrapped=1')
    running.until('74%')
    checks.append('Running Codex has a real PTY usage row')
    tarball = os.environ.get('AI_BATTERY_TEST_UPGRADE_TARBALL')
    if tarball:
        command(['npm', 'install', '-g', '--prefix', os.environ['AI_BATTERY_TEST_PREFIX'],
                 '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', tarball])
        checks.append('npm upgraded the package while a wrapped Codex was running')
    refreshed = setup()
    assert refreshed['codex']['ok'] and refreshed['codex']['wrapperPath'] == str(wrapper)
    assert refreshed['tmux']['ok'] and wrapper.exists()
    assert codex_conf.read_bytes() == saved_config
    assert (home / '.bashrc').read_bytes() == saved_shell
    assert 'bin/ai-battery.js' in tmux_conf.read_text()
    assert 'USER_CLOCK' in tmux_conf.read_text()
    running.send('after-setup\n')
    running.until('CODEX_ECHO:after-setup')
    event['timestamp'] = __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()
    event['payload']['rate_limits']['primary']['used_percent'] = 31
    with (home / '.codex/sessions/test.jsonl').open('a') as events:
        events.write(json.dumps(event)+'\n')
    running.until('69%')
    checks.append('The already-running usage meter refreshes after upgrade and setup')
    running.send('exit-fixture\n')
    running.until('BATTERY_PROMPT> ')
    running.send('codex\n')
    running.until('CODEX_READY wrapped=1')
    running.until('69%')
    checks.append('Existing Bash cache launches Codex again after setup without hash -r')
    fresh = Terminal(['/bin/bash', '--noprofile', '-i'], env)
    fresh.send('codex\n')
    fresh.until('CODEX_READY wrapped=1')
    fresh.until('69%')
    checks.append('A newly opened shell loads the saved integration and usage row')
    tmux = shutil.which('tmux')
    if tmux:
        command([tmux, '-S', socket, '-f', str(tmux_conf), 'new-session', '-d', '-s', 'continuity', '-x', '120', '-y', '30'])
        server_pid = command([tmux, '-S', socket, 'display-message', '-p', '#{pid}']).strip()
        command([tmux, '-S', socket, 'set-option', '-g', 'status', 'off'])
        command([tmux, '-S', socket, 'set-option', '-g', 'status-right', 'STALE_COMMAND'])
        client = Terminal([tmux, '-S', socket, 'attach-session', '-t', 'continuity'], env)
        deadline = time.monotonic() + 3
        while command([tmux, '-S', socket, 'display-message', '-p', '#{session_attached}']).strip() != '1':
            assert time.monotonic() < deadline, 'tmux client did not attach'
            time.sleep(.05)
        live_env = dict(env, TMUX=f'{socket},{server_pid},0')
        active = setup(custom_env=live_env)
        assert active['tmux']['active'], active
        assert command([tmux, '-S', socket, 'show-option', '-gv', 'status']).strip() == 'on'
        assert command([tmux, '-S', socket, 'show-option', '-gv', 'status-left']).strip() == 'KEEP_LEFT'
        assert 'bin/ai-battery.js' in command([tmux, '-S', socket, 'show-option', '-gv', 'status-right'])
        client.until('69%')
        checks.append('An already-attached tmux client redraws the usage bar without reconnecting')
    print(json.dumps({'result': 'passed', 'checks': checks}, indent=2))
finally:
    if shutil.which('tmux'):
        subprocess.run(['tmux', '-S', socket, 'kill-server'], env=env, capture_output=True, timeout=5)
    for terminal in reversed(terminals):
        terminal.close()
