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
  codexBackgroundReadyInProcesses,
  codexAccountUsageSnapshot,
  codexConfigTomlPath,
  codexRuntimeHome,
  codexStatusLineMatches,
  codexWrapperScript,
  compositorDiagnostic,
  installClaudeStatusline,
  installCodexStatusLine,
  installCodexWrapper,
  extractExistingStatusRight,
  installRowPtyHost,
  installTmuxStatus,
  mergeCodexAccountUsage,
  normalizeLimit,
  parseTtyProcessListOutput,
  removeAiBatteryTmuxBlock,
  runningOverrideForProvider,
  tmuxStatusBarActive,
  removeAiBatteryShellPathBlock,
  removeOrRestoreCodexWrapper,
  providerRunningInProcesses,
  renderHudState,
  renderMenuBarImage,
  renderMenuDetailImage,
  rowptyDiagnostic,
  sameFilePath,
  visibleWidth,
  uninstallClaudeStatusline,
  uninstallCodexWrapper,
  uninstallTmuxStatus,
  windowsOwnedShimDirsForUninstall,
  windowsSetupNeedsRowPty,
  windowsUserPathWithShim
} from "../bin/ai-battery.js";
import {
  codexNoAltScreenEnabled,
  commandArgsLookLikeCodex,
  compositorFrameIntervalMs,
  compositorUsesBundledConpty,
  compositorWindowsPty,
  conPtyBackspaceMode,
  conPtyRepaintIntervalMs,
  isVsCodeTerminal,
  nativeFullscreenHudEnabled,
  normalizeConPtyInput,
  outputMayClearDisplay,
  overlayBottomOffset,
  overlayRepaintIntervalMs,
  parseArgs as parseWindowsRunnerArgs,
  quoteWindowsCommandLineArg,
  resolveNpmCmdShim,
  rowptyConptyMode,
  rowptyExePath,
  rowptyFilterAltScreen,
  rowptyPreserveScrollback,
  rowptySpawnEnv,
  rowptyStatusCommand,
  statusOutputText,
  statusRow,
  withCodexNoAltScreen,
  windowsDockPosition,
  windowsCommand
} from "../bin/ai-battery-run-win.js";
import {
  HeadlessTerminalCompositor,
  HOST_RESTORE_SEQUENCE
} from "../bin/terminal-compositor.js";
import {
  describeWindowsHudOptions,
  macHudCommandMatches,
  macHudPidsFromPsOutput,
  prefetchInitialJson,
  parseWindowsHudArgs,
  windowsHudUsage
} from "../bin/ai-battery-hud.js";

const CLI_PATH = fileURLToPath(new URL("../bin/ai-battery.js", import.meta.url));
const RUNNER_PATH = fileURLToPath(new URL("../bin/ai-battery-run", import.meta.url));
const HUD_SH_PATH = fileURLToPath(new URL("../bin/ai-battery-hud", import.meta.url));
const CODEX_BIN_NAME = process.platform === "win32" ? "codex.cmd" : "codex";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

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

function spawnNode(args, options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-node-"));
  const stdinPath = path.join(tmpDir, "stdin");
  const stdoutPath = path.join(tmpDir, "stdout");
  const stderrPath = path.join(tmpDir, "stderr");
  let stdinWriteFd = null;
  let stdinReadFd = null;
  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");
  try {
    const { input, stdio, ...spawnOptions } = options;
    if (input !== undefined) {
      stdinWriteFd = fs.openSync(stdinPath, "w");
      fs.writeFileSync(stdinWriteFd, input);
      fs.closeSync(stdinWriteFd);
      stdinWriteFd = null;
      stdinReadFd = fs.openSync(stdinPath, "r");
    }
    const result = spawnSync(process.execPath, args, {
      ...spawnOptions,
      stdio: [stdinReadFd ?? "ignore", stdoutFd, stderrFd]
    });
    return {
      ...result,
      stdout: fs.readFileSync(stdoutPath, "utf8"),
      stderr: fs.readFileSync(stderrPath, "utf8")
    };
  } finally {
    if (stdinReadFd !== null) fs.closeSync(stdinReadFd);
    if (stdinWriteFd !== null) fs.closeSync(stdinWriteFd);
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
  assert.equal(inactive, null);
  assert.equal(runningOverrideForProvider({ activeProvider: null }, "codex"), null);
});

