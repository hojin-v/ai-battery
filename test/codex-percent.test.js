import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  claudeHeader,
  codexWrapperScript,
  installClaudeStatusline,
  installCodexWrapper,
  normalizeLimit,
  removeAiBatteryShellPathBlock,
  removeOrRestoreCodexWrapper,
  sameFilePath,
  visibleWidth,
  uninstallClaudeStatusline
} from "../bin/ai-battery.js";

const CLI_PATH = fileURLToPath(new URL("../bin/ai-battery.js", import.meta.url));

function withEnv(values, callback) {
  const previous = new Map();
  for (const key of Object.keys(values)) {
    previous.set(key, process.env[key]);
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("Codex used_percent 1.0 is treated as 1%, not ratio 100%", () => {
  const primary = normalizeLimit({
    used_percent: 1.0,
    window_minutes: 300,
    resets_at: 4102444800
  });

  assert.equal(primary.usedPercent, 1);
  assert.equal(primary.remainingPercent, 99);
});

test("fractional ratio fields are still scaled to percentages", () => {
  const primary = normalizeLimit({
    utilization: 0.25,
    window_minutes: 300,
    resets_at: 4102444800
  }, {
    usedKey: "utilization"
  });

  assert.equal(primary.usedPercent, 25);
  assert.equal(primary.remainingPercent, 75);
});

test("CLI entrypoint treats npm bin symlinks as direct execution", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const linkPath = path.join(tmpDir, process.platform === "win32" ? "ai-battery.js" : "ai-battery");
  try {
    fs.symlinkSync(CLI_PATH, linkPath);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("symlink creation is unavailable");
      return;
    }
    throw error;
  }

  assert.equal(sameFilePath(CLI_PATH, linkPath), true);
});

test("managed shell PATH block removal preserves surrounding rc content", () => {
  const rc = [
    "export BEFORE=1",
    "# >>> ai-battery setup >>>",
    "export PATH='/home/me/.local/bin':\"$PATH\"",
    "# <<< ai-battery setup <<<",
    "export AFTER=1",
    ""
  ].join("\n");

  assert.equal(removeAiBatteryShellPathBlock(rc), "export BEFORE=1\nexport AFTER=1\n");
});

test("Codex wrapper falls back to original codex when AI Battery runner is unavailable", () => {
  const script = codexWrapperScript("/tmp/original-codex");

  assert.match(script, /\[ -t 0 \] && \[ -t 1 \] && \[ -x /);
  assert.match(script, /exec '\/tmp\/original-codex' "\$@"/);
});

test("uninstall restores a codex command that setup backed up", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const shimDir = path.join(tmpDir, "shim");
  const originalDir = path.join(tmpDir, "original");
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(originalDir, { recursive: true });

  const shimCodex = path.join(shimDir, "codex");
  const originalCodex = path.join(originalDir, "codex");
  const backupPath = `${shimCodex}.ai-battery-original-link`;
  const originalShimText = "#!/bin/sh\necho custom shim\n";
  fs.writeFileSync(originalCodex, "#!/bin/sh\necho original codex\n", { mode: 0o755 });
  fs.writeFileSync(backupPath, originalShimText, { mode: 0o755 });
  fs.writeFileSync(shimCodex, codexWrapperScript(originalCodex), { mode: 0o755 });
  assert.match(fs.readFileSync(shimCodex, "utf8"), /AI_BATTERY_MANAGED_CODEX_WRAPPER/);

  const result = removeOrRestoreCodexWrapper(shimCodex, {
    codexWrapper: {
      wrapperPath: shimCodex,
      backupPath
    }
  });

  assert.equal(fs.readFileSync(shimCodex, "utf8"), originalShimText);
  assert.equal(result.wrapperPath, shimCodex);
  assert.equal(result.restoredFrom, backupPath);
  assert.equal(fs.existsSync(backupPath), false);
});

test("uninstall does not delete an external managed codex wrapper without a backup", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const externalDir = path.join(tmpDir, "external-bin");
  const originalDir = path.join(tmpDir, "original");
  fs.mkdirSync(externalDir, { recursive: true });
  fs.mkdirSync(originalDir, { recursive: true });

  const externalCodex = path.join(externalDir, "codex");
  const originalCodex = path.join(originalDir, "codex");
  fs.writeFileSync(originalCodex, "#!/bin/sh\necho original codex\n", { mode: 0o755 });
  fs.writeFileSync(externalCodex, codexWrapperScript(originalCodex), { mode: 0o755 });
  const before = fs.readFileSync(externalCodex, "utf8");

  const result = removeOrRestoreCodexWrapper(externalCodex, { codexWrapper: null });

  assert.equal(result.skipped, true);
  assert.equal(fs.readFileSync(externalCodex, "utf8"), before);
});

