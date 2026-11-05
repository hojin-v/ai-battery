"""Exercise the installed PTY relay and return its screen before clean exit."""
import base64
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import termios
import time


runner, root = sys.argv[1:]
root = Path(root)
meter = root / "meter.py"
meter.write_text("#!/usr/bin/env python3\nprint('Codex ▐▐▐▐ 40% │ 5h 04:29 │ 7d 91% ┃ Claude ? (Claude Code 로그가 없습니다.)')\n")
meter.chmod(0o755)
child = root / "child.py"
child.write_text("""import os, sys, tty
tty.setraw(0)
os.write(1, b'\\x1b[10;1HCodex footer\\x1b[11;1H? for shortcuts')
count = 0
while True:
    key = os.read(0, 1)
    if key == b'q': break
    if key == b'p':
        count += 1
        os.write(1, f'\\x1b[5;1Hinput:{count}\\x1b[11;1H? for shortcuts'.encode())
""")
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 12, 100, 0, 0))
env = {**os.environ, "AI_BATTERY_BIN": str(meter), "AI_BATTERY_TMUX": "row", "TMUX": ""}
process = subprocess.Popen([sys.executable, runner, "--interval", "0.5", "--layout", "reserve", "--", sys.executable, str(child)],
                           stdin=slave, stdout=slave, stderr=slave, env=env)
os.close(slave)
output = bytearray()
sent = 0
last_sent = time.monotonic()
finished = None
deadline = time.monotonic() + 8
try:
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            chunk = os.read(master, 65536)
            assert chunk, "runner exited before completing screen updates"
            output.extend(chunk)
        now = time.monotonic()
        if sent < 6 and b"40%" in output and now - last_sent > 0.25:
            os.write(master, b"p")
            sent += 1
            last_sent = now
        if b"input:6" in output:
            finished = finished or now
            if now - finished > 0.3:
                break
        assert process.poll() is None, bytes(output)
    assert finished is not None, bytes(output)
    assert output.count(b"40%") >= 6, bytes(output)
    before_exit = bytes(output)
    os.write(master, b"q")
    while process.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                if not os.read(master, 65536): break
            except OSError as error:
                if error.errno == errno.EIO: break
                raise
    assert process.wait(timeout=1) == 0
    print(json.dumps({"screen": base64.b64encode(before_exit).decode(), "inputCount": sent,
                      "refreshCount": before_exit.count(b"40%"), "exitCode": process.returncode}))
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    os.close(master)