test("Windows active provider still scans the other provider", { skip: process.platform !== "win32" }, (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const stateDir = path.join(tmpDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });

  const capturedAt = new Date().toISOString();
  const resetAt = new Date(Date.now() + 3600000).toISOString();
  fs.writeFileSync(path.join(stateDir, "claude-statusline.json"), `${JSON.stringify({
    version: 1,
    provider: "claude",
    sourceType: "statusline",
    capturedAt,
    sessionId: "claude-running-test",
    model: { displayName: "Opus" },
    rateLimits: {
      fiveHour: {
        usedPercent: 20,
        remainingPercent: 80,
        windowMinutes: 300,
        resetsAt: resetAt,
        resetPassed: false
      },
      sevenDay: {
        usedPercent: 30,
        remainingPercent: 70,
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
      cmdline: "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
      hasTty: true,
      source: "windows"
    }]
  })}\n`);

  const result = spawnNode([CLI_PATH, "--provider", "claude", "--active-provider", "codex", "--muted"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      AI_BATTERY_STATE_DIR: stateDir
    },
    timeout: 5000
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\x1b\[97mClaude/);
  assert.match(result.stdout.replace(/\x1b\[[0-9;]*m/g, ""), /Claude .*80%/);
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

test("Windows uninstall removes only PATH entries owned by AI Battery", () => {
  const root = path.join(os.tmpdir(), "ai-battery-path-ownership");
  const dataDir = path.join(root, "data");
  const defaultShim = path.join(dataDir, "bin");
  const sharedShim = path.join(root, "shared-bin");
  const explicitShim = path.join(root, "explicit-bin");

  withEnv({ AI_BATTERY_DATA_DIR: dataDir }, () => {
    assert.deepEqual(windowsOwnedShimDirsForUninstall({
      codexWrapper: { wrapperPath: path.join(defaultShim, CODEX_BIN_NAME) }
    }), [defaultShim]);
    assert.deepEqual(windowsOwnedShimDirsForUninstall({
      codexWrapper: { wrapperPath: path.join(sharedShim, CODEX_BIN_NAME) }
    }), []);
    assert.deepEqual(windowsOwnedShimDirsForUninstall({
      codexWrapper: {
        wrapperPath: path.join(sharedShim, CODEX_BIN_NAME),
        pathAddedByAiBattery: explicitShim
      }
    }), [explicitShim]);
  });
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

test("POSIX runner flushes quick child output before exit", { skip: process.platform !== "linux" }, (t) => {
  const probe = spawnSync("script", ["--version"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") {
    t.skip("script(1) is unavailable");
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const childPath = path.join(tmpDir, "quick-child.js");
  fs.writeFileSync(childPath, "process.stdout.write('pty-ok\\n');\n");

  const command = [
    shellQuote(RUNNER_PATH),
    "--provider", "all",
    "--layout", "reserve",
    "--",
    shellQuote(process.execPath),
    shellQuote(childPath)
  ].join(" ");
  const result = spawnSync("script", ["-q", "-e", "-c", command, "/dev/null"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: path.join(tmpDir, "home"),
      CODEX_HOME: path.join(tmpDir, "home", ".codex"),
      AI_BATTERY_STATE_DIR: path.join(tmpDir, "state")
    },
    timeout: 5000
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""), /pty-ok/);
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

test("macOS HUD process matching survives install path changes", () => {
  const oldInstall = "osascript /usr/local/lib/node_modules/ai-battery/bin/ai-battery-macos-status.applescript HOME='/Users/me' '/usr/local/bin/node' '/usr/local/lib/node_modules/ai-battery/bin/ai-battery.js' --menu-bar-image 2>/dev/null HOME='/Users/me' '/usr/local/bin/node' '/usr/local/lib/node_modules/ai-battery/bin/ai-battery.js' --menu-detail-image 2>/dev/null HOME='/Users/me' '/usr/local/bin/node' '/usr/local/lib/node_modules/ai-battery/bin/ai-battery.js' --no-color 2>/dev/null 10";
  const newInstall = "osascript /Users/me/Projects/ai-battery/bin/ai-battery-macos-status.applescript HOME='/Users/me' '/usr/local/bin/node' '/Users/me/Projects/ai-battery/bin/ai-battery.js' --menu-bar-image 2>/dev/null HOME='/Users/me' '/usr/local/bin/node' '/Users/me/Projects/ai-battery/bin/ai-battery.js' --menu-detail-image 2>/dev/null HOME='/Users/me' '/usr/local/bin/node' '/Users/me/Projects/ai-battery/bin/ai-battery.js' --no-color 2>/dev/null 10";
  const similarButNotHud = "/bin/zsh -c rg ai-battery-macos-status.applescript";

  assert.equal(macHudCommandMatches(oldInstall), true);
  assert.equal(macHudCommandMatches(newInstall), true);
  assert.equal(macHudCommandMatches(similarButNotHud), false);
  assert.deepEqual(macHudPidsFromPsOutput([
    ` 101 ${oldInstall}`,
    ` 202 ${newInstall}`,
    ` 303 ${similarButNotHud}`,
    ` 404 ${oldInstall}`
  ].join("\n"), 404), [101, 202]);
});

test("Windows HUD friendly aliases translate to PowerShell options", () => {
  assert.deepEqual(parseWindowsHudArgs(["--dark", "white", "--no-backdrop", "--solid"]).filteredArgs, [
    "-Backdrop",
    "off",
    "-Text",
    "light",
    "-Transparent",
    "solid"
  ]);

  assert.deepEqual(parseWindowsHudArgs(["light", "black"]).filteredArgs, [
    "-Text",
    "dark"
  ]);

  assert.deepEqual(parseWindowsHudArgs(["--backdrop"]).filteredArgs, [
    "-Backdrop",
    "on",
    "-Text",
    "light"
  ]);

  const autostart = parseWindowsHudArgs(["autostart", "on", "light", "black", "--backdrop"]);
  assert.equal(autostart.subcommand, "autostart");
  assert.equal(autostart.autostartAction, "on");
  assert.deepEqual(autostart.filteredArgs, [
    "-Backdrop",
    "on",
    "-Text",
    "dark"
  ]);

  assert.deepEqual(parseWindowsHudArgs(["-Mode", "tray"]).filteredArgs, ["-Mode", "tray"]);
  assert.throws(() => parseWindowsHudArgs(["wat"]), /unknown HUD option: wat/);
  assert.match(windowsHudUsage(), /ai-battery hud light\s+light taskbar -> black text/);
  assert.match(windowsHudUsage(), /ai-battery hud black\s+black text/);
  assert.equal(describeWindowsHudOptions(parseWindowsHudArgs(["black"]).filteredArgs), "black text");
  assert.equal(describeWindowsHudOptions(parseWindowsHudArgs(["--backdrop"]).filteredArgs), "backdrop on, white text");
});

test("Windows HUD prefetch can run the local battery CLI without a scoped-path ReferenceError", { skip: process.platform !== "win32" }, (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = withEnv({
    HOME: path.join(tmpDir, "home"),
    AI_BATTERY_STATE_DIR: path.join(tmpDir, "state")
  }, () => prefetchInitialJson("", false, CLI_PATH));

  assert.equal(typeof result, "string");
  assert.doesNotThrow(() => JSON.parse(result));
});

test("menu bar image renderer writes an SVG with provider icons", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const result = spawnNode([CLI_PATH, "--active-provider", "codex", "--menu-bar-image"], {
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

  const result = spawnNode([CLI_PATH, "--provider", "claude", "--active-provider", "claude", "--menu-detail-image"], {
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

test("Claude capture keeps pane rate limits on the canonical account snapshot", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const resetAt = Math.floor((Date.now() + (90 * 60 * 1000)) / 1000);
  fs.writeFileSync(path.join(stateDir, "claude-statusline.json"), `${JSON.stringify({
    version: 1,
    provider: "claude",
    sourceType: "statusline",
    capturedAt: new Date(Date.now() - 1000).toISOString(),
    sessionId: "pane-a",
    rateLimits: {
      fiveHour: {
        used_percentage: 70,
        resets_at: resetAt,
        window_minutes: 300
      },
      sevenDay: {
        used_percentage: 42,
        resets_at: resetAt,
        window_minutes: 10080
      }
    }
  })}\n`);

  const input = {
    session_id: "pane-b",
    model: { display_name: "Sonnet" },
    terminal: { columns: 100 },
    context_window: { remaining_percentage: 83 },
    rate_limits: {
      five_hour: {
        used_percentage: 20,
        resets_at: resetAt,
        window_minutes: 300
      },
      seven_day: {
        used_percentage: 10,
        resets_at: resetAt,
        window_minutes: 10080
      }
    }
  };
  const result = spawnNode([
    CLI_PATH,
    "capture-claude",
    "--provider", "claude",
    "--no-header",
    "--muted"
  ], {
    input: `${JSON.stringify(input)}\n`,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: tmpDir,
      AI_BATTERY_STATE_DIR: stateDir
    },
    timeout: 5000
  });

  assert.equal(result.status, 0, result.stderr);
  const plain = result.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /Claude\b.*30%/);
  assert.doesNotMatch(plain, /Claude\b.*80%/);

  const sessionCache = JSON.parse(fs.readFileSync(path.join(stateDir, "claude-statusline-sessions", "pane-b.json"), "utf8"));
  assert.equal(sessionCache.rateLimits.fiveHour.used_percentage, 70);
  assert.equal(sessionCache.rateLimits.sevenDay.used_percentage, 42);
});

test("Claude status cache reads the canonical global snapshot before newer pane caches", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, "state");
  const sessionsDir = path.join(stateDir, "claude-statusline-sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const resetAt = Math.floor((Date.now() + (90 * 60 * 1000)) / 1000);
  const baseSnapshot = {
    version: 1,
    provider: "claude",
    sourceType: "statusline",
    rateLimits: {
      fiveHour: {
        resets_at: resetAt,
        window_minutes: 300
      },
      sevenDay: {
        resets_at: resetAt,
        window_minutes: 10080
      }
    }
  };
  fs.writeFileSync(path.join(stateDir, "claude-statusline.json"), `${JSON.stringify({
    ...baseSnapshot,
    capturedAt: new Date(Date.now() - 5000).toISOString(),
    sessionId: "global",
    rateLimits: {
      fiveHour: { ...baseSnapshot.rateLimits.fiveHour, used_percentage: 70 },
      sevenDay: { ...baseSnapshot.rateLimits.sevenDay, used_percentage: 42 }
    }
  })}\n`);
  fs.writeFileSync(path.join(sessionsDir, "newer-pane.json"), `${JSON.stringify({
    ...baseSnapshot,
    capturedAt: new Date().toISOString(),
    sessionId: "newer-pane",
    rateLimits: {
      fiveHour: { ...baseSnapshot.rateLimits.fiveHour, used_percentage: 20 },
      sevenDay: { ...baseSnapshot.rateLimits.sevenDay, used_percentage: 10 }
    }
  })}\n`);

  const result = spawnNode([CLI_PATH, "--provider", "claude", "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: tmpDir,
      AI_BATTERY_STATE_DIR: stateDir
    },
    timeout: 5000
  });

  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  const claude = snapshot.results.find((entry) => entry.provider === "claude");
  assert.equal(claude.percentRemaining, 30);
  assert.equal(claude.primary.usedPercent, 70);
  assert.equal(path.basename(claude.source), "claude-statusline.json");
});

test("macOS menu images dim inactive providers without activity badges", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, "state");
  const resetsAt = new Date(Date.now() + (90 * 60 * 1000)).toISOString();
  const snapshot = {
    generatedAt: new Date().toISOString(),
    results: [
      {
        provider: "codex",
        ok: true,
        running: true,
        percentRemaining: 82,
        primary: { windowMinutes: 300, resetsAt, resetPassed: false },
        secondary: { windowMinutes: 10080, remainingPercent: 67, resetsAt, resetPassed: false }
      },
      {
        provider: "claude",
        ok: true,
        running: false,
        percentRemaining: 35,
        primary: { windowMinutes: 300, resetsAt, resetPassed: false },
        secondary: { windowMinutes: 10080, remainingPercent: 51, resetsAt, resetPassed: false }
      }
    ]
  };

  withEnv({
    HOME: tmpDir,
    AI_BATTERY_STATE_DIR: stateDir
  }, () => {
    const menuBarSvg = fs.readFileSync(renderMenuBarImage(snapshot), "utf8");
    const detailSvg = fs.readFileSync(renderMenuDetailImage(snapshot), "utf8");

    assert.doesNotMatch(menuBarSvg, /data-activity=/);
    assert.doesNotMatch(detailSvg, />Running<|>Idle</);
    assert.match(menuBarSvg, /fill="#30D158"/);
    assert.match(menuBarSvg, /<text x="91" y="21"[^>]+fill="#A1A1AA">35%<\/text>/);
    assert.doesNotMatch(menuBarSvg, /#FF9F0A/);
    assert.match(detailSvg, /<text x="14" y="30"[^>]+fill="#F5F5F7">Codex<\/text>/);
    assert.match(detailSvg, /<text x="14" y="66"[^>]+fill="#A1A1AA">Claude<\/text>/);
    assert.match(detailSvg, /<rect x="86" y="58" width="42" height="8" rx="4" fill="#A1A1AA"\/>/);
  });
});

test("Codex App session metadata marks usage updates as background", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const stateDir = path.join(tmpDir, "state");
  const codexHome = path.join(homeDir, ".codex");
  const sessionDir = path.join(codexHome, "sessions", "2026", "07", "06");
  fs.mkdirSync(sessionDir, { recursive: true });

  const capturedAt = new Date().toISOString();
  const resetAt = new Date(Date.now() + 3600000).toISOString();
  fs.writeFileSync(path.join(sessionDir, "codex-app.jsonl"), [
    JSON.stringify({
      type: "session_meta",
      payload: {
        originator: "Codex Desktop",
        source: "vscode",
        cwd: tmpDir
      }
    }),
    JSON.stringify({
      timestamp: capturedAt,
      payload: {
        rate_limits: {
          plan_type: "pro",
          limit_id: "codex",
          primary: {
            used_percent: 14,
            window_minutes: 300,
            resets_at: resetAt
          },
          secondary: {
            used_percent: 31,
            window_minutes: 10080,
            resets_at: resetAt
          }
        }
      }
    }),
    ""
  ].join("\n"));

  const result = spawnNode([CLI_PATH, "--provider", "codex", "--json"], {
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
  const snapshot = JSON.parse(result.stdout);
  const codex = snapshot.results[0];
  assert.equal(codex.provider, "codex");
  assert.equal(codex.usageUpdate.timestamp, capturedAt);
  assert.equal(codex.usageUpdate.background, true);
});

test("shared Codex usage contains no session data and preserves local runtime mode", () => {
  const local = {
    provider: "codex",
    ok: true,
    timestamp: "2026-07-13T01:00:00.000Z",
    source: "/home/local/.codex/sessions/local.jsonl",
    roots: ["/home/local/.codex"],
    percentRemaining: 30,
    percentUsed: 70,
    primary: { usedPercent: 70, remainingPercent: 30, windowMinutes: 300, resetsAt: 1234 },
    secondary: { usedPercent: 40, remainingPercent: 60, windowMinutes: 10080, resetsAt: 5678 },
    approvalPolicy: "on-request",
    sandboxMode: "read-only",
    collaborationMode: "plan",
    mode: "plan"
  };
  const remoteScan = {
    provider: "codex",
    ok: true,
    timestamp: "2026-07-13T02:00:00.000Z",
    source: "C:\\Users\\other\\.codex\\sessions\\remote.jsonl",
    roots: ["C:\\Users\\other\\.codex"],
    cwd: "C:\\private-workspace",
    percentRemaining: 80,
    percentUsed: 20,
    primary: { usedPercent: 20, remainingPercent: 80, windowMinutes: 300, resetsAt: 9000, extra: "private" },
    secondary: { usedPercent: 10, remainingPercent: 90, windowMinutes: 10080, resetsAt: 10000 },
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
    collaborationMode: "default",
    mode: "full access"
  };

  const shared = codexAccountUsageSnapshot(remoteScan);
  assert.deepEqual(Object.keys(shared).sort(), [
    "limitId", "percentRemaining", "percentUsed", "planType", "primary", "reachedType", "secondary", "timestamp"
  ]);
  assert.equal(shared.source, undefined);
  assert.equal(shared.roots, undefined);
  assert.equal(shared.cwd, undefined);
  assert.equal(shared.approvalPolicy, undefined);
  assert.equal(shared.primary.extra, undefined);

  const merged = mergeCodexAccountUsage(local, shared);
  assert.equal(merged.percentRemaining, 80);
  assert.equal(merged.source, local.source);
  assert.deepEqual(merged.roots, local.roots);
  assert.equal(merged.approvalPolicy, "on-request");
  assert.equal(merged.sandboxMode, "read-only");
  assert.equal(merged.collaborationMode, "plan");
  assert.equal(merged.mode, "plan");
  assert.equal(merged.sharedUsage, true);
});

test("Windows and WSL style Codex homes share usage without sharing resume sessions", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-codex-share-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const sharedState = path.join(tmpDir, "shared-usage");
  const homeA = path.join(tmpDir, "windows-codex-home");
  const homeB = path.join(tmpDir, "wsl-codex-home");
  const stateA = path.join(tmpDir, "windows-state");
  const stateB = path.join(tmpDir, "wsl-state");

  const writeSession = (codexHome, name, timestamp, usedPercent, sandboxType) => {
    const sessions = path.join(codexHome, "sessions", "2026", "07", "13");
    fs.mkdirSync(sessions, { recursive: true });
    const sessionPath = path.join(sessions, `${name}.jsonl`);
    fs.writeFileSync(sessionPath, [
      JSON.stringify({
        timestamp,
        type: "turn_context",
        payload: { approval_policy: "on-request", sandbox_policy: { type: sandboxType } }
      }),
      JSON.stringify({
        timestamp,
        payload: {
          rate_limits: {
            plan_type: "pro",
            limit_id: "codex",
            primary: { used_percent: usedPercent, window_minutes: 300, resets_at: 2000000000 },
            secondary: { used_percent: 12, window_minutes: 10080, resets_at: 2000604800 }
          }
        }
      }),
      ""
    ].join("\n"));
    return { sessionPath, text: fs.readFileSync(sessionPath, "utf8") };
  };

  const sessionA = writeSession(homeA, "windows", "2026-07-13T02:00:00.000Z", 20, "danger-full-access");
  const sessionB = writeSession(homeB, "wsl", "2026-07-13T01:00:00.000Z", 70, "read-only");
  const run = (codexHome, localState) => spawnNode([CLI_PATH, "--provider", "codex", "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      AI_BATTERY_STATE_DIR: localState,
      AI_BATTERY_SHARED_USAGE_STATE_DIR: sharedState,
      AI_BATTERY_SCAN_CACHE_SECONDS: "0"
    },
    timeout: 5000
  });

  const first = run(homeA, stateA);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).results[0].percentRemaining, 80);
  const second = run(homeB, stateB);
  assert.equal(second.status, 0, second.stderr);
  const reflected = JSON.parse(second.stdout).results[0];
  assert.equal(reflected.percentRemaining, 80);
  assert.equal(reflected.sharedUsage, true);
  assert.equal(reflected.sandboxMode, "read-only");
  assert.equal(reflected.source, sessionB.sessionPath);

  assert.equal(fs.readFileSync(sessionA.sessionPath, "utf8"), sessionA.text);
  assert.equal(fs.readFileSync(sessionB.sessionPath, "utf8"), sessionB.text);
  assert.equal(fs.existsSync(path.join(homeA, "sessions", "2026", "07", "13", "wsl.jsonl")), false);
  assert.equal(fs.existsSync(path.join(homeB, "sessions", "2026", "07", "13", "windows.jsonl")), false);
  const sharedText = fs.readFileSync(path.join(sharedState, "codex-account-usage.json"), "utf8");
  assert.doesNotMatch(sharedText, /sessions|workspace|approval|sandbox|source|roots|cwd/i);
});

test("CODEX_HOME is one literal runtime home, including commas", () => {
  const literalHome = path.join(os.tmpdir(), "codex,personal");
  withEnv({ CODEX_HOME: literalHome }, () => {
    assert.equal(codexRuntimeHome(), literalHome);
    assert.equal(codexConfigTomlPath(), path.join(literalHome, "config.toml"));
  });
});

test("macOS menu detail shows reflected usage while Codex is locally idle", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, "state");
  const resetsAt = new Date(Date.now() + (90 * 60 * 1000)).toISOString();
  const snapshot = {
    generatedAt: new Date().toISOString(),
    results: [
      {
        provider: "codex",
        ok: true,
        running: false,
        timestamp: new Date().toISOString(),
        usageUpdate: {
          timestamp: new Date().toISOString(),
          background: true
        },
        percentRemaining: 74,
        primary: { windowMinutes: 300, resetsAt, resetPassed: false },
        secondary: { windowMinutes: 10080, remainingPercent: 68, resetsAt, resetPassed: false }
      }
    ]
  };

  withEnv({
    HOME: tmpDir,
    AI_BATTERY_STATE_DIR: stateDir
  }, () => {
    const detailSvg = fs.readFileSync(renderMenuDetailImage(snapshot), "utf8");

    assert.match(detailSvg, /height="62"/);
    assert.match(detailSvg, /<text x="14" y="27"[^>]+fill="#A1A1AA">Codex<\/text>/);
    assert.match(detailSvg, /<rect x="86" y="19" width="89" height="8" rx="4" fill="#A1A1AA"\/>/);
    assert.match(detailSvg, /local idle · background running · updated [0-9]+s ago/);
    assert.doesNotMatch(detailSvg, />Running<|>Idle</);
  });
});

test("macOS menu detail hides reflected usage note while Codex is locally running", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, "state");
  const resetsAt = new Date(Date.now() + (90 * 60 * 1000)).toISOString();
  const snapshot = {
    generatedAt: new Date().toISOString(),
    results: [
      {
        provider: "codex",
        ok: true,
        running: true,
        usageUpdate: {
          timestamp: new Date().toISOString(),
          background: true
        },
        percentRemaining: 74,
        primary: { windowMinutes: 300, resetsAt, resetPassed: false },
        secondary: { windowMinutes: 10080, remainingPercent: 68, resetsAt, resetPassed: false }
      }
    ]
  };

  withEnv({
    HOME: tmpDir,
    AI_BATTERY_STATE_DIR: stateDir
  }, () => {
    const detailSvg = fs.readFileSync(renderMenuDetailImage(snapshot), "utf8");

    assert.match(detailSvg, /<text x="14" y="30"[^>]+fill="#F5F5F7">Codex<\/text>/);
    assert.match(detailSvg, /<rect x="86" y="22" width="89" height="8" rx="4" fill="#30D158"\/>/);
    assert.doesNotMatch(detailSvg, /usage reflected/);
    assert.doesNotMatch(detailSvg, />Running<|>Idle</);
  });
});

