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
  commandMatchesProvider,
  codexStatusLineMatches,
  codexWrapperScript,
  installClaudeStatusline,
  installCodexStatusLine,
  installCodexWrapper,
  extractExistingStatusRight,
  installRowPtyHost,
  installTmuxStatus,
  normalizeLimit,
  removeAiBatteryTmuxBlock,
  runningOverrideForProvider,
  tmuxStatusBarActive,
  removeAiBatteryShellPathBlock,
  removeOrRestoreCodexWrapper,
  providerRunningInProcesses,
  sameFilePath,
  visibleWidth,
  uninstallClaudeStatusline,
  uninstallCodexWrapper,
  uninstallTmuxStatus,
  windowsUserPathWithShim
} from "../bin/ai-battery.js";
import {
  conPtyBackspaceMode,
  conPtyRepaintIntervalMs,
  isVsCodeTerminal,
  normalizeConPtyInput,
  outputMayClearDisplay,
  overlayBottomOffset,
  overlayRepaintIntervalMs,
  parseArgs as parseWindowsRunnerArgs,
  quoteWindowsCommandLineArg,
  rowptyConptyMode,
  rowptyExePath,
  rowptySpawnEnv,
  rowptyStatusCommand,
  statusOutputText,
  statusRow,
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

test("active provider supplies running state without a process scan hint", () => {
  assert.equal(runningOverrideForProvider({ activeProvider: "codex" }, "codex"), true);
  const inactive = runningOverrideForProvider({ activeProvider: "codex" }, "claude");
  assert.equal(inactive, process.platform === "win32" ? false : null);
  assert.equal(runningOverrideForProvider({ activeProvider: null }, "codex"), null);
});

test("Windows user PATH update drops stale AI Battery temp shims", { skip: process.platform !== "win32" }, () => {
  const stale = path.join(os.tmpdir(), "ai-battery-stale-for-path-test", "shim");
  const shimDir = path.join(os.tmpdir(), "ai-battery-real-for-path-test", "bin");
  const windowsApps = path.join(os.homedir(), "AppData", "Local", "Microsoft", "WindowsApps");
  fs.rmSync(path.dirname(stale), { recursive: true, force: true });

  const result = windowsUserPathWithShim([stale, windowsApps], shimDir);

  assert.deepEqual(result.parts, [shimDir, windowsApps]);
  assert.equal(result.changed, true);
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

test("Windows ConPTY input passes DEL backspace through by default", () => {
  assert.equal(withEnv({
    AI_BATTERY_CONPTY_BACKSPACE: undefined,
    CLAUDEX_BATTERY_CONPTY_BACKSPACE: undefined
  }, () => conPtyBackspaceMode()), "passthrough");

  assert.equal(withEnv({
    AI_BATTERY_CONPTY_BACKSPACE: undefined,
    CLAUDEX_BATTERY_CONPTY_BACKSPACE: undefined
  }, () => normalizeConPtyInput(Buffer.from("abc\x7f"))), "abc\x7f");
  assert.equal(normalizeConPtyInput(Buffer.from("abc\x7f"), "bs"), "abc\x08");
  assert.equal(normalizeConPtyInput("abc\x7f", "passthrough"), "abc\x7f");
  assert.equal(normalizeConPtyInput("abc\x7f", "del"), "abc\x7f");

  assert.equal(withEnv({
    AI_BATTERY_CONPTY_BACKSPACE: "bs"
  }, () => conPtyBackspaceMode()), "bs");

  assert.equal(withEnv({
    AI_BATTERY_CONPTY_BACKSPACE: "unknown-mode"
  }, () => conPtyBackspaceMode()), "passthrough");
});

test("rowpty status command carries the {MAXWIDTH} token and provider flags", () => {
  const args = parseWindowsRunnerArgs(["--interval", "5", "--provider", "codex", "--", "codex"]);
  const command = rowptyStatusCommand(args, "codex");

  assert.match(command, /--max-width \{MAXWIDTH\}/);
  assert.match(command, /--active-provider codex/);
  assert.match(command, /--provider codex/);
  assert.match(command, /--muted/);
});

test("rowpty command-line quoting doubles backslashes before quotes", () => {
  assert.equal(quoteWindowsCommandLineArg("plain"), "plain");
  assert.equal(quoteWindowsCommandLineArg("C:\\Program Files\\nodejs\\node.exe"), "\"C:\\Program Files\\nodejs\\node.exe\"");
  assert.equal(quoteWindowsCommandLineArg("say \"hi\""), "\"say \\\"hi\\\"\"");
  assert.equal(quoteWindowsCommandLineArg("trail\\"), "trail\\");
  assert.equal(quoteWindowsCommandLineArg("has space\\"), "\"has space\\\\\"");
  assert.equal(quoteWindowsCommandLineArg(""), "\"\"");
});

test("provider process matching ignores status commands and plain arguments", () => {
  assert.equal(commandMatchesProvider("grep codex README.md", "codex"), false);
  assert.equal(commandMatchesProvider("node /opt/ai-battery/bin/ai-battery.js --json --provider codex", "codex"), false);
  assert.equal(commandMatchesProvider("node /opt/ai-battery/bin/ai-battery-run-win.js --provider all -- C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd", "codex"), true);
  assert.equal(commandMatchesProvider("python3 /opt/ai-battery/bin/ai-battery-run --provider all -- /usr/local/bin/codex", "codex"), true);
  assert.equal(commandMatchesProvider("node /usr/local/lib/node_modules/@openai/codex/bin/codex.js", "codex"), true);
  assert.equal(commandMatchesProvider("claude daemon run --bg-spare /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js", "claude"), false);
});

test("provider running state requires a foreground TTY off Windows", () => {
  const commands = [
    { cmdline: "node /usr/local/lib/node_modules/@openai/codex/bin/codex.js", hasTty: false },
    { cmdline: "node /opt/ai-battery/bin/ai-battery.js --json --provider codex", hasTty: true }
  ];

  assert.equal(providerRunningInProcesses("codex", commands, "darwin"), false);
  assert.equal(providerRunningInProcesses("codex", [{ ...commands[0], hasTty: true }], "darwin"), true);
  assert.equal(providerRunningInProcesses("codex", [commands[0]], "win32"), true);
});

test("tmux status block installs, updates in place, and uninstalls cleanly", { skip: process.platform === "win32" ? "POSIX-only" : false }, (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const confPath = path.join(tmpDir, "tmux.conf");
  fs.writeFileSync(confPath, "set -g mouse on\n");

  withEnv({ AI_BATTERY_TMUX_CONF: confPath }, () => {
    const first = installTmuxStatus();
    assert.equal(first.ok, true);
    assert.equal(first.changed, true);
    const text = fs.readFileSync(confPath, "utf8");
    assert.match(text, /set -g mouse on/);
    assert.match(text, /AI_BATTERY_TMUX_STATUS 1/);
    assert.match(text, /status-right "#\(/);
    assert.match(text, /--bar-width 8/);
    assert.match(text, /--tmux/);
    assert.doesNotMatch(text, /--no-color/);
    assert.equal((text.match(/# >>> ai-battery tmux >>>/g) || []).length, 1);

    installTmuxStatus();
    const again = fs.readFileSync(confPath, "utf8");
    assert.equal((again.match(/# >>> ai-battery tmux >>>/g) || []).length, 1);

    const removed = uninstallTmuxStatus();
    assert.equal(removed.changed, true);
    assert.equal(fs.readFileSync(confPath, "utf8"), "set -g mouse on\n");
  });
});

test("tmux install preserves existing status-right and restores on uninstall", { skip: process.platform === "win32" ? "POSIX-only" : false }, (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const confPath = path.join(tmpDir, "tmux.conf");
  fs.writeFileSync(confPath, 'set -g mouse on\nset -g status-right " %H:%M "\n');

  withEnv({ AI_BATTERY_TMUX_CONF: confPath }, () => {
    installTmuxStatus();
    const text = fs.readFileSync(confPath, "utf8");
    // Existing status-right must be preserved with battery appended to the right
    assert.match(text, /status-right " %H:%M ".*#\(/s);
    assert.equal((text.match(/set -g status-right/g) || []).length, 2); // original + our block

    uninstallTmuxStatus();
    // After removal, original line wins again
    const restored = fs.readFileSync(confPath, "utf8");
    assert.equal(restored, 'set -g mouse on\nset -g status-right " %H:%M "\n');
  });
});

test("extractExistingStatusRight parses double and single-quoted values", () => {
  assert.equal(extractExistingStatusRight(""), null);
  assert.equal(extractExistingStatusRight("set -g mouse on\n"), null);
  assert.equal(extractExistingStatusRight('set -g status-right " %H:%M "\n'), " %H:%M ");
  assert.equal(extractExistingStatusRight("set -g status-right ' %H:%M '\n"), " %H:%M ");
  assert.equal(extractExistingStatusRight("set-option -g status-right \" %H:%M \"\n"), " %H:%M ");
  // Last value wins
  assert.equal(extractExistingStatusRight('set -g status-right "first"\nset -g status-right "last"\n'), "last");
  // Our own block is stripped before extraction
  const withBlock = 'set -g status-right "orig"\n\n# >>> ai-battery tmux >>>\nset -g status-right "#(battery)  orig"\n# <<< ai-battery tmux <<<\n';
  assert.equal(extractExistingStatusRight(withBlock), "orig");
});

test("tmux status-bar detection honors env flag and overrides", () => {
  const base = { TMUX: undefined, AI_BATTERY_TMUX: undefined, CLAUDEX_BATTERY_TMUX: undefined, AI_BATTERY_TMUX_STATUS: undefined, CLAUDEX_BATTERY_TMUX_STATUS: undefined };

  assert.equal(withEnv({ ...base }, () => tmuxStatusBarActive()), false);
  // TMUX_STATUS=1 is the explicit opt-in — trusted even without TMUX socket path
  assert.equal(withEnv({ ...base, TMUX: "x", AI_BATTERY_TMUX_STATUS: "1" }, () => tmuxStatusBarActive()), true);
  assert.equal(withEnv({ ...base, AI_BATTERY_TMUX_STATUS: "1" }, () => tmuxStatusBarActive()), true);
  // row override wins over the flag
  assert.equal(withEnv({ ...base, AI_BATTERY_TMUX_STATUS: "1", AI_BATTERY_TMUX: "row" }, () => tmuxStatusBarActive()), false);
  assert.equal(withEnv({ ...base, AI_BATTERY_TMUX: "status" }, () => tmuxStatusBarActive()), true);
});

test("tmux block removal leaves untouched configs unchanged", () => {
  assert.equal(removeAiBatteryTmuxBlock("set -g mouse on\n"), "set -g mouse on\n");
  const withBlock = "set -g mouse on\n\n# >>> ai-battery tmux >>>\nset -g status-right \"x\"\n# <<< ai-battery tmux <<<\n";
  assert.equal(removeAiBatteryTmuxBlock(withBlock), "set -g mouse on\n");
});

test("vendored rowpty source matches the sibling upstream checkout", (t) => {
  const upstream = fileURLToPath(new URL("../../rowpty/src/RowPty.cs", import.meta.url));
  const vendored = fileURLToPath(new URL("../vendor/rowpty/RowPty.cs", import.meta.url));
  if (!fs.existsSync(upstream)) {
    t.skip("upstream rowpty checkout is not present");
    return;
  }

  const stripHeader = (text) => text.split(/\r?\n/).filter((line) => !line.startsWith("// Vendored from") && !line.startsWith("// change it upstream") && !line.startsWith("// \"ai-battery setup\"") && !line.startsWith("// .NET Framework csc.exe")).join("\n").trim();
  assert.equal(
    stripHeader(fs.readFileSync(vendored, "utf8")),
    fs.readFileSync(upstream, "utf8").replace(/\r?\n/g, "\n").trim(),
    "vendor/rowpty/RowPty.cs is out of sync with ../rowpty/src/RowPty.cs — run: npm run sync:rowpty"
  );
});

test("setup compiles rowpty locally from the vendored source", { skip: process.platform !== "win32" }, (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const first = withEnv({ AI_BATTERY_DATA_DIR: tmpDir }, () => installRowPtyHost());
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.compiled, true);
  assert.equal(fs.existsSync(first.exePath), true);
  assert.equal(fs.existsSync(path.join(tmpDir, "bin", "rowpty.src.sha256")), true);
  assert.equal(fs.existsSync(path.join(tmpDir, "bin", "conpty.dll")), true);
  assert.equal(fs.existsSync(path.join(tmpDir, "bin", "OpenConsole.exe")), true);

  const second = withEnv({ AI_BATTERY_DATA_DIR: tmpDir }, () => installRowPtyHost());
  assert.equal(second.ok, true);
  assert.equal(second.compiled, false);
});

test("rowpty executable resolution honors the explicit env override", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const exePath = path.join(tmpDir, "rowpty.exe");
  fs.writeFileSync(exePath, "stub");

  assert.equal(withEnv({ AI_BATTERY_ROWPTY: exePath }, () => rowptyExePath()), exePath);
  assert.equal(withEnv({ AI_BATTERY_ROWPTY: path.join(tmpDir, "missing.exe") }, () => rowptyExePath()), null);
});

test("rowpty spawn defaults to the OS ConPTY provider for faster startup", () => {
  const clean = {
    AI_BATTERY_ROWPTY_CONPTY: undefined,
    CLAUDEX_BATTERY_ROWPTY_CONPTY: undefined,
    ROWPTY_NO_CONPTY_DLL: undefined,
    ROWPTY_CONPTY_DLL: undefined
  };
  assert.equal(withEnv(clean, () => rowptyConptyMode()), "os");
  assert.equal(withEnv(clean, () => rowptySpawnEnv().ROWPTY_NO_CONPTY_DLL), "1");

  assert.equal(withEnv({
    ...clean,
    ROWPTY_CONPTY_DLL: "C:\\custom\\conpty.dll"
  }, () => rowptySpawnEnv().ROWPTY_NO_CONPTY_DLL), undefined);

  const bundled = withEnv({
    ...clean,
    AI_BATTERY_ROWPTY_CONPTY: "bundled",
    ROWPTY_NO_CONPTY_DLL: "1"
  }, () => ({ mode: rowptyConptyMode(), env: rowptySpawnEnv() }));
  assert.equal(bundled.mode, "bundled");
  assert.equal(bundled.env.ROWPTY_NO_CONPTY_DLL, undefined);

  const auto = withEnv({
    ...clean,
    AI_BATTERY_ROWPTY_CONPTY: "auto"
  }, () => ({ mode: rowptyConptyMode(), env: rowptySpawnEnv() }));
  assert.equal(auto.mode, "auto");
  assert.equal(auto.env.ROWPTY_NO_CONPTY_DLL, undefined);
});

test("Windows ConPTY repaint interval and clear-screen detection are bounded", () => {
  assert.equal(withEnv({
    AI_BATTERY_CONPTY_REPAINT_MS: undefined,
    CLAUDEX_BATTERY_CONPTY_REPAINT_MS: undefined
  }, () => conPtyRepaintIntervalMs()), 1000);

  assert.equal(withEnv({
    AI_BATTERY_CONPTY_REPAINT_MS: "50"
  }, () => conPtyRepaintIntervalMs()), 250);

  assert.equal(withEnv({
    AI_BATTERY_CONPTY_REPAINT_MS: "9000"
  }, () => conPtyRepaintIntervalMs()), 5000);

  assert.equal(outputMayClearDisplay("plain output"), false);
  assert.equal(outputMayClearDisplay("\x1b[2J\x1b[H"), true);
  assert.equal(outputMayClearDisplay("\x1b[?1049h"), true);
});

test("Windows overlay repaint interval defaults to quick redraws and is bounded", () => {
  assert.equal(withEnv({
    AI_BATTERY_OVERLAY_REPAINT_MS: undefined,
    CLAUDEX_BATTERY_OVERLAY_REPAINT_MS: undefined
  }, () => overlayRepaintIntervalMs()), 1000);

  assert.equal(withEnv({
    AI_BATTERY_OVERLAY_REPAINT_MS: "50"
  }, () => overlayRepaintIntervalMs()), 250);

  assert.equal(withEnv({
    AI_BATTERY_OVERLAY_REPAINT_MS: "9000"
  }, () => overlayRepaintIntervalMs()), 5000);
});

test("Windows Codex overlay leaves the bottom row for Codex statusline by default", () => {
  assert.equal(withEnv({
    AI_BATTERY_OVERLAY_BOTTOM_OFFSET: undefined,
    CLAUDEX_BATTERY_OVERLAY_BOTTOM_OFFSET: undefined,
    TERM_PROGRAM: undefined,
    VSCODE_INJECTION: undefined
  }, () => overlayBottomOffset("codex")), 1);

  assert.equal(withEnv({
    AI_BATTERY_OVERLAY_BOTTOM_OFFSET: undefined,
    CLAUDEX_BATTERY_OVERLAY_BOTTOM_OFFSET: undefined,
    TERM_PROGRAM: "vscode",
    VSCODE_INJECTION: undefined
  }, () => overlayBottomOffset("codex")), 2);

  assert.equal(withEnv({
    AI_BATTERY_OVERLAY_BOTTOM_OFFSET: undefined,
    CLAUDEX_BATTERY_OVERLAY_BOTTOM_OFFSET: undefined,
    TERM_PROGRAM: "vscode",
    VSCODE_INJECTION: undefined
  }, () => overlayBottomOffset("claude")), 0);

  assert.equal(withEnv({
    AI_BATTERY_OVERLAY_BOTTOM_OFFSET: "0",
    TERM_PROGRAM: "vscode"
  }, () => overlayBottomOffset("codex")), 0);

  assert.equal(withEnv({
    AI_BATTERY_OVERLAY_BOTTOM_OFFSET: "9"
  }, () => overlayBottomOffset("codex")), 5);

  assert.equal(withEnv({
    TERM_PROGRAM: "vscode",
    VSCODE_INJECTION: undefined
  }, () => isVsCodeTerminal()), true);

  assert.equal(statusRow(24, 0), 24);
  assert.equal(statusRow(24, 1), 23);
  assert.equal(statusRow(24, 2), 22);
  assert.equal(statusRow(1, 5), 1);
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

test("Windows HUD PowerShell accepts a quoted executable battery command", { skip: process.platform !== "win32" }, (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const fixturePath = path.join(tmpDir, "battery-json.js");
  fs.writeFileSync(fixturePath, [
    "console.log(JSON.stringify({",
    "  generatedAt: new Date().toISOString(),",
    "  results: [{",
    "    provider: 'codex',",
    "    ok: true,",
    "    percentRemaining: 42,",
    "    primary: {",
    "      windowMinutes: 300,",
    "      resetsAt: new Date(Date.now() + 3600000).toISOString(),",
    "      resetPassed: false",
    "    },",
    "    running: true",
    "  }]",
    "}));",
    ""
  ].join("\n"));

  const command = `"${process.execPath}" "${fixturePath}"`;
  const hudPath = fileURLToPath(new URL("../bin/ai-battery-hud.ps1", import.meta.url));
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    hudPath,
    "-Once",
    "-BatteryCommandBase64",
    Buffer.from(command, "utf8").toString("base64")
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      LOCALAPPDATA: path.join(tmpDir, "localappdata")
    },
    timeout: 10000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Codex\s+\[battery\]/);
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

test("Windows Codex wrapper runs the Windows runner without forcing a layout", { skip: process.platform !== "win32" }, (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const stateDir = path.join(tmpDir, "state");
  const dataDir = path.join(tmpDir, "data");
  const shimDir = path.join(tmpDir, "shim");
  const originalDir = path.join(tmpDir, "original");
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(originalDir, { recursive: true });

  const originalCodex = path.join(originalDir, CODEX_BIN_NAME);
  fs.writeFileSync(originalCodex, [
    "@echo off",
    "echo wrapped:%AI_BATTERY_WRAPPED_CODEX%",
    "echo args:%*",
    ""
  ].join("\r\n"));

  const env = {
    HOME: homeDir,
    XDG_STATE_HOME: stateDir,
    XDG_DATA_HOME: dataDir,
    AI_BATTERY_SHIM_DIR: shimDir,
    AI_BATTERY_SKIP_WINDOWS_PATH_WRITE: "1",
    AI_BATTERY_RC: path.join(tmpDir, "shellrc"),
    PATH: `${originalDir}${path.delimiter}${process.env.PATH || ""}`
  };

  const result = withEnv(env, () => installCodexWrapper({ force: false }));
  assert.equal(result.ok, true);

  const wrapperText = fs.readFileSync(result.wrapperPath, "utf8");
  assert.match(wrapperText, /AI_BATTERY_DISABLE_WINDOWS_CODEX_RUNNER/);
  assert.doesNotMatch(wrapperText, /AI_BATTERY_WIN_LAYOUT/);
  assert.match(wrapperText, /--provider all --left-padding 2 --/);
  assert.doesNotMatch(wrapperText, /--provider codex --left-padding 2 --/);
  assert.equal(wrapperText.includes(`call "${originalCodex}" %*`), true);

  const run = spawnSync("cmd.exe", ["/d", "/s", "/c", "call", result.wrapperPath, "--version"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      AI_BATTERY_DISABLE_WINDOWS_CODEX_RUNNER: ""
    },
    timeout: 5000
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /wrapped:1/);
  assert.match(run.stdout, /args:--version/);

  const disabled = spawnSync("cmd.exe", ["/d", "/s", "/c", "call", result.wrapperPath, "--version"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      AI_BATTERY_DISABLE_WINDOWS_CODEX_RUNNER: "1"
    },
    timeout: 5000
  });

  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /wrapped:\s*(?:\r?\n|$)/);
  assert.match(disabled.stdout, /args:--version/);
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

test("Claude capture reflects running Codex on Windows", { skip: process.platform !== "win32" }, (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const stateDir = path.join(tmpDir, "state");
  const codexHome = path.join(homeDir, ".codex");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  const capturedAt = new Date().toISOString();
  const resetAt = new Date(Date.now() + 3600000).toISOString();
  fs.writeFileSync(path.join(stateDir, "codex-status-scan-cache.json"), `${JSON.stringify({
    version: 2,
    capturedAt,
    value: {
      provider: "codex",
      ok: true,
      timestamp: capturedAt,
      source: path.join(codexHome, "sessions", "codex.jsonl"),
      percentRemaining: 88,
      percentUsed: 12,
      primary: {
        usedPercent: 12,
        remainingPercent: 88,
        windowMinutes: 300,
        resetsAt: resetAt,
        resetPassed: false
      },
      secondary: {
        usedPercent: 22,
        remainingPercent: 78,
        windowMinutes: 10080,
        resetsAt: resetAt,
        resetPassed: false
      }
    }
  })}\n`);
  fs.writeFileSync(path.join(stateDir, "windows-processes-scan-cache.json"), `${JSON.stringify({
    version: 2,
    capturedAt,
    value: [{
      cmdline: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.exe",
      hasTty: true
    }]
  })}\n`);

  const input = {
    session_id: "codex-running-test",
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
    "--left-padding",
    "0"
  ], {
    input: `${JSON.stringify(input)}\n`,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      CODEX_HOME: codexHome,
      AI_BATTERY_STATE_DIR: stateDir
    },
    timeout: 5000
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\x1b\[90mCodex/);
  assert.match(result.stdout.replace(/\x1b\[[0-9;]*m/g, ""), /Codex .*88%/);
});

test("Claude capture falls back to Codex logs when Windows Codex cache is stale", { skip: process.platform !== "win32" }, (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const stateDir = path.join(tmpDir, "state");
  const codexHome = path.join(homeDir, ".codex");
  const sessionDir = path.join(codexHome, "sessions", "2026", "07", "05");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  fs.writeFileSync(path.join(stateDir, "codex-status-scan-cache.json"), `${JSON.stringify({
    version: 2,
    capturedAt: "2000-01-01T00:00:00.000Z",
    value: null
  })}\n`);

  const capturedAt = new Date().toISOString();
  const resetAt = new Date(Date.now() + 3600000).toISOString();
  fs.writeFileSync(path.join(sessionDir, "codex.jsonl"), `${JSON.stringify({
    timestamp: capturedAt,
    payload: {
      rate_limits: {
        plan_type: "pro",
        limit_id: "codex",
        primary: {
          used_percent: 12,
          window_minutes: 300,
          resets_at: resetAt
        },
        secondary: {
          used_percent: 22,
          window_minutes: 10080,
          resets_at: resetAt
        }
      }
    }
  })}\n`);

  const input = {
    session_id: "codex-stale-cache-test",
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
    "--left-padding",
    "0"
  ], {
    input: `${JSON.stringify(input)}\n`,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      CODEX_HOME: codexHome,
      AI_BATTERY_STATE_DIR: stateDir
    },
    timeout: 5000
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.replace(/\x1b\[[0-9;]*m/g, ""), /Codex .*88%/);
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
