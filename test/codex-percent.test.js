import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  bar,
  claudeHeader,
  codexStatusLineMatches,
  codexWrapperScript,
  installClaudeStatusline,
  installCodexStatusLine,
  installCodexWrapper,
  normalizeLimit,
  removeAiBatteryShellPathBlock,
  removeOrRestoreCodexWrapper,
  sameFilePath,
  visibleWidth,
  uninstallClaudeStatusline,
  uninstallCodexWrapper
} from "../bin/ai-battery.js";
import {
  parseArgs as parseWindowsRunnerArgs,
  statusOutputText,
  windowsCommand
} from "../bin/ai-battery-run-win.js";

const CLI_PATH = fileURLToPath(new URL("../bin/ai-battery.js", import.meta.url));
const HUD_SH_PATH = fileURLToPath(new URL("../bin/ai-battery-hud", import.meta.url));
const CODEX_BIN_NAME = process.platform === "win32" ? "codex.cmd" : "codex";

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

test("legacy HUD launcher delegates to the macOS-capable JS entrypoint", { skip: process.platform !== "darwin" }, (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = spawnSync(HUD_SH_PATH, ["--once"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: tmpDir,
      CODEX_HOME: path.join(tmpDir, ".codex"),
      AI_BATTERY_STATE_DIR: path.join(tmpDir, "state")
    },
    timeout: 5000
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /powershell\.exe is required/i);
  assert.doesNotMatch(result.stdout.trim(), /\b(Cx|Cl)\b/);
  assert.match(result.stdout.trim(), /^(AI --|◎|✳)/);
});

test("menu bar image renderer writes an SVG with provider icons", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [CLI_PATH, "--menu-bar-image"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: tmpDir,
      CODEX_HOME: path.join(tmpDir, ".codex"),
      AI_BATTERY_STATE_DIR: path.join(tmpDir, "state")
    },
    timeout: 5000
  });

  assert.equal(result.status, 0, result.stderr);
  const imagePath = result.stdout.trim();
  const svg = fs.readFileSync(imagePath, "utf8");
  assert.match(svg, /^<svg /);
  if (process.platform === "darwin" && fs.existsSync("/Applications/Codex.app/Contents/Resources/app.asar")) {
    assert.match(svg, /<image\b/);
    assert.match(svg, /data:image\/png;base64/);
  } else {
    assert.doesNotMatch(svg, /<image\b/);
    assert.match(svg, /fill="#315CFF"/);
  }
  assert.match(svg, /fill="#D97706"/);
  assert.match(svg, /stroke="#FFFFFF"/);
  assert.match(svg, /fill="#FFFFFF"/);
  assert.doesNotMatch(svg, /fill="#111111"/);
  assert.doesNotMatch(svg, /\b(Cx|Cl)\b/);
});