test("macOS menu detail does not call local CLI usage background", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, "state");
  const resetsAt = new Date(Date.now() + (90 * 60 * 1000)).toISOString();
  const snapshot = {
    generatedAt: new Date().toISOString(),
    results: [
      {
        provider: "codex",
        ok: true,
        running: false,
        usageUpdate: {
          timestamp: new Date().toISOString(),
          background: false
        },
        percentRemaining: 74,
        primary: { windowMinutes: 300, resetsAt, resetPassed: false },
        secondary: { windowMinutes: 10080, remainingPercent: 68, resetsAt, resetPassed: false }
      }
    ]
  };

  withEnv({
    HOME: tmpDir,
    AI_BATTERY_STATE_DIR: stateDir
  }, () => {
    const detailSvg = fs.readFileSync(renderMenuDetailImage(snapshot), "utf8");

    assert.match(detailSvg, /height="52"/);
    assert.doesNotMatch(detailSvg, /background running/);
    assert.doesNotMatch(detailSvg, />Running<|>Idle</);
  });
});

test("macOS menu detail shows background ready while Codex is locally idle", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, "state");
  const resetsAt = new Date(Date.now() + (90 * 60 * 1000)).toISOString();
  const snapshot = {
    generatedAt: new Date().toISOString(),
    results: [
      {
        provider: "codex",
        ok: true,
        running: false,
        backgroundReady: true,
        usageUpdate: {
          timestamp: new Date().toISOString(),
          background: false
        },
        percentRemaining: 74,
        primary: { windowMinutes: 300, resetsAt, resetPassed: false },
        secondary: { windowMinutes: 10080, remainingPercent: 68, resetsAt, resetPassed: false }
      }
    ]
  };

  withEnv({
    HOME: tmpDir,
    AI_BATTERY_STATE_DIR: stateDir
  }, () => {
    const detailSvg = fs.readFileSync(renderMenuDetailImage(snapshot), "utf8");

    assert.match(detailSvg, /height="62"/);
    assert.match(detailSvg, /local idle · background ready/);
    assert.doesNotMatch(detailSvg, /background running/);
    assert.doesNotMatch(detailSvg, />Running<|>Idle</);
  });
});

