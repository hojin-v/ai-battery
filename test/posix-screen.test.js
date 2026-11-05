import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless");
const runner = process.env.AI_BATTERY_TEST_RUNNER
  || fileURLToPath(new URL("../bin/ai-battery-run", import.meta.url));
const available = process.platform !== "win32" && spawnSync("python3", ["--version"]).status === 0;
const korean = "Codex ▐▐▐▐ 40% │ 5h 04:29 │ 7d 91% ┃ Claude ? (Claude Code 로그가 없습니다.)";

function render(cols, text, scenario = "for i in range(6): status.draw_cached()") {
  const python = [
    "import json, runpy, sys",
    "namespace = runpy.run_path(sys.argv[1], run_name='screen_test')",
    "fixture = json.loads(sys.argv[2])",
    "status = namespace['StatusLine'](3600, '8', 'all', 2, 'codex')",
    "status.cols, status.rows = fixture['cols'], 12",
    "status.text = fixture['text']",
    "sys.stdout.write('\\x1b[10;1HCodex footer\\x1b[11;1H? for shortcuts')",
    "sys.stdout.flush()",
    scenario
  ].join("\n");
  const result = spawnSync("python3", ["-c", python, runner, JSON.stringify({ cols, text })], { timeout: 5000 });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stderr}`);
  return result.stdout;
}

async function write(terminal, output) {
  await new Promise((resolve) => terminal.write(output, resolve));
}

function rows(terminal) {
  return Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i).translateToString(true));
}

function assertScreen(terminal) {
  assert.equal(terminal.buffer.active.baseY, 0, "status refresh must not add scrollback");
  assert.equal(rows(terminal).filter((line) => line.includes("40%")).length, 1, "one status row after repeated refreshes");
  assert.equal(rows(terminal)[9], "Codex footer");
  assert.equal(rows(terminal)[10], "? for shortcuts");
  assert.match(rows(terminal)[11], /Codex/);
  assert.equal(terminal.buffer.active.cursorX, 15, "restore the child's input cursor");
  assert.equal(terminal.buffer.active.cursorY, 10);
}

test("POSIX Korean status refresh never wraps or duplicates the bottom row", { skip: !available }, async () => {
  const terminal = new Terminal({ cols: 100, rows: 12, scrollback: 1000, allowProposedApi: true });
  try {
    await write(terminal, render(100, korean));
    assertScreen(terminal);
  } finally { terminal.dispose(); }
});

test("POSIX status clips wide characters and strips row-changing controls while retaining colors", { skip: !available }, async () => {
  for (const cols of [20, 40, 65, 100]) {
    const terminal = new Terminal({ cols, rows: 12, scrollback: 1000, allowProposedApi: true });
    try {
      const text = `\x1b[32mCodex 40% 한글界 Ａ e\u0301 🔋\x1b[0m\r\n\t${korean}\x1b[2J\x1b[99;1H`;
      await write(terminal, render(cols, text));
      assertScreen(terminal);
      assert.equal(terminal.buffer.active.getLine(11).getCell(0).getFgColor(), 2);
    } finally { terminal.dispose(); }
  }
});

test("POSIX cached and fetched status updates erase the old tail without padding or scrolling", { skip: !available }, async () => {
  const terminal = new Terminal({ cols: 100, rows: 12, scrollback: 1000, allowProposedApi: true });
  try {
    await write(terminal, render(100, korean, [
      "status.refresh = lambda force=False: False",
      "for i in range(12):",
      "    status.last_draw = 0",
      "    status.draw(force=True, dirty=True)",
      "status.text = 'Codex 40%'",
      "status.draw_cached()"
    ].join("\n")));
    assertScreen(terminal);
    assert.equal(rows(terminal)[11], "Codex 40%");
  } finally { terminal.dispose(); }
});

test("POSIX status repaint after narrowing the terminal stays on its reserved row", { skip: !available }, async () => {
  const terminal = new Terminal({ cols: 100, rows: 12, scrollback: 1000, allowProposedApi: true });
  try {
    // A short row must not be expanded with spaces that reflow on resize.
    await write(terminal, render(100, "Codex 40% ┃ Claude --%"));
    terminal.resize(40, 12);
    await write(terminal, render(40, korean));
    assertScreen(terminal);
  } finally { terminal.dispose(); }
});

test("POSIX real PTY stays interactive with one Korean status row across repeated redraws", { skip: !available }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-screen-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const helper = fileURLToPath(new URL("./helpers/posix-screen.py", import.meta.url));
  const result = spawnSync("python3", [helper, runner, root], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.inputCount, 6);
  assert.ok(report.refreshCount >= 6);
  assert.equal(report.exitCode, 0);
  const terminal = new Terminal({ cols: 100, rows: 12, scrollback: 1000, allowProposedApi: true });
  try {
    await write(terminal, Buffer.from(report.screen, "base64"));
    assertScreen(terminal);
    assert.equal(rows(terminal)[4], "input:6");
  } finally { terminal.dispose(); }
});