test("setup refuses to overwrite an unmanaged codex command in the shim directory", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const stateDir = path.join(tmpDir, "state");
  const dataDir = path.join(tmpDir, "data");
  const shimDir = path.join(tmpDir, "shim");
  const originalDir = path.join(tmpDir, "original");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(originalDir, { recursive: true });

  const shimCodex = path.join(shimDir, "codex");
  const originalCodex = path.join(originalDir, "codex");
  const unmanagedText = "#!/bin/sh\necho do not touch\n";
  fs.writeFileSync(shimCodex, unmanagedText, { mode: 0o755 });
  fs.writeFileSync(originalCodex, "#!/bin/sh\necho original codex\n", { mode: 0o755 });

  const result = withEnv({
    HOME: homeDir,
    XDG_STATE_HOME: stateDir,
    XDG_DATA_HOME: dataDir,
    AI_BATTERY_SHIM_DIR: shimDir,
    AI_BATTERY_RC: path.join(tmpDir, "shellrc"),
    PATH: `${shimDir}${path.delimiter}${originalDir}${path.delimiter}${process.env.PATH || ""}`
  }, () => installCodexWrapper({ force: true }));

  assert.equal(result.skipped, true);
  assert.match(result.reason, /Refusing to replace unmanaged codex command/);
  assert.equal(fs.readFileSync(shimCodex, "utf8"), unmanagedText);
});

test("setup prefers empty ~/.local/bin when it is already before codex on PATH", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const stateDir = path.join(tmpDir, "state");
  const dataDir = path.join(tmpDir, "data");
  const localBin = path.join(homeDir, ".local", "bin");
  const originalDir = path.join(tmpDir, "original");
  fs.mkdirSync(localBin, { recursive: true });
  fs.mkdirSync(originalDir, { recursive: true });

  const localCodex = path.join(localBin, "codex");
  const originalCodex = path.join(originalDir, "codex");
  fs.writeFileSync(originalCodex, "#!/bin/sh\necho original codex\n", { mode: 0o755 });

  const result = withEnv({
    HOME: homeDir,
    XDG_STATE_HOME: stateDir,
    XDG_DATA_HOME: dataDir,
    AI_BATTERY_SHIM_DIR: undefined,
    AI_BATTERY_RC: path.join(tmpDir, "shellrc"),
    PATH: `${localBin}${path.delimiter}${originalDir}${path.delimiter}${process.env.PATH || ""}`
  }, () => installCodexWrapper({ force: false }));

  assert.equal(result.ok, true);
  assert.equal(result.wrapperPath, localCodex);
  assert.equal(result.path.changed, false);
  assert.match(result.path.note, /already before the original codex/);
  assert.match(fs.readFileSync(localCodex, "utf8"), /AI_BATTERY_MANAGED_CODEX_WRAPPER/);
});

test("Claude statusLine header places context left at the terminal right edge", () => {
  const line = withEnv({
    AI_BATTERY_COLUMNS: "100",
    AI_BATTERY_HEADER_COLUMN_GUARD: "0",
    AI_BATTERY_COLUMN_GUARD: undefined
  }, () => claudeHeader({
    model: { display_name: "Opus" },
    workspace: { project_dir: "/home/hojin/Projects" },
    context_window: { remaining_percentage: 83 }
  }, {
    style: "plain",
    leftPadding: 1
  }));

  assert.equal(visibleWidth(line), 99);
  assert.equal(line.endsWith("83% context left"), true);
});

test("Claude statusLine header keeps a small clipping guard by default", () => {
  const line = withEnv({
    AI_BATTERY_COLUMNS: "100",
    AI_BATTERY_HEADER_COLUMN_GUARD: undefined,
    AI_BATTERY_COLUMN_GUARD: undefined
  }, () => claudeHeader({
    model: { display_name: "Opus" },
    workspace: { project_dir: "/home/hojin/Projects" },
    context_window: { remaining_percentage: 83 }
  }, {
    style: "plain",
    leftPadding: 1
  }));

  assert.equal(visibleWidth(line), 97);
  assert.equal(line.endsWith("83% context left"), true);
});

test("Claude statusLine from another tool is skipped by default and restored after forced install", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const stateDir = path.join(tmpDir, "state");
  const claudeDir = path.join(homeDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.json");
  const externalStatusLine = {
    type: "command",
    command: "external-statusline",
    padding: 1
  };
  fs.writeFileSync(settingsPath, `${JSON.stringify({ statusLine: externalStatusLine }, null, 2)}\n`);

  withEnv({
    HOME: homeDir,
    XDG_STATE_HOME: stateDir
  }, () => {
    const skipped = installClaudeStatusline({ force: false });
    assert.equal(skipped.skipped, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")).statusLine, externalStatusLine);

    const installed = installClaudeStatusline({ force: true });
    assert.equal(installed.backedUp, true);
    assert.match(JSON.parse(fs.readFileSync(settingsPath, "utf8")).statusLine.command, /capture-claude/);

    const removed = uninstallClaudeStatusline({ strict: false });
    assert.equal(removed.restored, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")).statusLine, externalStatusLine);
  });
});