test("HUD state prioritizes foreground, recent background usage, and background ready", () => {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - (10 * 60 * 1000)).toISOString();

  assert.equal(renderHudState({ results: [{ provider: "codex", running: true }] }), "foreground-running");
  assert.equal(renderHudState({
    results: [{
      provider: "codex",
      running: false,
      usageUpdate: { timestamp: now, background: true }
    }]
  }), "background-running");
  assert.equal(renderHudState({
    results: [{
      provider: "codex",
      running: false,
      backgroundReady: true,
      usageUpdate: { timestamp: old, background: true }
    }]
  }), "background-ready");
  assert.equal(renderHudState({
    results: [{
      provider: "codex",
      running: false,
      usageUpdate: { timestamp: now, background: false }
    }]
  }), "idle");
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
  assert.equal(commandMatchesProvider("/Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://", "codex"), false);
  assert.equal(commandMatchesProvider("node /usr/local/lib/node_modules/@openai/codex/bin/codex.js app-server --listen stdio://", "codex"), false);
  assert.equal(commandMatchesProvider("claude daemon run --bg-spare /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js", "claude"), false);
  assert.equal(codexBackgroundReadyInProcesses([
    { cmdline: "/Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://" }
  ]), true);
  assert.equal(codexBackgroundReadyInProcesses([
    { cmdline: "node /usr/local/lib/node_modules/@openai/codex/bin/codex.js" }
  ]), false);
});

test("provider running state requires a foreground TTY off Windows", () => {
  const commands = [
    { cmdline: "node /usr/local/lib/node_modules/@openai/codex/bin/codex.js", hasTty: false },
    { cmdline: "node /opt/ai-battery/bin/ai-battery.js --json --provider codex", hasTty: true }
  ];

  assert.equal(providerRunningInProcesses("codex", commands, "darwin"), false);
  assert.equal(providerRunningInProcesses("codex", [{ ...commands[0], hasTty: true }], "darwin"), true);
  assert.equal(providerRunningInProcesses("codex", [
    { cmdline: "/Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://", hasTty: true }
  ], "darwin"), false);
  assert.equal(providerRunningInProcesses("codex", [commands[0]], "win32"), true);
});

test("provider running state accepts Windows and WSL process rows", () => {
  const wslRows = parseTtyProcessListOutput([
    "pts/1 node /usr/local/lib/node_modules/@openai/codex/bin/codex.js",
    "?? node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"
  ].join("\n"), "wsl");

  assert.deepEqual(wslRows, [
    { cmdline: "node /usr/local/lib/node_modules/@openai/codex/bin/codex.js", hasTty: true, source: "wsl" },
    { cmdline: "node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js", hasTty: false, source: "wsl" }
  ]);
  assert.equal(providerRunningInProcesses("codex", wslRows, "win32"), true);
  assert.equal(providerRunningInProcesses("claude", wslRows, "win32"), false);
  assert.equal(providerRunningInProcesses("claude", [
    { cmdline: "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd", hasTty: true, source: "windows" }
  ], "linux"), true);
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

test("Codex doctor rowpty diagnostic reports bundled ConPTY request without ReferenceError", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const exePath = path.join(tmpDir, "rowpty.exe");
  fs.writeFileSync(exePath, "stub");

  assert.equal(rowptyDiagnostic(exePath, "linux"), null);
  assert.deepEqual(withEnv({
    AI_BATTERY_ROWPTY_CONPTY: undefined,
    CLAUDEX_BATTERY_ROWPTY_CONPTY: undefined
  }, () => rowptyDiagnostic(exePath, "win32")), {
    path: exePath,
    installed: true,
    bundledConpty: false,
    bundledConptyRequested: true
  });

  fs.writeFileSync(path.join(tmpDir, "conpty.dll"), "stub");
  assert.deepEqual(withEnv({
    AI_BATTERY_ROWPTY_CONPTY: "bundled"
  }, () => rowptyDiagnostic(exePath, "win32")), {
    path: exePath,
    installed: true,
    bundledConpty: true,
    bundledConptyRequested: true
  });
});

test("Windows runner defaults to native fullscreen layout", () => {
  const clean = {
    AI_BATTERY_WIN_LAYOUT: undefined,
    CLAUDEX_BATTERY_WIN_LAYOUT: undefined,
    AI_BATTERY_LAYOUT: undefined,
    AI_BATTERY_CODEX_NO_ALT_SCREEN: undefined,
    CLAUDEX_BATTERY_CODEX_NO_ALT_SCREEN: undefined
  };
  assert.equal(withEnv(clean, () => parseWindowsRunnerArgs(["--", "codex"]).layout), "fullscreen");
  assert.equal(withEnv({ ...clean, AI_BATTERY_WIN_LAYOUT: "fullscreen" }, () => parseWindowsRunnerArgs(["--", "codex"]).layout), "fullscreen");
  assert.equal(withEnv({ ...clean, AI_BATTERY_WIN_LAYOUT: "composite" }, () => parseWindowsRunnerArgs(["--", "codex"]).layout), "composite");
  assert.equal(withEnv({ ...clean, AI_BATTERY_WIN_LAYOUT: "inline" }, () => parseWindowsRunnerArgs(["--", "codex"]).layout), "inline");
  assert.equal(withEnv({ ...clean, AI_BATTERY_WIN_LAYOUT: "tui" }, () => parseWindowsRunnerArgs(["--", "codex"]).layout), "tui");
  assert.equal(withEnv({ ...clean, AI_BATTERY_WIN_LAYOUT: "auto" }, () => parseWindowsRunnerArgs(["--", "codex"]).layout), "auto");
  assert.equal(withEnv({ ...clean, AI_BATTERY_WIN_LAYOUT: "hud" }, () => parseWindowsRunnerArgs(["--", "codex"]).layout), "hud");
  assert.equal(withEnv({ ...clean, AI_BATTERY_WIN_LAYOUT: "bogus" }, () => parseWindowsRunnerArgs(["--", "codex"]).layout), "fullscreen");
  assert.equal(withEnv(clean, () => parseWindowsRunnerArgs(["--layout", "fullscreen", "--", "codex"]).layout), "fullscreen");
  assert.equal(withEnv(clean, () => parseWindowsRunnerArgs(["--layout", "inline", "--", "codex"]).layout), "inline");
  assert.equal(withEnv(clean, () => parseWindowsRunnerArgs(["--layout", "tui", "--", "codex"]).layout), "tui");
  assert.equal(withEnv(clean, () => parseWindowsRunnerArgs(["--layout", "hud", "--", "codex"]).layout), "hud");
  assert.equal(withEnv(clean, () => parseWindowsRunnerArgs(["--layout", "plain", "--", "codex"]).layout), "plain");
});

test("fullscreen compositor settings prefer the bundled ConPTY transport", () => {
  const clean = {
    AI_BATTERY_COMPOSITOR_FRAME_MS: undefined,
    CLAUDEX_BATTERY_COMPOSITOR_FRAME_MS: undefined,
    AI_BATTERY_ROWPTY_CONPTY: undefined,
    CLAUDEX_BATTERY_ROWPTY_CONPTY: undefined
  };
  assert.equal(withEnv(clean, () => compositorFrameIntervalMs()), 16);
  assert.equal(withEnv({ ...clean, AI_BATTERY_COMPOSITOR_FRAME_MS: "999" }, () => compositorFrameIntervalMs()), 250);
  assert.equal(withEnv(clean, () => compositorUsesBundledConpty()), true);
  assert.equal(withEnv({ ...clean, AI_BATTERY_ROWPTY_CONPTY: "os" }, () => compositorUsesBundledConpty()), false);
  assert.deepEqual(withEnv(clean, () => compositorWindowsPty("10.0.26200")), {
    backend: "conpty",
    buildNumber: 21376
  });
  assert.deepEqual(withEnv({ ...clean, AI_BATTERY_ROWPTY_CONPTY: "os" }, () => compositorWindowsPty("10.0.26200")), {
    backend: "conpty",
    buildNumber: 26200
  });
});

test("native fullscreen keeps the docked HUD enabled unless explicitly disabled", () => {
  const clean = {
    AI_BATTERY_FULLSCREEN_HUD: undefined,
    CLAUDEX_BATTERY_FULLSCREEN_HUD: undefined
  };
  assert.equal(withEnv(clean, () => nativeFullscreenHudEnabled()), true);
  assert.equal(withEnv({ ...clean, AI_BATTERY_FULLSCREEN_HUD: "0" }, () => nativeFullscreenHudEnabled()), false);
});

test("Windows runner launches an npm cmd shim without an intermediate cmd.exe", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-npm-shim-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const scriptDir = path.join(tmpDir, "node_modules", "tool");
  const scriptPath = path.join(scriptDir, "bin.js");
  const shimPath = path.join(tmpDir, "codex.cmd");
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(scriptPath, "console.log('ok');\n");
  fs.writeFileSync(shimPath, "@echo off\r\n\"%dp0%\\node.exe\" \"%dp0%\\node_modules\\tool\\bin.js\" %*\r\n");

  assert.deepEqual(resolveNpmCmdShim(shimPath), {
    file: process.execPath,
    scriptPath
  });
  assert.deepEqual(windowsCommand([shimPath, "--version"]), {
    file: process.execPath,
    args: [scriptPath, "--version"]
  });
});

