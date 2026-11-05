import assert from "node:assert/strict";
import { test } from "node:test";
import { codexTerminalDisplay, claudeTerminalDisplay } from "../lib/core/diagnostics.js";

const ready = { wrapperInstalled: true, activeIsWrapper: true, runnerExists: true, python3: "/usr/bin/python3",
  followsPath: true, resolvedOriginalCommand: "/opt/codex", insideCodex: true, currentCodexWrapped: true };

test("Codex readiness identifies installation, PATH, runner, Python and original-command failures independently of visibility", () => {
  const scenarios = [
    [{}, "ready", null],
    [{ providerEnabled: false }, "ready", null],
    [{ wrapperInstalled: false, providerEnabled: true }, "not configured", "ai-battery setup codex"],
    [{ activeIsWrapper: false }, "PATH mismatch", /shell configuration/],
    [{ runnerExists: false }, "runner missing", "npm install -g ai-battery@latest"],
    [{ python3: null }, "python3 missing", /Python 3/],
    [{ resolvedOriginalCommand: null }, "Codex missing", /Install Codex/]
  ];
  for (const [changes, expected, action] of scenarios) {
    const result = codexTerminalDisplay({ ...ready, ...changes }, { platform: "linux" });
    assert.equal(result.status, expected);
    assert.equal(result.ready, expected === "ready");
    if (action instanceof RegExp) assert.match(result.action, action);
    else assert.equal(result.action, action);
  }
  assert.equal(codexTerminalDisplay({ ...ready, python3: null }, { platform: "win32" }).status, "ready");
  assert.equal(codexTerminalDisplay(ready, { platform: "win32", layout: "plain" }).status, "disabled by layout");
});

test("doctor separates the running session from the integration for the next launch", () => {
  assert.equal(codexTerminalDisplay({ ...ready, wrapperInstalled: false }).currentSession, "wrapped");
  assert.equal(codexTerminalDisplay({ ...ready, currentCodexWrapped: false }).currentSession, "unwrapped");
  assert.equal(codexTerminalDisplay({ ...ready, insideCodex: false }).currentSession, "not checked");
});

test("Claude diagnostics distinguish missing integration, external hooks, errors and first-use data", () => {
  for (const [statusLine, reading, expected, action] of [
    [{}, false, "not configured", "ai-battery setup claude"],
    [{ error: "invalid settings" }, false, "settings error", null],
    [{ configured: true, managed: false }, false, "external statusLine", "ai-battery setup claude --force"],
    [{ configured: true, managed: true, needsRefresh: true }, false, "update required", "ai-battery setup claude"],
    [{ configured: true, managed: true }, false, "waiting for data", "Start Claude Code to receive usage data."],
    [{ configured: true, managed: true }, true, "ready", null]
  ]) {
    const result = claudeTerminalDisplay(statusLine, reading);
    assert.equal(result.status, expected);
    assert.equal(result.action, action);
  }
});
