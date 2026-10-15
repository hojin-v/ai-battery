import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/ai-battery.js", import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-freshness-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex");
  const sessions = path.join(codexHome, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  function event(usedPercent) {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "token_count", rate_limits: {
        limit_id: "codex",
        primary: { used_percent: usedPercent, window_minutes: 300, resets_at: 4102444800 }
      } }
    }) + "\n";
  }
  function read(home = codexHome, extraArgs = [], activeProvider = "codex") {
    const result = spawnSync(process.execPath, [...extraArgs, CLI, "--provider", "codex", "--active-provider", activeProvider, "--json"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: path.join(root, "home"),
        CODEX_HOME: home,
        CODEX_THREAD_ID: "",
        AI_BATTERY_STATE_DIR: path.join(root, "state"),
        AI_BATTERY_SHARED_USAGE_STATE_DIR: path.join(root, "shared-usage"),
        AI_BATTERY_SCAN_CACHE_SECONDS: "60"
      },
      timeout: 10000
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).results[0];
  }
  return { root, codexHome, sessions, event, read };
}

test("Codex immediately reads appended usage events within the cache TTL", (t) => {
  const f = fixture(t);
  const log = path.join(f.sessions, "usage.jsonl");
  fs.writeFileSync(log, f.event(20));
  assert.equal(f.read().percentRemaining, 80);
  fs.appendFileSync(log, f.event(100));
  assert.equal(f.read().percentRemaining, 0);
});

test("Codex detects newly created sessions within the cache TTL", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.sessions, "first.jsonl"), f.event(20));
  assert.equal(f.read().percentRemaining, 80);
  const next = path.join(f.sessions, "second.jsonl");
  fs.writeFileSync(next, f.event(21));
  const later = new Date(Date.now() + 1000);
  fs.utimesSync(next, later, later);
  const data = f.read();
  assert.equal(data.percentRemaining, 79);
  assert.equal(data.source, next);
});

test("Codex does not reuse another CODEX_HOME's cached percentage", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.sessions, "usage.jsonl"), f.event(20));
  assert.equal(f.read().percentRemaining, 80);
  const other = path.join(f.root, "other-codex");
  fs.mkdirSync(path.join(other, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(other, "sessions", "usage.jsonl"), f.event(99));
  assert.equal(f.read(other).percentRemaining, 1);
});

test("a known active Codex does not need a subprocess activity scan to read usage", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.sessions, "usage.jsonl"), f.event(20));
  const marker = path.join(f.root, "process-scan");
  const preload = path.join(f.root, "observe.cjs");
  fs.writeFileSync(preload, [
    'const cp = require("node:child_process");',
    'const original = cp.execFileSync;',
    'cp.execFileSync = function(file, ...args) {',
    `  require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(file));`,
    '  return original.call(this, file, ...args);',
    '};',
    'require("node:module").syncBuiltinESMExports();'
  ].join("\n"));
  assert.equal(f.read(f.codexHome, ["--require", preload]).percentRemaining, 80);
  assert.equal(fs.existsSync(marker), false);
});

test("usage polling from Claude preserves a separate running Codex", { skip: process.platform !== "win32" }, (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.sessions, "usage.jsonl"), f.event(20));
  const state = path.join(f.root, "state");
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, "windows-processes-scan-cache.json"), JSON.stringify({
    version: 2,
    capturedAt: new Date().toISOString(),
    value: [{ cmdline: "C:\\Tools\\codex.exe", hasTty: true }]
  }));
  assert.equal(f.read(f.codexHome, [], "claude").running, true);
});