test("fullscreen compositor isolates child VT and reserves the status row", async () => {
  const hostWrites = [];
  const replies = [];
  const compositor = new HeadlessTerminalCompositor({
    columns: 50,
    rows: 8,
    frameIntervalMs: 0,
    writeHost: (data) => {
      hostWrites.push(data);
      return true;
    },
    onReply: (data) => replies.push(data)
  });

  compositor.start();
  await compositor.setStatusText("AI_BATTERY_FULLSCREEN_STATUS");
  await compositor.write("\x1b[?1049h\x1b[2J\x1b[HOLD_FRAME");
  await compositor.write("\x1b[?1007h");
  await compositor.write("\x1b[3J\x1b[2J\x1b[HFINAL_CODEX_SCREEN\x1b[6n");
  await compositor.write("\x1b[?2026hSYNCED_FINAL_FRAME");
  await compositor.flush();

  const snapshot = compositor.snapshot();
  assert.equal(snapshot.childRows, 7);
  assert.equal(snapshot.bufferType, "alternate");
  assert.match(snapshot.lines.join("\n"), /FINAL_CODEX_SCREEN/);
  assert.match(snapshot.lines.join("\n"), /SYNCED_FINAL_FRAME/);
  assert.doesNotMatch(snapshot.lines.join("\n"), /OLD_FRAME/);
  assert.match(snapshot.status, /AI_BATTERY_FULLSCREEN_STATUS/);
  assert.ok(snapshot.modes.mousePrivateModes.includes(1007));
  assert.ok(replies.some((reply) => /\x1b\[\d+;\d+R/.test(reply)), "terminal replies return to the child PTY");

  const host = hostWrites.join("");
  assert.match(host, /\x1b\[\?1049h/, "host alternate screen is owned by the compositor");
  assert.match(host, /\x1b\[\?1007h/, "alternate-scroll mode reaches the host");
  assert.match(host, /\x1b\[8;1H/, "battery is composed on the physical bottom row");
  assert.doesNotMatch(host, /\x1b\[3J/, "child scrollback clears never reach the host");

  await compositor.dispose();
  assert.ok(hostWrites.join("").endsWith(HOST_RESTORE_SEQUENCE));
});

test("Codex doctor reports experimental compositor dependencies", () => {
  assert.equal(compositorDiagnostic("linux"), null);
  const diagnostic = compositorDiagnostic("win32");
  assert.equal(typeof diagnostic.available, "boolean");
  assert.ok("headlessTerminal" in diagnostic);
  assert.ok("nodePty" in diagnostic);
});

test("Windows inline layout adds Codex no-alt-screen without touching other commands", () => {
  const clean = {
    AI_BATTERY_CODEX_NO_ALT_SCREEN: undefined,
    CLAUDEX_BATTERY_CODEX_NO_ALT_SCREEN: undefined
  };
  assert.equal(withEnv(clean, () => codexNoAltScreenEnabled()), true);
  assert.equal(withEnv({ ...clean, AI_BATTERY_CODEX_NO_ALT_SCREEN: "0" }, () => codexNoAltScreenEnabled()), false);
  assert.equal(commandArgsLookLikeCodex(["C:\\Tools\\codex.cmd"]), true);
  assert.equal(commandArgsLookLikeCodex(["node.exe", "codex.js"]), false);
  assert.deepEqual(withEnv(clean, () => withCodexNoAltScreen(["C:\\Tools\\codex.cmd", "--version"], "codex")), [
    "C:\\Tools\\codex.cmd",
    "--no-alt-screen",
    "--version"
  ]);
  assert.deepEqual(withEnv(clean, () => withCodexNoAltScreen(["C:\\Tools\\codex.cmd", "--no-alt-screen"], "codex")), [
    "C:\\Tools\\codex.cmd",
    "--no-alt-screen"
  ]);
  assert.deepEqual(withEnv(clean, () => withCodexNoAltScreen(["claude.cmd"], "claude")), ["claude.cmd"]);
});

test("HUD launcher parses dock options", () => {
  const docked = parseWindowsHudArgs(["--dock-window", "123456"]);
  assert.equal(docked.dockWindow, 123456);
  assert.equal(docked.dockConsole, false);
  const dockedEquals = parseWindowsHudArgs(["--dock-window=98765"]);
  assert.equal(dockedEquals.dockWindow, 98765);
  const auto = parseWindowsHudArgs(["--dock-console"]);
  assert.equal(auto.dockConsole, true);
  assert.equal(auto.dockWindow, 0);
  const plain = parseWindowsHudArgs([]);
  assert.equal(plain.dockConsole, false);
  assert.equal(plain.dockWindow, 0);
  assert.equal(parseWindowsHudArgs(["--dock-session", "4321"]).dockSession, 4321);
  assert.equal(plain.dockPosition, "bottom");
  assert.equal(parseWindowsHudArgs(["--dock-position", "tabs"]).dockPosition, "tabs");
  assert.equal(parseWindowsHudArgs(["--dock-position=top"]).dockPosition, "tabs");
  assert.equal(parseWindowsHudArgs(["--dock-bottom"]).dockPosition, "bottom");
  assert.throws(() => parseWindowsHudArgs(["--dock-position", "side"]), /bottom or tabs/);
});

test("Windows dock reserves space only on its terminal window", () => {
  const dockSource = fs.readFileSync(
    fileURLToPath(new URL("../lib/platforms/windows/hud/dock.ps1", import.meta.url)),
    "utf8"
  );
  const nativeSource = fs.readFileSync(
    fileURLToPath(new URL("../lib/platforms/windows/hud/native.ps1", import.meta.url)),
    "utf8"
  );
  assert.match(dockSource, /Reserve-DockTargetSpace/);
  assert.match(dockSource, /dock target .* is gone; waiting detached/);
  assert.match(dockSource, /if \(\$request\.detach\)/);
  assert.match(dockSource, /dock session released; retaining terminal target/);
  assert.doesNotMatch(dockSource, /dock detached session=/);
  assert.match(dockSource, /frame\.Left \+ \$horizontalInset \+ \$leftOpticalInset/);
  assert.match(dockSource, /frame\.Right - \$frame\.Left\) - \(\$horizontalInset \* 2\) - \$leftOpticalInset/);
  assert.match(dockSource, /\$bottomDelta = \$desiredFrameBottom - \[int\]\$frame\.Bottom/);
  assert.match(dockSource, /return \$fillsWorkHeight -or \$fillsMonitorHeight/);
  assert.doesNotMatch(dockSource, /SHAppBarMessage|Ensure-DockAppBar|ABM_SETPOS/);
  assert.doesNotMatch(nativeSource, /SHAppBarMessage|AiBatteryAppBarData|ABM_SETPOS/);
});

test("Windows HUD captures the launching terminal before process discovery", () => {
  const launcherSource = fs.readFileSync(
    fileURLToPath(new URL("../lib/platforms/windows/hud-launcher.js", import.meta.url)),
    "utf8"
  );
  const captureAt = launcherSource.indexOf("$launchForeground = [AiBatteryDock.Native]::GetForegroundWindow()");
  const processScanAt = launcherSource.indexOf("Get-CimInstance Win32_Process");
  assert.ok(captureAt >= 0 && captureAt < processScanAt);
  const fastExitAt = launcherSource.indexOf("[Int64]$launchForeground");
  assert.ok(fastExitAt > captureAt && fastExitAt < processScanAt);
  assert.match(launcherSource, /buildStartProcessCommand\("powershell\.exe", psArgs\)/);
  assert.match(launcherSource, /function tryAdoptRunningDockHost/);
  assert.match(launcherSource, /running dock host adopted/);
  assert.match(launcherSource, /\$ancestorPids\.ContainsKey\(\$fgPid\) -or \(\$parentChainUnavailable -and \$terminals -contains \$fgName\)/);
});

test("Windows dock debounces shell transitions and repaints only changed status", () => {
  const dockSource = fs.readFileSync(
    fileURLToPath(new URL("../lib/platforms/windows/hud/dock.ps1", import.meta.url)),
    "utf8"
  );
  const mainSource = fs.readFileSync(
    fileURLToPath(new URL("../lib/platforms/windows/hud/main.ps1", import.meta.url)),
    "utf8"
  );
  const windowingSource = fs.readFileSync(
    fileURLToPath(new URL("../lib/platforms/windows/hud/windowing.ps1", import.meta.url)),
    "utf8"
  );
  assert.match(mainSource, /EVENT_SYSTEM_MOVESIZESTART/);
  assert.match(dockSource, /TotalMilliseconds -ge 500/);
  assert.match(dockSource, /function Test-DockSnapPreviewActive/);
  assert.match(dockSource, /if \(Update-DockSnapPreviewVisibility\) \{ return \}/);
  assert.doesNotMatch(dockSource, /Control\]::MouseButtons/);
  assert.match(dockSource, /Scale-HudValue 20/);
  assert.match(dockSource, /GetAsyncKeyState\(1\)/);
  assert.match(dockSource, /TotalMilliseconds -le 350/);
  assert.match(dockSource, /function Update-DockGlobalDragState/);
  assert.match(dockSource, /function Update-DockObservedFrameDragState/);
  assert.match(dockSource, /\$script:dockObservedRawRectKey -ne \$key/);
  assert.match(dockSource, /\$script:dockObservedFrameDragActive -or/);
  assert.match(dockSource, /GetForegroundWindow\(\) -eq \$script:dockTargetHandle/);
  assert.match(dockSource, /\$script:dockGlobalDragActive -and \(\$recentFrameChange -or \$script:dockSnapPreviewActive\)/);
  assert.match(dockSource, /-not \$script:dockGlobalDragActive -and\s+-not \$script:dockObservedFrameDragActive -and\s+-not \$script:dockSnapPreviewActive/);
  assert.match(dockSource, /elseif \(-not \(Test-DockLeftButtonDown\)\)/);
  assert.match(dockSource, /dockActiveTrackingInterval = 16/);
  assert.match(dockSource, /dockFastTrackingUntilUtc = \[datetime\]::UtcNow\.AddMilliseconds\(350\)/);
  assert.match(dockSource, /\$live\.Right = \[int\]\$raw\.Right - \$script:dockFrameInsetRight/);
  assert.match(mainSource, /Invalidate-DockedTuiIfChanged/);
  assert.match(mainSource, /DoubleBuffered/);
  assert.match(mainSource, /function Get-DockedTuiResponsiveLayout/);
  assert.match(mainSource, /Name = "full"; BarWidth = 10; ShowWindows = \$true/);
  assert.match(mainSource, /Name = "metrics-half"; BarWidth = 5; ShowWindows = \$true/);
  assert.match(mainSource, /Name = "summary-full"; BarWidth = 10; ShowWindows = \$false/);
  assert.doesNotMatch(mainSource, /Name = "summary-half"/);
  assert.match(mainSource, /\$requiredWidths\[0\] \* 1\.08/);
  assert.match(mainSource, /\$requiredWidths\[0\] \* 0\.98/);
  assert.match(mainSource, /dock responsive layout ->/);
  assert.match(mainSource, /Draw-DockedTuiStatusline \$event\.Graphics \$sender\.Width \$sender\.Height/);
  assert.match(dockSource, /\$script:dockTuiPaintPanel\.Invalidate\(\)/);
  assert.match(windowingSource, /if \(\$script:hudHiddenForFullscreen -eq \$Hidden\) \{ return \}/);
  const runnerSource = fs.readFileSync(
    fileURLToPath(new URL("../lib/platforms/windows/codex-runner.js", import.meta.url)),
    "utf8"
  );
  assert.doesNotMatch(runnerSource, /stopDockedHud/);
});

test("Windows Codex runner normalizes the dock position option", () => {
  assert.equal(withEnv({
    AI_BATTERY_WIN_DOCK_POSITION: undefined,
    CLAUDEX_BATTERY_WIN_DOCK_POSITION: undefined
  }, windowsDockPosition), "bottom");
  assert.equal(withEnv({
    AI_BATTERY_WIN_DOCK_POSITION: "tabs"
  }, windowsDockPosition), "tabs");
  assert.equal(withEnv({
    AI_BATTERY_WIN_DOCK_POSITION: "unknown"
  }, windowsDockPosition), "bottom");
});

test("rowpty spawn defaults to the bundled ConPTY provider (auto)", () => {
  const clean = {
    AI_BATTERY_ROWPTY_CONPTY: undefined,
    CLAUDEX_BATTERY_ROWPTY_CONPTY: undefined,
    AI_BATTERY_ROWPTY_PRESERVE_SCROLLBACK: undefined,
    CLAUDEX_BATTERY_ROWPTY_PRESERVE_SCROLLBACK: undefined,
    AI_BATTERY_ROWPTY_FILTER_ALT_SCREEN: undefined,
    CLAUDEX_BATTERY_ROWPTY_FILTER_ALT_SCREEN: undefined,
    ROWPTY_PRESERVE_SCROLLBACK: undefined,
    ROWPTY_FILTER_ALT_SCREEN: undefined,
    ROWPTY_NO_CONPTY_DLL: undefined,
    ROWPTY_CONPTY_DLL: undefined
  };
  assert.equal(withEnv(clean, () => rowptyConptyMode()), "auto");
  assert.equal(withEnv(clean, () => rowptySpawnEnv().ROWPTY_NO_CONPTY_DLL), undefined);
  assert.equal(withEnv({
    ...clean,
    AI_BATTERY_ROWPTY_CONPTY: "os"
  }, () => rowptySpawnEnv().ROWPTY_NO_CONPTY_DLL), "1");
  // A raw ROWPTY_NO_CONPTY_DLL override is respected when no explicit
  // AI_BATTERY_ROWPTY_CONPTY mode was requested.
  assert.equal(withEnv({
    ...clean,
    ROWPTY_NO_CONPTY_DLL: "1"
  }, () => rowptySpawnEnv().ROWPTY_NO_CONPTY_DLL), "1");
  assert.equal(withEnv(clean, () => rowptyPreserveScrollback()), true);
  assert.equal(withEnv(clean, () => rowptySpawnEnv().ROWPTY_PRESERVE_SCROLLBACK), "1");
  assert.equal(withEnv(clean, () => rowptyFilterAltScreen()), false);
  assert.equal(withEnv(clean, () => rowptySpawnEnv().ROWPTY_FILTER_ALT_SCREEN), "0");

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
    AI_BATTERY_ROWPTY_CONPTY: "auto",
    ROWPTY_NO_CONPTY_DLL: "1"
  }, () => ({ mode: rowptyConptyMode(), env: rowptySpawnEnv() }));
  assert.equal(auto.mode, "auto");
  assert.equal(auto.env.ROWPTY_NO_CONPTY_DLL, undefined);

  assert.equal(withEnv({
    ...clean,
    AI_BATTERY_ROWPTY_PRESERVE_SCROLLBACK: "off"
  }, () => rowptyPreserveScrollback()), false);
  assert.equal(withEnv({
    ...clean,
    AI_BATTERY_ROWPTY_PRESERVE_SCROLLBACK: "off"
  }, () => rowptySpawnEnv().ROWPTY_PRESERVE_SCROLLBACK), "0");
  assert.equal(withEnv({
    ...clean,
    AI_BATTERY_ROWPTY_FILTER_ALT_SCREEN: "1"
  }, () => rowptySpawnEnv().ROWPTY_FILTER_ALT_SCREEN), "1");
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

test("Windows runner normalizes a quoted npm cmd path and resolves it directly", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-quoted-shim-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const scriptPath = path.join(tmpDir, "node_modules", "codex", "bin", "codex.js");
  const cmdPath = path.join(tmpDir, "codex.cmd");
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "console.log('codex');\n");
  fs.writeFileSync(cmdPath, "@echo off\r\n\"%dp0%\\node.exe\" \"%dp0%\\node_modules\\codex\\bin\\codex.js\" %*\r\n");
  const quotedCodex = `'\\"${cmdPath}\\"'`;
  const command = windowsCommand([quotedCodex, "--version"]);

  assert.equal(command.file, process.execPath);
  assert.deepEqual(command.args, [scriptPath, "--version"]);
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

test("uninstall retains Codex recovery metadata when the configured wrapper was replaced", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, "state");
  const shimDir = path.join(tmpDir, "shim");
  const wrapperPath = path.join(shimDir, CODEX_BIN_NAME);
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const replacement = "user-owned replacement\n";
  fs.writeFileSync(wrapperPath, replacement);
  fs.writeFileSync(path.join(stateDir, "config.json"), `${JSON.stringify({
    version: 1,
    providers: { codex: true, claude: true },
    codexWrapper: {
      wrapperPath,
      originalCommand: path.join(tmpDir, "original", CODEX_BIN_NAME),
      backupPath: null,
      pathAddedByAiBattery: shimDir
    },
    codexStatusLineBackup: null,
    claudeStatusLineBackup: null
  }, null, 2)}\n`);

  const result = withEnv({
    HOME: path.join(tmpDir, "home"),
    AI_BATTERY_STATE_DIR: stateDir,
    AI_BATTERY_SKIP_WINDOWS_PATH_WRITE: "1",
    PATH: ""
  }, uninstallCodexWrapper);

  assert.equal(result.retainedConfig, true);
  assert.equal(result.changed, false);
  assert.equal(fs.readFileSync(wrapperPath, "utf8"), replacement);
  const recovery = JSON.parse(fs.readFileSync(path.join(stateDir, "config.json"), "utf8"));
  assert.equal(recovery.codexWrapper.wrapperPath, wrapperPath);
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

test("Windows setup keeps literal percent and Unicode paths out of the batch wrapper", { skip: process.platform !== "win32" }, (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const stateDir = path.join(tmpDir, "state");
  const shimDir = path.join(tmpDir, "shim");
  const originalDir = path.join(tmpDir, "original-%literal%-codex-한글");
  fs.mkdirSync(originalDir, { recursive: true });
  const originalCodex = path.join(originalDir, CODEX_BIN_NAME);
  fs.writeFileSync(originalCodex, "@echo off\r\necho original codex\r\n");

  const result = withEnv({
    HOME: homeDir,
    XDG_STATE_HOME: stateDir,
    AI_BATTERY_SHIM_DIR: shimDir,
    AI_BATTERY_SKIP_WINDOWS_PATH_WRITE: "1",
    PATH: `${originalDir}${path.delimiter}${process.env.PATH || ""}`
  }, () => installCodexWrapper({ force: false }));

  assert.equal(result.ok, true);
  const wrapperText = fs.readFileSync(result.wrapperPath, "utf8");
  const bridgeText = fs.readFileSync(result.bridgePath, "utf8");
  assert.doesNotMatch(wrapperText, /%literal%|한글/);
  assert.match(wrapperText, /%~dp0codex\.cmd\.ai-battery\.cjs/);
  assert.match(bridgeText, /AI_BATTERY_MANAGED_CODEX_BRIDGE/);
  assert.match(bridgeText, /%literal%/);
  assert.match(bridgeText, /한글/);
  assert.equal(fs.existsSync(originalCodex), true);

  const removed = withEnv({
    HOME: homeDir,
    XDG_STATE_HOME: stateDir,
    AI_BATTERY_SHIM_DIR: shimDir,
    AI_BATTERY_SKIP_WINDOWS_PATH_WRITE: "1"
  }, uninstallCodexWrapper);
  assert.equal(removed.changed, true);
  assert.equal(fs.existsSync(result.wrapperPath), false);
  assert.equal(fs.existsSync(result.bridgePath), false);
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
    assert.match(fs.readFileSync(result.bridgePath, "utf8"), /"--left-padding", "2", "--"/);
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
    "echo home:%HOME%",
    "echo userprofile:%USERPROFILE%",
    "echo codexhome:%CODEX_HOME%",
    "echo cwd:%CD%",
    ""
  ].join("\r\n"));

  const codexHome = path.join(tmpDir, "codex-home");
  const userProfile = path.join(tmpDir, "user-profile");
  const workingDir = path.join(tmpDir, "working-dir");
  fs.mkdirSync(workingDir, { recursive: true });

  const env = {
    HOME: homeDir,
    XDG_STATE_HOME: stateDir,
    XDG_DATA_HOME: dataDir,
    AI_BATTERY_SHIM_DIR: shimDir,
    AI_BATTERY_SKIP_WINDOWS_PATH_WRITE: "1",
    AI_BATTERY_RC: path.join(tmpDir, "shellrc"),
    CODEX_HOME: codexHome,
    USERPROFILE: userProfile,
    PATH: `${originalDir}${path.delimiter}${process.env.PATH || ""}`
  };

  const result = withEnv(env, () => installCodexWrapper({ force: false }));
  assert.equal(result.ok, true);

  const wrapperText = fs.readFileSync(result.wrapperPath, "utf8");
  const bridgeText = fs.readFileSync(result.bridgePath, "utf8");
  assert.match(wrapperText, /%~dp0codex\.cmd\.ai-battery\.cjs/);
  assert.doesNotMatch(wrapperText, new RegExp(originalCodex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(bridgeText, /AI_BATTERY_DISABLE_WINDOWS_CODEX_RUNNER/);
  assert.doesNotMatch(bridgeText, /AI_BATTERY_WIN_LAYOUT/);
  assert.match(bridgeText, /"--provider", "all", "--left-padding", "2", "--"/);
  assert.doesNotMatch(bridgeText, /"--provider", "codex"/);
  assert.match(bridgeText, /AI_BATTERY_MANAGED_CODEX_BRIDGE/);

  const run = spawnSync("cmd.exe", ["/d", "/s", "/c", "call", result.wrapperPath, "--version"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      AI_BATTERY_DISABLE_WINDOWS_CODEX_RUNNER: ""
    },
    cwd: workingDir,
    timeout: 5000
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /wrapped:1/);
  assert.match(run.stdout, /args:--version/);
  assert.equal(run.stdout.includes(`home:${homeDir}`), true, run.stdout);
  assert.equal(run.stdout.includes(`userprofile:${userProfile}`), true, run.stdout);
  assert.equal(run.stdout.includes(`codexhome:${codexHome}`), true, run.stdout);
  assert.equal(run.stdout.includes(`cwd:${workingDir}`), true, run.stdout);

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
  const resumeSession = path.join(codexHome, "sessions", "2026", "07", "13", "resume-context.jsonl");
  const resumeSessionText = `${JSON.stringify({ type: "response_item", payload: { text: "keep this resume context" } })}\n`;
  fs.mkdirSync(path.dirname(resumeSession), { recursive: true });
  fs.writeFileSync(resumeSession, resumeSessionText);
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

  const setup = spawnNode([CLI_PATH, "setup", "codex", "--json"], {
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
  assert.equal(fs.readFileSync(resumeSession, "utf8"), resumeSessionText);

  const uninstall = spawnNode([CLI_PATH, "uninstall", "codex", "--json"], {
    encoding: "utf8",
    env,
    timeout: 5000
  });

  assert.equal(uninstall.status, 0, uninstall.stderr);
  const uninstallJson = JSON.parse(uninstall.stdout);
  assert.equal(uninstallJson.results.codex.statusLine.restored, true);
  assert.equal(fs.readFileSync(configToml, "utf8"), originalToml);
  assert.equal(fs.readFileSync(resumeSession, "utf8"), resumeSessionText);
});

test("setup replaces a multiline Codex status_line without leaving invalid TOML fragments", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const stateDir = path.join(tmpDir, "state");
  const codexHome = path.join(homeDir, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  const configToml = path.join(codexHome, "config.toml");
  const originalToml = [
    'model = "gpt-5"',
    "",
    "[tui]",
    "status_line = [",
    '  "model",',
    '  "context-remaining",',
    "]",
    "status_line_use_colors = true",
    "animations = false",
    ""
  ].join("\n");
  fs.writeFileSync(configToml, originalToml);

  withEnv({
    HOME: homeDir,
    CODEX_HOME: codexHome,
    XDG_STATE_HOME: stateDir
  }, () => {
    const installed = installCodexStatusLine();
    assert.equal(installed.ok, true);
    assert.equal(installed.changed, true);
    const configured = fs.readFileSync(configToml, "utf8");
    assert.equal(codexStatusLineMatches(configured), true);
    assert.doesNotMatch(configured, /^\s*"(?:model|context-remaining)",?\s*$/m);
    assert.doesNotMatch(configured, /^\s*\]\s*$/m);
    assert.match(configured, /animations = false/);

    const removed = uninstallCodexWrapper();
    assert.equal(removed.statusLine.restored, true);
    assert.equal(fs.readFileSync(configToml, "utf8"), originalToml);
  });
});

test("setup and uninstall preserve symlinked Codex and Claude settings files", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const homeDir = path.join(tmpDir, "home");
  const stateRoot = path.join(tmpDir, "state");
  const codexHome = path.join(homeDir, ".codex");
  const claudeHome = path.join(homeDir, ".claude");
  const dotfiles = path.join(tmpDir, "dotfiles");
  for (const dir of [codexHome, claudeHome, dotfiles]) fs.mkdirSync(dir, { recursive: true });
  const codexTarget = path.join(dotfiles, "codex.toml");
  const claudeTarget = path.join(dotfiles, "claude.json");
  const codexLink = path.join(codexHome, "config.toml");
  const claudeLink = path.join(claudeHome, "settings.json");
  const originalCodex = '[tui]\nstatus_line = ["context-remaining"]\n';
  const originalClaude = { theme: "dark" };
  fs.writeFileSync(codexTarget, originalCodex);
  fs.writeFileSync(claudeTarget, `${JSON.stringify(originalClaude, null, 2)}\n`);
  try {
    fs.symlinkSync(codexTarget, codexLink, "file");
    fs.symlinkSync(claudeTarget, claudeLink, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip("file symlinks are unavailable");
      return;
    }
    throw error;
  }

  withEnv({
    HOME: homeDir,
    CODEX_HOME: codexHome,
    XDG_STATE_HOME: stateRoot,
    XDG_DATA_HOME: path.join(tmpDir, "data"),
    AI_BATTERY_RC: path.join(tmpDir, "shellrc"),
    PATH: ""
  }, () => {
    assert.equal(installCodexStatusLine().ok, true);
    assert.equal(installClaudeStatusline({ force: false }).ok, true);
    assert.equal(fs.lstatSync(codexLink).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(claudeLink).isSymbolicLink(), true);

    assert.equal(uninstallCodexWrapper().statusLine.restored, true);
    assert.equal(uninstallClaudeStatusline({ strict: false }).changed, true);
  });

  assert.equal(fs.lstatSync(codexLink).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(claudeLink).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(codexTarget, "utf8"), originalCodex);
  assert.deepEqual(JSON.parse(fs.readFileSync(claudeTarget, "utf8")), originalClaude);
});

test("setup refuses to reuse a Codex status_line backup for a different CODEX_HOME", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const stateDir = path.join(tmpDir, "state");
  const firstCodexHome = path.join(homeDir, "first-codex");
  const secondCodexHome = path.join(homeDir, "second-codex");
  fs.mkdirSync(firstCodexHome, { recursive: true });
  fs.mkdirSync(secondCodexHome, { recursive: true });
  fs.writeFileSync(path.join(firstCodexHome, "config.toml"), '[tui]\nstatus_line = ["model"]\n');
  const secondConfig = path.join(secondCodexHome, "config.toml");
  const secondOriginal = '[tui]\nstatus_line = ["context-remaining"]\n';
  fs.writeFileSync(secondConfig, secondOriginal);

  withEnv({ HOME: homeDir, XDG_STATE_HOME: stateDir, CODEX_HOME: firstCodexHome }, () => {
    assert.equal(installCodexStatusLine().ok, true);
  });
  withEnv({ HOME: homeDir, XDG_STATE_HOME: stateDir, CODEX_HOME: secondCodexHome }, () => {
    const installed = installCodexStatusLine();
    assert.equal(installed.ok, false);
    assert.equal(installed.skipped, true);
    assert.match(installed.reason, /different CODEX_HOME/);
    assert.equal(fs.readFileSync(secondConfig, "utf8"), secondOriginal);
  });
});

test("uninstall restores Codex status_line while preserving unrelated user edits", (t) => {
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

    assert.equal(removed.statusLine.restored, true);
    assert.equal(removed.statusLine.merged, true);
    const currentToml = fs.readFileSync(configToml, "utf8");
    assert.match(currentToml, /extra_status_hint = true/);
    assert.match(currentToml, /status_line = \["context-remaining"\]/);
    assert.equal(codexStatusLineMatches(currentToml), false);
  });
});