test("menu detail image renderer writes connected color bars", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const resetAt = Math.floor((Date.now() + (90 * 60 * 1000)) / 1000);
  fs.writeFileSync(path.join(stateDir, "claude-statusline.json"), `${JSON.stringify({
    version: 1,
    provider: "claude",
    sourceType: "statusline",
    capturedAt: new Date().toISOString(),
    rateLimits: {
      fiveHour: {
        used_percentage: 60,
        remaining_percentage: 40,
        resets_at: resetAt,
        window_minutes: 300
      },
      sevenDay: {
        used_percentage: 37,
        remaining_percentage: 63,
        resets_at: resetAt,
        window_minutes: 10080
      }
    }
  })}\n`);

  const result = spawnSync(process.execPath, [CLI_PATH, "--provider", "claude", "--menu-detail-image"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: tmpDir,
      CODEX_HOME: path.join(tmpDir, ".codex"),
      AI_BATTERY_STATE_DIR: stateDir
    },
    timeout: 5000
  });

  assert.equal(result.status, 0, result.stderr);
  const imagePath = result.stdout.trim();
  const svg = fs.readFileSync(imagePath, "utf8");
  assert.match(svg, /^<svg /);
  assert.doesNotMatch(svg, /#1C1C1E/);
  assert.match(svg, /rx="4"/);
  assert.match(svg, /stroke-opacity="0\.14"/);
  assert.match(svg, /<rect x="86" y="22" width="120" height="8"/);
  assert.match(svg, /<text x="14" y="30"/);
  assert.doesNotMatch(svg, /[█░▰▱]/);
  assert.match(svg, /#FF9F0A/);
  assert.match(svg, /5h [0-9:-]+ · 7d 63%/);
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

test("Windows runner launches Node scripts through node instead of spawning them directly", () => {
  const scriptPath = path.join("C:", "Users", "me", "AppData", "Roaming", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  const command = windowsCommand([scriptPath, "--version"]);

  assert.equal(command.file, process.execPath);
  assert.deepEqual(command.args, [scriptPath, "--version"]);
});

test("Windows runner lets wrapper left padding zero override environment padding", () => {
  const args = withEnv({
    AI_BATTERY_LEFT_PADDING: "2"
  }, () => parseWindowsRunnerArgs(["--left-padding", "0", "--", "codex"]));

  assert.equal(args.leftPadding, 0);
});

test("Windows runner preserves leading statusline padding", () => {
  assert.equal(statusOutputText("  Codex 91%\r\n"), "  Codex 91%");
});

test("Windows runner prefers a .cmd sibling over an extensionless npm shim", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const commandPath = path.join(tmpDir, "codex");
  const cmdPath = `${commandPath}.cmd`;
  fs.writeFileSync(commandPath, "#!/bin/sh\necho unix shim\n");
  fs.writeFileSync(cmdPath, "@echo off\r\necho windows shim\r\n");

  const command = windowsCommand([commandPath, "--version"]);

  assert.equal(command.file, "cmd.exe");
  assert.deepEqual(command.args.slice(0, 4), ["/d", "/s", "/c", "call"]);
  assert.match(command.args[4], /codex\.cmd/);
  assert.equal(command.args[5], "--version");
});

test("Windows runner normalizes quoted cmd paths from older wrappers", () => {
  const quotedCodex = "'\\\"C:\\Users\\ghwls\\AppData\\Roaming\\npm\\codex.cmd\\\"'";
  const command = windowsCommand([quotedCodex, "--version"]);

  assert.equal(command.file, "cmd.exe");
  assert.deepEqual(command.args.slice(0, 4), ["/d", "/s", "/c", "call"]);
  assert.equal(command.args[4], "C:\\Users\\ghwls\\AppData\\Roaming\\npm\\codex.cmd");
  assert.doesNotMatch(command.args[4], /'|\\"/);
  assert.equal(command.args[5], "--version");
});

test("Windows runner can execute normalized cmd paths through cmd call", { skip: process.platform !== "win32" }, (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const cmdPath = path.join(tmpDir, "codex.cmd");
  fs.writeFileSync(cmdPath, "@echo off\r\necho ok:%~1\r\n");

  const quotedCodex = `'\\\"${cmdPath}\\\"'`;
  const command = windowsCommand([quotedCodex, "--version"]);
  const result = spawnSync(command.file, command.args, {
    encoding: "utf8",
    windowsHide: true
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "ok:--version");
});

test("uninstall restores a codex command that setup backed up", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const shimDir = path.join(tmpDir, "shim");
  const originalDir = path.join(tmpDir, "original");
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(originalDir, { recursive: true });

  const shimCodex = path.join(shimDir, CODEX_BIN_NAME);
  const originalCodex = path.join(originalDir, CODEX_BIN_NAME);
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

  const shimCodex = path.join(shimDir, CODEX_BIN_NAME);
  const originalCodex = path.join(originalDir, CODEX_BIN_NAME);
  const unmanagedText = "#!/bin/sh\necho do not touch\n";
  fs.writeFileSync(shimCodex, unmanagedText, { mode: 0o755 });
  fs.writeFileSync(originalCodex, "#!/bin/sh\necho original codex\n", { mode: 0o755 });

  const result = withEnv({
    HOME: homeDir,
    XDG_STATE_HOME: stateDir,
    XDG_DATA_HOME: dataDir,
    AI_BATTERY_SHIM_DIR: shimDir,
    AI_BATTERY_SKIP_WINDOWS_PATH_WRITE: "1",
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

  const localCodex = path.join(localBin, CODEX_BIN_NAME);
  const originalCodex = path.join(originalDir, CODEX_BIN_NAME);
  fs.writeFileSync(originalCodex, "#!/bin/sh\necho original codex\n", { mode: 0o755 });

  const result = withEnv({
    HOME: homeDir,
    XDG_STATE_HOME: stateDir,
    XDG_DATA_HOME: dataDir,
    AI_BATTERY_SHIM_DIR: undefined,
    AI_BATTERY_SKIP_WINDOWS_PATH_WRITE: "1",
    AI_BATTERY_RC: path.join(tmpDir, "shellrc"),
    PATH: `${localBin}${path.delimiter}${originalDir}${path.delimiter}${process.env.PATH || ""}`
  }, () => installCodexWrapper({ force: false }));

  assert.equal(result.ok, true);
  assert.equal(result.wrapperPath, localCodex);
  assert.equal(result.path.changed, false);
  assert.match(result.path.note, /already before the original codex/);
  assert.match(fs.readFileSync(localCodex, "utf8"), /AI_BATTERY_MANAGED_CODEX_WRAPPER/);
  if (process.platform === "win32") {
    assert.match(fs.readFileSync(localCodex, "utf8"), /--left-padding 2 --/);
  }
});

test("setup codex configures Codex built-in status_line and uninstall restores it", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const stateDir = path.join(tmpDir, "state");
  const dataDir = path.join(tmpDir, "data");
  const codexHome = path.join(homeDir, ".codex");
  const shimDir = path.join(tmpDir, "shim");
  const originalDir = path.join(tmpDir, "original");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(originalDir, { recursive: true });

  const originalCodex = path.join(originalDir, CODEX_BIN_NAME);
  const originalCodexText = process.platform === "win32"
    ? "@echo off\r\necho original codex\r\n"
    : "#!/bin/sh\necho original codex\n";
  fs.writeFileSync(originalCodex, originalCodexText, { mode: 0o755 });

  const configToml = path.join(codexHome, "config.toml");
  const originalToml = [
    'model = "gpt-5"',
    "",
    "[tui]",
    'status_line = ["model-with-reasoning", "current-dir", "git-branch", "context-remaining"]',
    "status_line_use_colors = true",
    ""
  ].join("\n");
  fs.writeFileSync(configToml, originalToml);

  const env = {
    ...process.env,
    HOME: homeDir,
    CODEX_HOME: codexHome,
    XDG_STATE_HOME: stateDir,
    XDG_DATA_HOME: dataDir,
    AI_BATTERY_SHIM_DIR: shimDir,
    AI_BATTERY_SKIP_WINDOWS_PATH_WRITE: "1",
    AI_BATTERY_RC: path.join(tmpDir, "shellrc"),
    PATH: `${originalDir}${path.delimiter}${process.env.PATH || ""}`
  };

  const setup = spawnSync(process.execPath, [CLI_PATH, "setup", "codex", "--json"], {
    encoding: "utf8",
    env,
    timeout: 5000
  });

  assert.equal(setup.status, 0, setup.stderr);
  const setupJson = JSON.parse(setup.stdout);
  assert.equal(setupJson.codex.statusLine.changed, true);
  const configuredToml = fs.readFileSync(configToml, "utf8");
  assert.equal(codexStatusLineMatches(configuredToml), true);
  assert.doesNotMatch(configuredToml, /context-remaining/);

  const uninstall = spawnSync(process.execPath, [CLI_PATH, "uninstall", "codex", "--json"], {
    encoding: "utf8",
    env,
    timeout: 5000
  });

  assert.equal(uninstall.status, 0, uninstall.stderr);
  const uninstallJson = JSON.parse(uninstall.stdout);
  assert.equal(uninstallJson.results.codex.statusLine.restored, true);
  assert.equal(fs.readFileSync(configToml, "utf8"), originalToml);
});

test("uninstall leaves Codex config untouched after user edits", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const stateDir = path.join(tmpDir, "state");
  const dataDir = path.join(tmpDir, "data");
  const codexHome = path.join(homeDir, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  const configToml = path.join(codexHome, "config.toml");
  fs.writeFileSync(configToml, [
    "[tui]",
    'status_line = ["context-remaining"]',
    ""
  ].join("\n"));

  withEnv({
    HOME: homeDir,
    CODEX_HOME: codexHome,
    XDG_STATE_HOME: stateDir,
    XDG_DATA_HOME: dataDir,
    AI_BATTERY_RC: path.join(tmpDir, "shellrc"),
    PATH: ""
  }, () => {
    const installed = installCodexStatusLine();
    assert.equal(installed.changed, true);
    fs.appendFileSync(configToml, "extra_status_hint = true\n");

    const removed = uninstallCodexWrapper();

    assert.equal(removed.statusLine.skipped, true);
    const currentToml = fs.readFileSync(configToml, "utf8");
    assert.match(currentToml, /extra_status_hint = true/);
    assert.equal(codexStatusLineMatches(currentToml), true);
  });
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

test("Claude capture output aligns the first and second line starts", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const input = {
    session_id: "align-test",
    model: { display_name: "Opus" },
    workspace: { project_dir: tmpDir },
    context_window: { remaining_percentage: 83 },
    terminal: { columns: 100 },
    transcript_path: ""
  };
  const result = spawnSync(process.execPath, [
    CLI_PATH,
    "capture-claude",
    "--muted",
    "--provider",
    "claude",
    "--left-padding",
    "3"
  ], {
    input: `${JSON.stringify(input)}\n`,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: path.join(tmpDir, "home"),
      CODEX_HOME: path.join(tmpDir, ".codex"),
      AI_BATTERY_STATE_DIR: path.join(tmpDir, "state")
    },
    timeout: 5000
  });

  assert.equal(result.status, 0, result.stderr);
  const plainLines = result.stdout
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.equal(plainLines.length, 2);
  assert.deepEqual(plainLines.map((line) => line.match(/^ */)[0].length), [3, 3]);
  assert.match(plainLines[0].slice(3), /^Opus\b/);
  assert.match(plainLines[1].slice(3), /^Claude\b/);
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

test("colored battery bar uses one tall glyph for fill and track so heights match on macOS", () => {
  // Regression: pairing the fill glyph with the light-shade glyph rendered the
  // two halves at different heights under macOS terminal fonts. Both halves
  // must be the SAME glyph and be separated only by ANSI color.
  const glyph = "❚";
  const rendered = withEnv({
    AI_BATTERY_BAR_GLYPH: glyph
  }, () => bar(50, 10, "green", "ansi"));
  const plain = rendered.replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(plain, glyph.repeat(10), "colored bar should be one uniform glyph");
  assert.doesNotMatch(rendered, /[▆▖░▒▓]/, "no lower block or shade glyphs in colored output");
  assert.match(rendered, /\x1b\[32m❚+\x1b\[0m/, "fill segment carries the charge color");
  assert.match(rendered, /\x1b\[90m❚+\x1b\[0m/, "track segment is gray, not the fill color");
});

test("battery bar glyph can be tuned for Windows and WSL terminal fonts", () => {
  const rendered = withEnv({
    AI_BATTERY_BAR_GLYPH: "❚"
  }, () => bar(50, 10, "green", "ansi"));
  const plain = rendered.replace(/\x1b\[[0-9;]*m/g, "");

  assert.equal(plain, "❚".repeat(10));
  assert.match(rendered, /\x1b\[32m❚+\x1b\[0m/);
  assert.match(rendered, /\x1b\[90m❚+\x1b\[0m/);
});

test("plain battery bar keeps distinct glyphs when there is no color", () => {
  const rendered = withEnv({
    AI_BATTERY_BAR_GLYPH: "▮"
  }, () => bar(50, 10, "green", "plain"));

  assert.equal(rendered, "▮▮▮▮▮░░░░░");
});

test("narrow statusline keeps every provider instead of truncating the tail", () => {
  const snapshot = JSON.parse(spawnSync(process.execPath, [CLI_PATH, "--json"], {
    encoding: "utf8",
    timeout: 5000
  }).stdout);
  const providers = snapshot.results.map((entry) => entry.provider);
  // Only meaningful when both providers report on this machine.
  if (!(providers.includes("codex") && providers.includes("claude"))) return;

  const narrow = spawnSync(process.execPath, [
    CLI_PATH,
    "--ansi",
    "--bar-width", "10",
    "--max-width", "40",
    "--provider", "all"
  ], { encoding: "utf8", timeout: 5000 });
  const plain = narrow.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /Codex/, "codex core survives narrow width");
  assert.match(plain, /Claude/, "claude core survives narrow width instead of being cut off");
});
