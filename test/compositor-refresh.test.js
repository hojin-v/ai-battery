import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { HeadlessTerminalCompositor } from "../bin/terminal-compositor.js";
import { terminalSize } from "../bin/ai-battery-run-win.js";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless");

test("Windows size polling uses the live console when cached rows are stale", () => {
  const stream = { columns: 80, rows: 24, getWindowSize: () => [80, 24], _handle: {
    getWindowSize: (size) => { size[0] = 120; size[1] = 40; return 0; }
  } };
  assert.deepEqual(terminalSize(stream), { cols: 120, rows: 40 });
  stream._handle.getWindowSize = () => -1;
  assert.deepEqual(terminalSize(stream), { cols: 80, rows: 24 });
});

test("battery refresh preserves the child screen without clearing it", async () => {
  const writes = [];
  const compositor = new HeadlessTerminalCompositor({ columns: 60, rows: 10, frameIntervalMs: 0, writeHost: (data) => { writes.push(data); return true; } });
  try {
    compositor.start();
    await compositor.write("Codex conversation");
    await compositor.setStatusText("Codex 76% | Claude 100%");
    await compositor.flush();
    writes.length = 0;
    await compositor.setStatusText("Codex 75% | Claude 100%");
    await compositor.flush();
    const frame = writes.join("");
    assert.doesNotMatch(frame, /\x1b\[2J/);
    assert.doesNotMatch(frame, /Codex conversation/);
    assert.match(frame, /Claude 100%/);
    assert.match(frame, /\x1b\[10;1H/);
    writes.length = 0;
    await compositor.write("\x1b[?25l\x1b[?25h");
    await compositor.flush();
    assert.doesNotMatch(writes.join(""), /\x1b\[2J/);
    assert.doesNotMatch(writes.join(""), /Codex conversation/);
  } finally { await compositor.dispose(); }
});

test("scrolling moves only child rows and matches the logical screen", async () => {
  const writes = [];
  const host = new Terminal({ allowProposedApi: true, cols: 60, rows: 12 });
  const compositor = new HeadlessTerminalCompositor({ columns: 60, rows: 12, frameIntervalMs: 0, writeHost: (data) => { writes.push(data); return true; } });
  const drainHost = async () => {
    for (const data of writes.splice(0)) await new Promise((resolve) => host.write(data, resolve));
  };
  try {
    compositor.start();
    await compositor.setStatusText("Codex 76% | Claude 100%");
    await compositor.write("\x1b[?1049h" + Array.from({ length: 11 }, (_, row) => `\x1b[${row + 1};1Hline ${row}`).join(""));
    await compositor.flush();
    await drainHost();
    for (const direction of ["S", "T"]) {
      await compositor.write(`\x1b[2${direction}`);
      await compositor.flush();
      assert.match(writes.join(""), new RegExp("\\x1b\\[1;9r\\x1b\\[2" + direction));
      await drainHost();
      const snapshot = compositor.snapshot();
      for (let row = 0; row < 11; row += 1) {
        assert.equal(host.buffer.active.getLine(row).translateToString(true).trimEnd(), snapshot.lines[row].trimEnd());
      }
      assert.equal(host.buffer.active.getLine(11).translateToString(true).trimEnd(), snapshot.status.trimEnd());
    }
  } finally { await compositor.dispose(); host.dispose(); }
});

test("transcript scrolling preserves the warning footer and its background style", async () => {
  const writes = [];
  const host = new Terminal({ allowProposedApi: true, cols: 100, rows: 12 });
  const compositor = new HeadlessTerminalCompositor({ columns: 100, rows: 12, frameIntervalMs: 0, writeHost: (data) => { writes.push(data); return true; } });
  const drain = async () => {
    for (const data of writes.splice(0)) await new Promise((resolve) => host.write(data, resolve));
  };
  try {
    compositor.start();
    await compositor.setStatusText("Codex 68% | Claude 100%");
    await compositor.write("\x1b[?1049h" + Array.from({ length: 9 }, (_, row) => `\x1b[${row + 1};1Hbody ${row}`).join("")
      + "\x1b[10;1HGPT model | workspace\x1b[11;1H? for shortcuts\x1b[11;75H\x1b[33m⚠ 1 warning\x1b[0m | f2");
    await compositor.flush();
    await drain();
    for (const direction of ["S", "T"]) {
      await compositor.write(`\x1b[1;9r\x1b[2${direction}\x1b[r`);
      await compositor.flush();
      assert.match(writes.join(""), new RegExp("\\x1b\\[1;9r\\x1b\\[2" + direction));
      await drain();
      assert.match(host.buffer.active.getLine(9).translateToString(true), /GPT model/);
      assert.match(host.buffer.active.getLine(10).translateToString(true), /1 warning/);
      for (let col = 74; col < 85; col += 1) {
        const actual = host.buffer.active.getLine(10).getCell(col);
        const expected = compositor.terminal.buffer.active.getLine(10).getCell(col);
        assert.equal(actual.getBgColor(), expected.getBgColor());
        assert.equal(actual.isInverse(), expected.isInverse());
      }
    }
    await compositor.write("\x1b[11;1H\x1b[2K? for shortcuts");
    await compositor.flush();
    await drain();
    assert.doesNotMatch(host.buffer.active.getLine(10).translateToString(true), /warning/);
    assert.match(host.buffer.active.getLine(11).translateToString(true), /Claude/);
  } finally { await compositor.dispose(); host.dispose(); }
});

test("colored battery text retains original styles and repeated output produces no repaint", async () => {
  const writes = [];
  const compositor = new HeadlessTerminalCompositor({ columns: 100, rows: 12, frameIntervalMs: 0, writeHost: (data) => { writes.push(data); return true; } });
  const text = "  \x1b[97mCodex\x1b[0m \x1b[32m❚❚❚\x1b[0m 68% \x1b[90m┃ Claude\x1b[0m \x1b[32m❚❚❚❚\x1b[0m \x1b[90m100% │ 5h --:--\x1b[0m";
  try {
    compositor.start();
    await compositor.setStatusText(text);
    await compositor.flush();
    assert.ok(writes.join("").includes(text));
    writes.length = 0;
    await compositor.write("\x1b[0m");
    await compositor.flush();
    assert.equal(writes.length, 0);
    const chunks = Array.from({ length: 200 }, (_, i) => compositor.write(`\x1b[1;1Hframe-${i}`));
    await Promise.all(chunks);
    await compositor.flush();
    assert.match(compositor.snapshot().lines[0], /frame-199/);
    assert.match(compositor.snapshot().status, /Claude/);
  } finally { await compositor.dispose(); }
});