test("uninstall keeps the Codex recovery backup when a managed status key was edited", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const stateRoot = path.join(tmpDir, "state");
  const codexHome = path.join(homeDir, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  const configToml = path.join(codexHome, "config.toml");
  fs.writeFileSync(configToml, '[tui]\nstatus_line = ["context-remaining"]\n');
  const env = {
    ...process.env,
    HOME: homeDir,
    CODEX_HOME: codexHome,
    XDG_STATE_HOME: stateRoot,
    XDG_DATA_HOME: path.join(tmpDir, "data"),
    AI_BATTERY_RC: path.join(tmpDir, "shellrc"),
    PATH: ""
  };

  withEnv(env, () => {
    assert.equal(installCodexStatusLine().ok, true);
  });
  fs.writeFileSync(configToml, '[tui]\nstatus_line = ["context-remaining"]\nstatus_line_use_colors = false\n');

  const removed = spawnNode([CLI_PATH, "uninstall", "codex", "--json"], {
    encoding: "utf8",
    env,
    timeout: 5000
  });
  assert.equal(removed.status, 1, removed.stderr);
  const result = JSON.parse(removed.stdout);
  assert.equal(result.results.codex.statusLine.skipped, true);
  assert.match(fs.readFileSync(configToml, "utf8"), /context-remaining/);
  const recovery = JSON.parse(fs.readFileSync(path.join(stateRoot, "ai-battery", "config.json"), "utf8"));
  assert.ok(recovery.codexStatusLineBackup);
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
  const result = spawnNode([
    CLI_PATH,
    "capture-claude",
    "--muted",
    "--provider",
    "claude",
    "--usage-row",
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

test("Claude capture can hide the duplicated per-pane usage row", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const input = {
    session_id: "header-only-test",
    model: { display_name: "Opus" },
    workspace: { project_dir: tmpDir },
    context_window: { remaining_percentage: 83 },
    terminal: { columns: 100 },
    transcript_path: "",
    rate_limits: {
      five_hour: {
        used_percentage: 25,
        resets_at: Math.floor((Date.now() + (90 * 60 * 1000)) / 1000),
        window_minutes: 300
      }
    }
  };
  const result = spawnNode([
    CLI_PATH,
    "capture-claude",
    "--muted",
    "--provider",
    "claude",
    "--left-padding",
    "3",
    "--no-usage-row"
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
  assert.equal(plainLines.length, 1);
  assert.match(plainLines[0].slice(3), /^Opus\b/);
  assert.doesNotMatch(plainLines[0], /Claude\b.*75%/);
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
  const result = spawnNode([
    CLI_PATH,
    "capture-claude",
    "--muted",
    "--usage-row",
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
  assert.match(result.stdout, /\x1b\[97mCodex/);
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
  const result = spawnNode([
    CLI_PATH,
    "capture-claude",
    "--muted",
    "--usage-row",
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
  fs.writeFileSync(settingsPath, `${JSON.stringify({ theme: "dark", statusLine: externalStatusLine }, null, 2)}\n`);

  withEnv({
    HOME: homeDir,
    XDG_STATE_HOME: stateDir
  }, () => {
    const skipped = installClaudeStatusline({ force: false });
    assert.equal(skipped.skipped, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")).statusLine, externalStatusLine);

    const installed = installClaudeStatusline({ force: true });
    assert.equal(installed.backedUp, true);
    const configured = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.match(configured.statusLine.command, /capture-claude/);
    configured.userAddedAfterSetup = true;
    fs.writeFileSync(settingsPath, `${JSON.stringify(configured, null, 2)}\n`);

    const removed = uninstallClaudeStatusline({ strict: false });
    assert.equal(removed.restored, true);
    const restored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.deepEqual(restored.statusLine, externalStatusLine);
    assert.equal(restored.theme, "dark");
    assert.equal(restored.userAddedAfterSetup, true);
  });
});

test("Claude uninstall removes a settings file that setup created solely for statusLine", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const homeDir = path.join(tmpDir, "home");
  const stateRoot = path.join(tmpDir, "state");
  const settingsPath = path.join(homeDir, ".claude", "settings.json");

  withEnv({ HOME: homeDir, XDG_STATE_HOME: stateRoot }, () => {
    const installed = installClaudeStatusline({ force: false });
    assert.equal(installed.ok, true);
    assert.equal(installed.backedUp, true);
    assert.equal(fs.existsSync(settingsPath), true);

    const removed = uninstallClaudeStatusline({ strict: false });
    assert.equal(removed.changed, true);
    assert.equal(fs.existsSync(settingsPath), false);
  });
  const recovery = JSON.parse(fs.readFileSync(path.join(stateRoot, "ai-battery", "config.json"), "utf8"));
  assert.equal(recovery.claudeStatusLineBackup, null);
});

test("Claude uninstall keeps a recovery backup when the managed statusLine was edited", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const homeDir = path.join(tmpDir, "home");
  const stateRoot = path.join(tmpDir, "state");
  const settingsPath = path.join(homeDir, ".claude", "settings.json");
  const env = { ...process.env, HOME: homeDir, XDG_STATE_HOME: stateRoot };

  withEnv(env, () => assert.equal(installClaudeStatusline({ force: false }).ok, true));
  const edited = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  edited.statusLine.refreshInterval = 59;
  fs.writeFileSync(settingsPath, `${JSON.stringify(edited, null, 2)}\n`);

  const removed = spawnNode([CLI_PATH, "uninstall", "claude", "--json"], {
    encoding: "utf8",
    env,
    timeout: 5000
  });
  assert.equal(removed.status, 1, removed.stderr);
  const result = JSON.parse(removed.stdout);
  assert.equal(result.results.claude.retainedBackup, true);
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).statusLine.refreshInterval, 59);
  const recovery = JSON.parse(fs.readFileSync(path.join(stateRoot, "ai-battery", "config.json"), "utf8"));
  assert.ok(recovery.claudeStatusLineBackup);
});

test("Claude setup and uninstall never overwrite an invalid settings.json", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const stateDir = path.join(tmpDir, "state");
  const claudeDir = path.join(homeDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.json");
  const invalidSettings = '{ "permissions": { "allow": [ }\n';
  fs.writeFileSync(settingsPath, invalidSettings);

  withEnv({ HOME: homeDir, XDG_STATE_HOME: stateDir }, () => {
    const installed = installClaudeStatusline({ force: true });
    assert.equal(installed.ok, false);
    assert.equal(installed.skipped, true);
    assert.match(installed.reason, /left untouched/);
    assert.equal(fs.readFileSync(settingsPath, "utf8"), invalidSettings);

    const removed = uninstallClaudeStatusline({ strict: false });
    assert.equal(removed.changed, false);
    assert.equal(removed.skipped, true);
    assert.equal(fs.readFileSync(settingsPath, "utf8"), invalidSettings);
  });

  const cliResult = spawnNode([CLI_PATH, "install-claude-statusline", "--force", "--json"], {
    encoding: "utf8",
    env: { ...process.env, HOME: homeDir, XDG_STATE_HOME: stateDir },
    timeout: 5000
  });
  assert.equal(cliResult.status, 1);
  assert.equal(JSON.parse(cliResult.stdout).skipped, true);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), invalidSettings);
});

test("setup does not touch Codex or Claude when AI Battery's own config is invalid", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const stateDir = path.join(tmpDir, "state");
  const codexHome = path.join(homeDir, ".codex");
  const claudeDir = path.join(homeDir, ".claude");
  const shimDir = path.join(tmpDir, "shim");
  const originalDir = path.join(tmpDir, "original");
  for (const dir of [stateDir, codexHome, claudeDir, originalDir]) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(stateDir, "config.json"), '{ "codexWrapper": ');
  const codexConfig = path.join(codexHome, "config.toml");
  const originalCodexConfig = '[tui]\nstatus_line = ["context-remaining"]\n';
  fs.writeFileSync(codexConfig, originalCodexConfig);
  const claudeSettings = path.join(claudeDir, "settings.json");
  const originalClaudeSettings = `${JSON.stringify({ permissions: { allow: ["Read"] } }, null, 2)}\n`;
  fs.writeFileSync(claudeSettings, originalClaudeSettings);
  const originalCodex = path.join(originalDir, CODEX_BIN_NAME);
  fs.writeFileSync(originalCodex, process.platform === "win32"
    ? "@echo off\r\necho codex\r\n"
    : "#!/bin/sh\necho codex\n", { mode: 0o755 });

  const result = spawnNode([CLI_PATH, "setup", "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      CODEX_HOME: codexHome,
      AI_BATTERY_STATE_DIR: stateDir,
      AI_BATTERY_SHIM_DIR: shimDir,
      AI_BATTERY_SKIP_WINDOWS_PATH_WRITE: "1",
      PATH: `${originalDir}${path.delimiter}${process.env.PATH || ""}`
    },
    timeout: 5000
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /AI Battery config is invalid/);
  assert.equal(fs.readFileSync(codexConfig, "utf8"), originalCodexConfig);
  assert.equal(fs.readFileSync(claudeSettings, "utf8"), originalClaudeSettings);
  assert.equal(fs.existsSync(path.join(shimDir, CODEX_BIN_NAME)), false);
});

test("uninstall reports failure and touches no user settings when recovery metadata is invalid", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const homeDir = path.join(tmpDir, "home");
  const stateDir = path.join(tmpDir, "state");
  const codexHome = path.join(homeDir, ".codex");
  const claudeDir = path.join(homeDir, ".claude");
  for (const dir of [stateDir, codexHome, claudeDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "config.json"), '{ "codexWrapper": ');
  const codexConfig = path.join(codexHome, "config.toml");
  const managedCodexConfig = '[tui]\nstatus_line = ["model-with-reasoning", "current-dir", "git-branch"]\nstatus_line_use_colors = false\n';
  fs.writeFileSync(codexConfig, managedCodexConfig);
  const claudeSettings = path.join(claudeDir, "settings.json");
  const managedClaudeSettings = `${JSON.stringify({
    statusLine: { type: "command", command: "node ai-battery.js capture-claude", padding: 0 }
  }, null, 2)}\n`;
  fs.writeFileSync(claudeSettings, managedClaudeSettings);

  const result = spawnNode([CLI_PATH, "uninstall", "codex", "claude", "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      CODEX_HOME: codexHome,
      AI_BATTERY_STATE_DIR: stateDir,
      AI_BATTERY_DATA_DIR: path.join(tmpDir, "data"),
      AI_BATTERY_SKIP_WINDOWS_PATH_WRITE: "1",
      PATH: ""
    },
    timeout: 5000
  });

  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.results.codex.error, /config is invalid/);
  assert.match(output.results.claude.error, /config is invalid/);
  assert.equal(fs.readFileSync(codexConfig, "utf8"), managedCodexConfig);
  assert.equal(fs.readFileSync(claudeSettings, "utf8"), managedClaudeSettings);
});

