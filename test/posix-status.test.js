import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("../bin/ai-battery-run", import.meta.url));
const posixOnly = {
  skip: process.platform === "win32" ? "POSIX-only"
    : spawnSync("python3", ["--version"]).status === 0 ? false : "python3 is required"
};

function runScenario(t, meter, scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-status-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const meterPath = path.join(root, "meter.py");
  fs.writeFileSync(meterPath, `#!/usr/bin/env python3\n${meter}\n`, { mode: 0o755 });
  const python = [
    "import os, runpy, sys, time",
    "from pathlib import Path",
    "namespace = runpy.run_path(sys.argv[1], run_name='ai_battery_test')",
    "StatusLine = namespace['StatusLine']",
    "status = StatusLine(60, '10', 'all', 2, 'codex')",
    "def fetch():",
    "    status.refresh(force=True)",
    "    deadline = time.monotonic() + 5",
    "    while status.fetch_process is not None:",
    "        assert time.monotonic() < deadline, 'poll did not finish'",
    "        status.refresh()",
    "        time.sleep(0.01)",
    "try:",
    ...scenario.split("\n").map((line) => `    ${line}`),
    "finally:",
    "    status.close()"
  ].join("\n");
  const result = spawnSync("python3", ["-c", python, RUNNER], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, AI_BATTERY_BIN: meterPath },
    timeout: 10000
  });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
}

test("POSIX status accepts a slow reading without blocking the terminal", posixOnly, (t) => {
  runScenario(t, "import time\ntime.sleep(1.8)\nprint('Codex 0%')", [
    "start = time.monotonic()",
    "status.refresh(force=True)",
    "assert time.monotonic() - start < 0.75, 'refresh blocked terminal I/O'",
    "process = status.fetch_process",
    "assert process is not None",
    "status.refresh(force=True)",
    "assert status.fetch_process is process, 'overlapping fetch'",
    "fetch()",
    "assert status.text == 'Codex 0%', status.text",
    "assert process.poll() == 0 and process.stdout.closed"
  ].join("\n"));
});

test("POSIX status keeps its last reading across failures and recovers", posixOnly, (t) => {
  const meter = [
    "from pathlib import Path",
    "import sys",
    "mode = Path('mode').read_text()",
    "if mode == 'fail':",
    "    print('invalid partial output')",
    "    sys.exit(3)",
    "if mode != 'empty': print(mode)"
  ].join("\n");
  runScenario(t, meter, [
    "Path('mode').write_text('Codex 79%')",
    "fetch()",
    "assert status.text == 'Codex 79%'",
    "for mode in ['fail', 'empty']:",
    "    Path('mode').write_text(mode)",
    "    fetch()",
    "    assert status.text == '[stale] Codex 79%', status.text",
    "    assert 0 < status.seconds_until_refresh() <= 2, status.seconds_until_refresh()",
    "Path('mode').write_text('Codex 0%')",
    "fetch()",
    "assert status.text == 'Codex 0%', status.text",
    "Path(os.environ['AI_BATTERY_BIN']).unlink()",
    "fetch()",
    "assert status.text == '[stale] Codex 0%', status.text"
  ].join("\n"));
});

test("POSIX status reports initial failures and cleans up timed out polls", posixOnly, (t) => {
  const meter = [
    "from pathlib import Path",
    "import time",
    "if Path('mode').read_text() == 'hang': time.sleep(60)",
    "print('Codex 50%')"
  ].join("\n");
  runScenario(t, meter, [
    "Path('mode').write_text('hang')",
    "status.refresh(force=True)",
    "process = status.fetch_process",
    "status.fetch_deadline = time.monotonic() - 1",
    "status.refresh()",
    "assert status.text == 'AI Battery unavailable', status.text",
    "assert status.fetch_process is None",
    "assert process.poll() is not None and process.stdout.closed",
    "Path('mode').write_text('good')",
    "fetch()",
    "assert status.text == 'Codex 50%', status.text",
    "Path('mode').write_text('hang')",
    "status.refresh(force=True)",
    "process = status.fetch_process",
    "status.fetch_deadline = time.monotonic() - 1",
    "status.refresh()",
    "assert status.text == '[stale] Codex 50%', status.text",
    "assert process.poll() is not None and process.stdout.closed",
    "status.refresh(force=True)",
    "process = status.fetch_process",
    "status.close()",
    "assert process.poll() is not None and process.stdout.closed"
  ].join("\n"));
});

test("POSIX status bounds output and retains the last reading", posixOnly, (t) => {
  runScenario(t, "print('x' * (128 * 1024))", [
    "status.text = 'Codex 42%'",
    "status.last_reading = status.text",
    "status.has_reading = True",
    "fetch()",
    "assert status.text == '[stale] Codex 42%', status.text",
    "assert len(status.fetch_output) <= 72 * 1024"
  ].join("\n"));
});

test("POSIX status retries an initial failure on schedule", posixOnly, (t) => {
  runScenario(t, [
    "from pathlib import Path",
    "import sys",
    "mode = Path('mode').read_text()",
    "if mode == 'fail': sys.exit(3)",
    "print(mode)"
  ].join("\n"), [
    "Path('mode').write_text('fail')",
    "fetch()",
    "assert status.text == 'AI Battery unavailable', status.text",
    "Path('mode').write_text('Codex 0%')",
    "deadline = time.monotonic() + 4",
    "while status.text != 'Codex 0%':",
    "    assert time.monotonic() < deadline, status.text",
    "    status.refresh()",
    "    time.sleep(0.02)",
    "assert status.fetch_failures == 0"
  ].join("\n"));
});

test("POSIX terminal relays input and output while a slow poll finishes", posixOnly, (t) => {
  runScenario(t, "import time\ntime.sleep(1.8)\nprint('Codex 0%')", [
    "import errno, pty, select, subprocess",
    "master, slave = pty.openpty()",
    "child_code = \"import time; print('child-ready', flush=True); value = input(); print('echo:' + value, flush=True); time.sleep(2.5)\"",
    "child = subprocess.Popen([sys.executable, sys.argv[1], '--', sys.executable, '-c', child_code], stdin=slave, stdout=slave, stderr=slave)",
    "os.close(slave)",
    "output = b''",
    "sent = False",
    "deadline = time.monotonic() + 7",
    "try:",
    "    while True:",
    "        assert time.monotonic() < deadline, output",
    "        if not select.select([master], [], [], 0.05)[0]: continue",
    "        try:",
    "            chunk = os.read(master, 65536)",
    "        except OSError as error:",
    "            if error.errno == errno.EIO: break",
    "            raise",
    "        if not chunk: break",
    "        output += chunk",
    "        if not sent and b'child-ready' in output:",
    "            os.write(master, b'ping\\n')",
    "            sent = True",
    "    assert child.wait(timeout=1) == 0, output",
    "    assert b'AI Battery unavailable' not in output, output",
    "    assert b'echo:ping' in output and b'Codex 0%' in output, output",
    "    assert output.index(b'echo:ping') < output.index(b'Codex 0%'), output",
    "finally:",
    "    if child.poll() is None: child.kill()",
    "    child.wait()",
    "    os.close(master)"
  ].join("\n"));
});