test("Claude setup can persist a header-only pane statusLine", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const homeDir = path.join(tmpDir, "home");
  const stateDir = path.join(tmpDir, "state");
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  const settingsPath = path.join(homeDir, ".claude", "settings.json");

  withEnv({
    HOME: homeDir,
    XDG_STATE_HOME: stateDir
  }, () => {
    const installed = installClaudeStatusline({ force: false, usageRow: false });
    assert.match(installed.command, /--no-usage-row/);
    const command = JSON.parse(fs.readFileSync(settingsPath, "utf8")).statusLine.command;
    assert.match(command, /capture-claude/);
    assert.match(command, /--no-usage-row/);
    if (process.platform === "win32") assert.match(command, /--attach-hud/);
  });
});

test("Windows setup builds rowpty only for an explicitly requested legacy TUI layout", () => {
  assert.equal(withEnv({
    AI_BATTERY_INSTALL_ROWPTY: undefined,
    AI_BATTERY_WIN_LAYOUT: undefined,
    CLAUDEX_BATTERY_WIN_LAYOUT: undefined,
    AI_BATTERY_LAYOUT: undefined
  }, windowsSetupNeedsRowPty), false);
  assert.equal(withEnv({
    AI_BATTERY_INSTALL_ROWPTY: undefined,
    AI_BATTERY_WIN_LAYOUT: "tui"
  }, windowsSetupNeedsRowPty), true);
  assert.equal(withEnv({
    AI_BATTERY_INSTALL_ROWPTY: "1",
    AI_BATTERY_WIN_LAYOUT: "fullscreen"
  }, windowsSetupNeedsRowPty), true);
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
  const snapshot = JSON.parse(spawnNode([CLI_PATH, "--json"], {
    encoding: "utf8",
    timeout: 5000
  }).stdout);
  const providers = snapshot.results.map((entry) => entry.provider);
  // Only meaningful when both providers report on this machine.
  if (!(providers.includes("codex") && providers.includes("claude"))) return;

  const narrow = spawnNode([
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
