#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_TAIL_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FILES = 40;
const CLAUDE_LIMIT_HIT_TAIL_BYTES = 256 * 1024;
const CLAUDE_LIMIT_HIT_MAX_FILES = 80;
const DIVIDER = "│";
const PROVIDER_DIVIDER = "┃";
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const DEFAULT_STATUSLINE_COLUMN_GUARD = 4;
const COMMANDS = new Set([
  "show",
  "setup",
  "doctor",
  "hud",
  "on",
  "off",
  "capture-claude",
  "install-claude-statusline",
  "uninstall-claude-statusline"
]);
const PROVIDERS = ["codex", "claude"];
const CODEX_WRAPPER_MARKER = "AI_BATTERY_MANAGED_CODEX_WRAPPER";

function parseArgs(argv) {
  const args = {
    command: "show",
    provider: "all",
    json: false,
    watch: false,
    interval: 10,
    style: process.stdout.isTTY ? "ansi" : "plain",
    barWidth: 10,
    maxWidth: null,
    leftPadding: 0,
    activeProvider: null,
    showPaths: false,
    silent: false,
    force: false,
    header: true,
    help: false,
    targets: [],
    rest: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("-") && COMMANDS.has(arg)) {
      args.command = arg;
      if (arg === "hud") {
        args.rest = argv.slice(i + 1);
        break;
      }
    } else if (!arg.startsWith("-") && ["setup", "on", "off"].includes(args.command)) {
      args.targets.push(arg);
    } else if (arg === "--provider" || arg === "-p") {
      args.provider = argv[++i] || "all";
    } else if (arg === "--json") {
      args.json = true;
      args.style = "plain";
    } else if (arg === "--ansi") {
      args.style = "ansi";
    } else if (arg === "--muted") {
      args.style = "muted";
    } else if (arg === "--tmux") {
      args.style = "tmux";
    } else if (arg === "--silent") {
      args.silent = true;
    } else if (arg === "--no-header") {
      args.header = false;
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--watch" || arg === "-w") {
      args.watch = true;
      const maybeInterval = argv[i + 1];
      if (maybeInterval && !maybeInterval.startsWith("-")) {
        args.interval = Math.max(1, Number(maybeInterval) || args.interval);
        i += 1;
      }
    } else if (arg === "--no-color") {
      args.style = "plain";
    } else if (arg === "--bar-width") {
      args.barWidth = Math.max(4, Math.min(30, Number(argv[++i]) || args.barWidth));
    } else if (arg === "--max-width") {
      args.maxWidth = Math.max(20, Number(argv[++i]) || 0) || null;
    } else if (arg === "--left-padding") {
      args.leftPadding = Math.max(0, Math.min(20, Number(argv[++i]) || 0));
    } else if (arg === "--active-provider") {
      args.activeProvider = argv[++i] || null;
    } else if (arg === "--show-paths") {
      args.showPaths = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!["all", "codex", "claude"].includes(args.provider)) {
    throw new Error("--provider must be one of: all, codex, claude");
  }
  if (args.activeProvider && !["codex", "claude"].includes(args.activeProvider)) {
    throw new Error("--active-provider must be one of: codex, claude");
  }

  return args;
}

function printHelp() {
  console.log(`ai-battery

Usage:
  ai-battery [options]
  ai-battery setup [codex|claude] [--force]
  ai-battery doctor
  ai-battery hud [start|stop|status] [hud options]
  ai-battery hud autostart on|off|status
  ai-battery off codex|claude|all
  ai-battery on codex|claude|all

Aliases:
  claudex-battery

Options:
  -p, --provider all|codex|claude  Provider to show (default: all)
      --json                       Print machine-readable JSON
      --ansi                       Force ANSI color output
      --muted                      Use Codex-style muted status-line colors
      --no-header                  Hide Claude's extra statusLine header
  -w, --watch [seconds]            Refresh in place (default: 10 seconds)
      --bar-width N                Battery bar width (default: 10)
      --max-width N                Fit text output within N terminal columns
      --left-padding N             Prefix status output with N spaces
      --active-provider codex|claude
      --show-paths                 Include source log paths in text output
      --tmux                       Emit tmux status-line color markup
      --force                      Replace an existing Claude statusLine
      --no-color                   Disable ANSI colors
  -h, --help                       Show this help

Compatibility:
  ai-battery install-claude-statusline [--force]
  ai-battery uninstall-claude-statusline
`);
}

function userHome() {
  const home = os.homedir();
  if (process.platform !== "win32" && (/^[A-Za-z]:[\\/]/.test(home) || home.includes("\\"))) {
    try {
      const info = os.userInfo();
      if (info?.homedir?.startsWith("/")) return info.homedir;
    } catch {
      // Fall through to a conventional Linux home path.
    }
    if (process.env.USER) return `/home/${process.env.USER}`;
  }
  return home;
}

function homePath(...parts) {
  return path.join(userHome(), ...parts);
}

function stateDir() {
  if (process.env.AI_BATTERY_STATE_DIR) return process.env.AI_BATTERY_STATE_DIR;
  if (process.env.CLAUDEX_BATTERY_STATE_DIR) return process.env.CLAUDEX_BATTERY_STATE_DIR;
  if (process.env.XDG_STATE_HOME) return path.join(process.env.XDG_STATE_HOME, "ai-battery");
  return homePath(".local", "state", "ai-battery");
}

function legacyStateDir() {
  if (process.env.XDG_STATE_HOME) return path.join(process.env.XDG_STATE_HOME, "claudex-battery");
  return homePath(".local", "state", "claudex-battery");
}

function claudeCachePath() {
  return path.join(stateDir(), "claude-statusline.json");
}

function claudeSessionCacheDir(root = stateDir()) {
  return path.join(root, "claude-statusline-sessions");
}

function safeCacheName(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
}

function claudeSessionCachePath(sessionId) {
  return path.join(claudeSessionCacheDir(), `${safeCacheName(sessionId)}.json`);
}

function configPath() {
  return path.join(stateDir(), "config.json");
}

function defaultConfig() {
  return {
    version: 1,
    providers: {
      codex: true,
      claude: true
    },
    codexWrapper: null
  };
}

function readConfig() {
  const stored = readJson(configPath()) ?? {};
  const defaults = defaultConfig();
  return {
    ...defaults,
    ...stored,
    providers: {
      ...defaults.providers,
      ...(stored.providers ?? {})
    }
  };
}

function writeConfig(config) {
  writeJsonAtomic(configPath(), config);
}

function providerVisible(provider) {
  const config = readConfig();
  return config.providers?.[provider] !== false;
}

function providerTargets(targets) {
  const requested = targets.length ? targets : ["all"];
  const providers = new Set();
  for (const target of requested) {
    if (target === "all") {
      PROVIDERS.forEach((provider) => providers.add(provider));
    } else if (PROVIDERS.includes(target)) {
      providers.add(target);
    } else {
      throw new Error("target must be one of: codex, claude, all");
    }
  }
  return [...providers];
}

function setProviderVisibility(targets, visible) {
  const providers = providerTargets(targets);
  const config = readConfig();
  for (const provider of providers) {
    config.providers[provider] = visible;
  }
  writeConfig(config);
  return {
    configPath: configPath(),
    providers,
    visible
  };
}

function runningInsideCodex() {
  return Boolean(process.env.CODEX_THREAD_ID || process.env.CODEX_MANAGED_BY_NPM || process.env.CODEX_MANAGED_PACKAGE_ROOT);
}

function runningInsideAiBatteryCodexWrapper() {
  return Boolean(process.env.AI_BATTERY_WRAPPED_CODEX || process.env.AI_BATTERY_ORIGINAL_CODEX);
}

function scriptDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function pathEntries() {
  return (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function samePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

function executableTarget(commandPath) {
  try {
    return fs.realpathSync(commandPath);
  } catch {
    return commandPath;
  }
}

function findCommand(command, skipPaths = []) {
  const names = process.platform === "win32"
    ? [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`]
    : [command];
  const skips = skipPaths.filter(Boolean);

  for (const dir of pathEntries()) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (skips.some((skip) => samePath(candidate, skip))) continue;
      if (safeStat(candidate)?.isFile() && isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function codexWrapperScript(originalCommand) {
  const runner = path.join(scriptDir(), "ai-battery-run");
  return `#!/bin/sh
# ${CODEX_WRAPPER_MARKER}=1
export AI_BATTERY_ORIGINAL_CODEX=${shQuote(originalCommand)}
export AI_BATTERY_WRAPPED_CODEX=1
if [ -t 0 ] && [ -t 1 ]; then
  exec ${shQuote(runner)} --provider all -- ${shQuote(originalCommand)} "$@"
fi
exec ${shQuote(originalCommand)} "$@"
`;
}

function managedCodexWrapper(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").includes(CODEX_WRAPPER_MARKER);
  } catch {
    return false;
  }
}

function shellRcPath() {
  if (process.env.AI_BATTERY_RC) return process.env.AI_BATTERY_RC;
  const shell = path.basename(process.env.SHELL || "");
  if (shell === "zsh") return homePath(".zshrc");
  if (shell === "bash") return homePath(".bashrc");
  if (shell === "fish") return homePath(".config", "fish", "config.fish");
  return homePath(".profile");
}

function shellPathBlock(shimDir) {
  const shell = path.basename(process.env.SHELL || "");
  if (shell === "fish") {
    return `\n# >>> ai-battery setup >>>\nfish_add_path -p ${shQuote(shimDir)}\n# <<< ai-battery setup <<<\n`;
  }
  return `\n# >>> ai-battery setup >>>\nexport PATH=${shQuote(shimDir)}:"$PATH"\n# <<< ai-battery setup <<<\n`;
}

function ensureShimPath(shimDir, originalCommand) {
  const entries = pathEntries();
  const shimIndex = entries.findIndex((entry) => path.resolve(entry) === path.resolve(shimDir));
  const originalDir = path.dirname(originalCommand);
  const originalIndex = entries.findIndex((entry) => path.resolve(entry) === path.resolve(originalDir));
  const activeNow = shimIndex >= 0 && (originalIndex < 0 || shimIndex < originalIndex);
  if (activeNow) {
    return {
      changed: false,
      rcPath: null,
      note: `${shimDir} is already before the original codex on PATH`
    };
  }

  const rcPath = shellRcPath();
  fs.mkdirSync(path.dirname(rcPath), { recursive: true });
  const existing = fs.existsSync(rcPath) ? fs.readFileSync(rcPath, "utf8") : "";
  if (!existing.includes(">>> ai-battery setup >>>")) {
    fs.appendFileSync(rcPath, shellPathBlock(shimDir));
    return {
      changed: true,
      rcPath,
      note: `Added ${shimDir} before PATH in ${rcPath}. Open a new terminal for plain "codex" to use AI Battery.`
    };
  }

  return {
    changed: false,
    rcPath,
    note: `${rcPath} already has an AI Battery PATH block. Open a new terminal if plain "codex" does not use AI Battery yet.`
  };
}

function installCodexWrapper(args) {
  if (process.platform === "win32") {
    return {
      ok: false,
      skipped: true,
      reason: "Codex wrapper uses a POSIX PTY and is not supported on native Windows"
    };
  }

  const shimDir = process.env.AI_BATTERY_SHIM_DIR || homePath(".local", "bin");
  const wrapperPath = path.join(shimDir, "codex");
  const config = readConfig();
  const configuredOriginal = config.codexWrapper?.originalCommand;
  const originalCandidate = configuredOriginal && fs.existsSync(configuredOriginal)
    ? configuredOriginal
    : findCommand("codex", [wrapperPath]);
  const originalCommand = originalCandidate ? executableTarget(originalCandidate) : null;

  if (!originalCommand) {
    return {
      ok: false,
      skipped: true,
      reason: "codex command was not found on PATH"
    };
  }

  fs.mkdirSync(shimDir, { recursive: true, mode: 0o755 });
  if (fs.existsSync(wrapperPath) && !managedCodexWrapper(wrapperPath)) {
    if (!args.force) {
      throw new Error(`${wrapperPath} already exists. Re-run setup with --force to replace it.`);
    }
    fs.renameSync(wrapperPath, `${wrapperPath}.ai-battery-backup-${Date.now()}`);
  }

  fs.writeFileSync(wrapperPath, codexWrapperScript(originalCommand), { mode: 0o755 });

  const pathResult = ensureShimPath(shimDir, originalCommand);
  config.codexWrapper = {
    wrapperPath,
    originalCommand,
    installedAt: new Date().toISOString()
  };
  writeConfig(config);

  return {
    ok: true,
    wrapperPath,
    originalCommand,
    path: pathResult
  };
}

function codexRestartNote() {
  if (!runningInsideCodex() || runningInsideAiBatteryCodexWrapper()) return null;
  return "Current Codex was not started through AI Battery. Exit this Codex session and run plain \"codex\" again from a normal terminal.";
}

function diagnoseCodex() {
  const config = readConfig();
  const configuredWrapper = config.codexWrapper?.wrapperPath || homePath(".local", "bin", "codex");
  const configuredOriginal = config.codexWrapper?.originalCommand || null;
  const activeCodex = findCommand("codex");
  const wrapperInstalled = configuredWrapper ? managedCodexWrapper(configuredWrapper) : false;
  const activeIsWrapper = activeCodex ? managedCodexWrapper(activeCodex) : false;
  const originalExists = configuredOriginal ? fs.existsSync(configuredOriginal) : false;
  const providerEnabled = providerVisible("codex");
  const notes = [];

  if (!providerEnabled) {
    notes.push("Codex provider is hidden. Run: ai-battery on codex");
  }
  if (!wrapperInstalled) {
    notes.push("Codex wrapper is not installed. Run: ai-battery setup codex");
  }
  if (wrapperInstalled && !activeIsWrapper) {
    notes.push("Plain \"codex\" does not resolve to the AI Battery wrapper in this shell. Open a new terminal or put ~/.local/bin before the original codex on PATH.");
  }
  if (configuredOriginal && !originalExists) {
    notes.push(`Original codex path saved by setup no longer exists: ${configuredOriginal}`);
  }
  const restartNote = codexRestartNote();
  if (restartNote) notes.push(restartNote);

  return {
    providerEnabled,
    activeCodex,
    activeIsWrapper,
    wrapperPath: configuredWrapper,
    wrapperInstalled,
    originalCommand: configuredOriginal,
    originalExists: configuredOriginal ? originalExists : null,
    insideCodex: runningInsideCodex(),
    currentCodexWrapped: runningInsideAiBatteryCodexWrapper(),
    notes
  };
}

function runDoctor() {
  return {
    generatedAt: new Date().toISOString(),
    aiBattery: {
      script: fileURLToPath(import.meta.url),
      stateDir: stateDir(),
      configPath: configPath()
    },
    codex: diagnoseCodex(),
    claude: {
      providerEnabled: providerVisible("claude"),
      cachePath: claudeCachePath(),
      statuslineCache: Boolean(readClaudeStatuslineCache())
    }
  };
}

function runSetup(args) {
  const targets = providerTargets(args.targets);
  const results = {};
  if (targets.includes("claude")) {
    results.claude = installClaudeStatusline({ ...args, force: true });
  }
  if (targets.includes("codex")) {
    results.codex = installCodexWrapper(args);
  }
  return results;
}

function runHud(args) {
  const hudPath = path.join(scriptDir(), "ai-battery-hud.js");
  return spawnSync(process.execPath, [hudPath, ...args.rest], {
    stdio: "inherit",
    windowsHide: true
  });
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function listJsonlFiles(root, maxFiles = DEFAULT_MAX_FILES) {
  const files = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const stat = safeStat(fullPath);
        if (stat) {
          files.push({ path: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
        }
      }
    }
  }

  walk(root);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles);
}

function readTail(filePath, bytes = DEFAULT_TAIL_BYTES) {
  const stat = safeStat(filePath);
  if (!stat) return "";

  const length = Math.min(bytes, stat.size);
  const start = Math.max(0, stat.size - length);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function readHead(filePath, bytes = 32 * 1024) {
  const stat = safeStat(filePath);
  if (!stat) return "";

  const length = Math.min(bytes, stat.size);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, 0);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function latestMatchingJsonLine(files, predicate) {
  let fallback = null;

  for (const file of files) {
    const text = readTail(file.path);
    const lines = text.split("\n");

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line || !predicate(line)) continue;

      try {
        const json = JSON.parse(line);
        return { json, file: file.path };
      } catch {
        fallback = fallback || { error: "Found a matching line but could not parse it", file: file.path };
      }
    }
  }

  return fallback;
}

function codexSessionMeta(filePath) {
  const text = readHead(filePath);
  const firstLine = text.split("\n").find((line) => line.includes("\"session_meta\""));
  if (!firstLine) return null;
  try {
    const json = JSON.parse(firstLine);
    return json.type === "session_meta" ? json.payload ?? null : null;
  } catch {
    return null;
  }
}

function sameOrNestedPath(a, b) {
  if (!a || !b) return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

function prioritizeCodexSessionFiles(files) {
  const threadId = process.env.CODEX_THREAD_ID;
  const cwd = (runningInsideAiBatteryCodexWrapper() || runningInsideCodex()) ? process.cwd() : null;
  if (!threadId && !cwd) return files;
  const metaCache = new Map();
  const metaFor = (file) => {
    if (!metaCache.has(file.path)) metaCache.set(file.path, codexSessionMeta(file.path));
    return metaCache.get(file.path);
  };

  return [...files].sort((a, b) => {
    const aThread = threadId && a.path.includes(threadId) ? 1 : 0;
    const bThread = threadId && b.path.includes(threadId) ? 1 : 0;
    if (aThread !== bThread) return bThread - aThread;

    const aCwd = cwd && sameOrNestedPath(metaFor(a)?.cwd, cwd) ? 1 : 0;
    const bCwd = cwd && sameOrNestedPath(metaFor(b)?.cwd, cwd) ? 1 : 0;
    if (aCwd !== bCwd) return bCwd - aCwd;

    return b.mtimeMs - a.mtimeMs;
  });
}

function normalizeLimit(limit, options = {}) {
  if (!limit) return null;

  const usedKey = options.usedKey || "used_percent";
  const remainingKeys = [options.remainingKey].flat().filter(Boolean);
  const windowMinutes = options.windowMinutes ?? limit?.window_minutes ?? null;
  const usedValue = limit?.[usedKey];
  const remainingValue = remainingKeys
    .map((key) => limit?.[key])
    .find((value) => Number.isFinite(value));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const resetPassed = Number.isFinite(limit.resets_at) && limit.resets_at <= nowSeconds;
  const inferResetPassed = options.inferResetPassed !== false;

  if (!Number.isFinite(usedValue) && !Number.isFinite(remainingValue) && !(resetPassed && inferResetPassed)) return null;

  let usedPercent = resetPassed && inferResetPassed
    ? 0
    : Number.isFinite(usedValue)
      ? clamp(Math.round(usedValue), 0, 100)
      : clamp(100 - Math.round(remainingValue), 0, 100);
  let remainingPercent = resetPassed && inferResetPassed
    ? 100
    : Number.isFinite(remainingValue)
      ? clamp(Math.round(remainingValue), 0, 100)
      : clamp(100 - usedPercent, 0, 100);

  return {
    usedPercent,
    remainingPercent,
    windowMinutes,
    resetsAt: limit.resets_at ? new Date(limit.resets_at * 1000).toISOString() : null,
    resetsInSeconds: limit.resets_at ? Math.max(0, limit.resets_at - nowSeconds) : null,
    resetPassed
  };
}

function cacheAgeSeconds(timestamp) {
  if (!timestamp) return null;
  const millis = Date.parse(timestamp);
  if (Number.isNaN(millis)) return null;
  return Math.max(0, Math.floor((Date.now() - millis) / 1000));
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

const SCAN_CACHE_VERSION = 1;

function scanCacheSeconds(defaultSeconds) {
  const raw = Number(process.env.AI_BATTERY_SCAN_CACHE_SECONDS);
  if (Number.isFinite(raw)) return clamp(raw, 0, 60);
  return defaultSeconds;
}

function scanCachePath(name) {
  return path.join(stateDir(), `${name}-scan-cache.json`);
}

function readScanCache(name, maxAgeSeconds) {
  if (maxAgeSeconds <= 0) return null;
  const cached = readJson(scanCachePath(name));
  if (!cached || cached.version !== SCAN_CACHE_VERSION) return null;
  const age = cacheAgeSeconds(cached.capturedAt);
  if (age === null || age > maxAgeSeconds) return null;
  return cached;
}

function writeScanCache(name, value) {
  try {
    writeJsonAtomic(scanCachePath(name), {
      version: SCAN_CACHE_VERSION,
      capturedAt: new Date().toISOString(),
      value: value ?? null
    });
  } catch {
    // Scan caching is best-effort; every reader can rebuild from source logs.
  }
}

function shellArg(value) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function claudeCommandIsBackground(cmdline) {
  return /(^|\s)daemon\s+run(\s|$)/.test(cmdline)
    || cmdline.includes("--bg-pty-host")
    || cmdline.includes("--bg-spare");
}

function commandMatchesProvider(cmdline, provider) {
  if (
    cmdline.includes("ai-battery.js")
    && !cmdline.includes("@openai/codex")
    && !cmdline.includes("@anthropic-ai/claude-code")
    && !cmdline.includes("claude-code")
  ) {
    return false;
  }

  if (provider === "codex") {
    return /(^|\s|[\\/])codex(\.cmd|\.exe)?(\s|$)/i.test(cmdline) || cmdline.includes("@openai/codex");
  }
  if (provider === "claude") {
    if (claudeCommandIsBackground(cmdline)) return false;
    return /(^|\s|[\\/])claude(\.cmd|\.exe)?(\s|$)/i.test(cmdline)
      || cmdline.includes("@anthropic-ai/claude-code")
      || cmdline.includes("claude-code");
  }
  return false;
}

function processHasControllingTty(pid) {
  try {
    const stat = fs.readFileSync(path.join("/proc", String(pid), "stat"), "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const ttyNr = Number(afterComm[4]);
    return Number.isFinite(ttyNr) && ttyNr !== 0;
  } catch {
    return false;
  }
}

function listWindowsProcessCommands() {
  try {
    const output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((cmdline) => ({ cmdline, hasTty: true }));
  } catch {
    return null;
  }
}

function listDarwinProcessCommands() {
  try {
    const output = execFileSync("ps", ["-axo", "tty=,args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
      maxBuffer: 4 * 1024 * 1024
    });
    return output
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        const space = trimmed.indexOf(" ");
        if (space < 0) return null;
        const tty = trimmed.slice(0, space);
        const cmdline = trimmed.slice(space + 1).trim();
        if (!cmdline) return null;
        return { cmdline, hasTty: tty !== "??" && tty !== "-" };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listProcProcessCommands() {
  const procRoot = "/proc";
  let entries;
  try {
    entries = fs.readdirSync(procRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const ownPid = process.pid;
  const commands = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (pid === ownPid) continue;

    let cmdline = "";
    try {
      cmdline = fs.readFileSync(path.join(procRoot, entry.name, "cmdline"), "utf8").replace(/\0/g, " ").trim();
    } catch {
      continue;
    }
    if (!cmdline) continue;
    commands.push({ pid, cmdline });
  }
  return commands;
}

const PROCESS_SCAN_TTL_MS = 2000;
let processScanMemo = null;

function scanProcessCommands() {
  if (processScanMemo && Date.now() - processScanMemo.at < PROCESS_SCAN_TTL_MS) {
    return processScanMemo.commands;
  }

  let commands;
  if (process.platform === "win32") {
    // Spawning PowerShell for the process list is the slow part on Windows, so
    // share one recent scan between the HUD, statusline, and watch invocations.
    const cached = readScanCache("windows-processes", scanCacheSeconds(3));
    if (cached) {
      commands = Array.isArray(cached.value) ? cached.value : [];
    } else {
      commands = listWindowsProcessCommands();
      if (commands === null) {
        commands = readJson(scanCachePath("windows-processes"))?.value ?? [];
      } else {
        writeScanCache("windows-processes", commands);
      }
    }
  } else if (process.platform === "darwin") {
    commands = listDarwinProcessCommands();
  } else {
    commands = listProcProcessCommands();
  }

  processScanMemo = { at: Date.now(), commands };
  return commands;
}

function isProviderRunning(provider) {
  const needsTty = provider === "claude" && process.platform !== "win32";
  return scanProcessCommands().some((proc) => {
    if (!commandMatchesProvider(proc.cmdline, provider)) return false;
    if (!needsTty) return true;
    if (proc.hasTty === undefined) proc.hasTty = processHasControllingTty(proc.pid);
    return proc.hasTty;
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

function claudeLimitFromStatusline(limit, windowMinutes) {
  if (!limit) return null;
  const hasUsedPercentage = Number.isFinite(limit.used_percentage);
  const remainingPercentage = [
    limit.remaining_percentage,
    limit.remaining_percent,
    limit.percent_remaining
  ].find((value) => Number.isFinite(value));
  const hasRemainingPercentage = Number.isFinite(remainingPercentage);
  const hasReset = Number.isFinite(limit.resets_at);
  if (!hasUsedPercentage && !hasRemainingPercentage && !hasReset) return null;
  return {
    ...limit,
    used_percentage: hasUsedPercentage ? limit.used_percentage : null,
    remaining_percentage: hasRemainingPercentage ? remainingPercentage : null,
    resets_at: hasReset ? limit.resets_at : null,
    window_minutes: limit.window_minutes ?? windowMinutes
  };
}

function normalizeClaudeCachedLimit(limit, options = {}) {
  if (!limit) return null;
  return normalizeLimit(limit, {
    usedKey: "used_percentage",
    remainingKey: ["remaining_percentage", "remaining_percent", "percent_remaining"],
    windowMinutes: limit.window_minutes ?? null,
    ...options
  });
}

function claudeTranscriptSessionKind(transcriptPath) {
  if (!transcriptPath) return null;
  const text = readTail(transcriptPath, 256 * 1024);
  if (!text) return null;

  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line || !line.includes("\"sessionKind\"")) continue;
    try {
      const json = JSON.parse(line);
      if (typeof json.sessionKind === "string") return json.sessionKind;
    } catch {
      // Keep scanning older lines.
    }
  }
  return null;
}

function claudeStatuslineSessionKind(inputOrCache) {
  return inputOrCache?.sessionKind
    ?? inputOrCache?.session_kind
    ?? claudeTranscriptSessionKind(inputOrCache?.transcriptPath ?? inputOrCache?.transcript_path);
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join(" ");
}

function claudeLimitWindowFromText(text) {
  const lower = text.toLowerCase();
  if (lower.includes("session limit")) return "fiveHour";
  if (
    lower.includes("weekly limit")
    || lower.includes("fable 5 limit")
    || lower.includes("opus limit")
    || lower.includes("sonnet limit")
  ) {
    return "sevenDay";
  }
  return null;
}

function claudeRateLimitHitFromJson(json, filePath) {
  const text = messageText(json.message);
  const isRateLimit = json?.apiErrorStatus === 429
    || json?.error === "rate_limit"
    || text.includes("You've hit your")
    || text.includes("You've reached your");
  if (!isRateLimit) return null;

  const window = claudeLimitWindowFromText(text);
  if (!window) return null;

  return {
    window,
    timestamp: json.timestamp ?? null,
    source: filePath,
    message: text
  };
}

function scanClaudeRateLimitHit() {
  const files = listJsonlFiles(homePath(".claude", "projects"), CLAUDE_LIMIT_HIT_MAX_FILES);
  // A hit only matters while its 5h/7d window can still be active, so files
  // untouched for longer than the longest window cannot change the result.
  const oldestUsefulMtimeMs = Date.now() - (8 * 24 * 60 * 60 * 1000);
  let fallback = null;

  for (const file of files) {
    if (file.mtimeMs < oldestUsefulMtimeMs) break;
    const text = readTail(file.path, CLAUDE_LIMIT_HIT_TAIL_BYTES);
    const lines = text.split("\n");

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (
        !line
        || (
          !line.includes("\"rate_limit\"")
          && !(line.includes("\"apiErrorStatus\"") && line.includes("429"))
          && !line.includes("You've hit your")
          && !line.includes("You've reached your")
        )
      ) {
        continue;
      }

      try {
        const hit = claudeRateLimitHitFromJson(JSON.parse(line), file.path);
        if (hit) return hit;
      } catch {
        fallback = fallback || {
          error: "Found a Claude rate-limit line but could not parse it",
          source: file.path
        };
      }
    }
  }

  return fallback;
}

let claudeRateLimitHitMemo = null;

function latestClaudeRateLimitHit() {
  if (claudeRateLimitHitMemo && Date.now() - claudeRateLimitHitMemo.at < 5000) {
    return claudeRateLimitHitMemo.value;
  }

  const cached = readScanCache("claude-rate-limit-hit", scanCacheSeconds(10));
  const value = cached ? cached.value ?? null : scanClaudeRateLimitHit();
  if (!cached) writeScanCache("claude-rate-limit-hit", value);
  claudeRateLimitHitMemo = { at: Date.now(), value };
  return value;
}

function applyClaudeRateLimitHit(limit, hit, window) {
  if (!limit || !hit || hit.window !== window || !hit.timestamp) return limit;

  const hitMillis = Date.parse(hit.timestamp);
  const resetMillis = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
  if (Number.isNaN(hitMillis) || Number.isNaN(resetMillis)) return limit;
  if (resetMillis <= Date.now()) return limit;

  const windowMinutes = limit.windowMinutes ?? (window === "fiveHour" ? 300 : 10080);
  const windowStartMillis = resetMillis - (windowMinutes * 60 * 1000);
  if (hitMillis < windowStartMillis || hitMillis > resetMillis) return limit;

  return {
    ...limit,
    usedPercent: 100,
    remainingPercent: 0,
    limitReached: true,
    reachedAt: hit.timestamp,
    reachedSource: hit.source,
    reachedMessage: hit.message
  };
}

function captureClaudeStatusline(input) {
  const rateLimits = input.rate_limits ?? {};
  const sessionId = input.session_id ?? null;
  const previous = (sessionId ? readJson(claudeSessionCachePath(sessionId)) : null) ?? readJson(claudeCachePath());
  const sessionKind = claudeStatuslineSessionKind(input);
  const snapshot = {
    version: 1,
    provider: "claude",
    sourceType: "statusline",
    capturedAt: new Date().toISOString(),
    sessionId,
    promptId: input.prompt_id ?? null,
    transcriptPath: input.transcript_path ?? null,
    sessionKind,
    claudeVersion: input.version ?? null,
    model: {
      id: input.model?.id ?? null,
      displayName: input.model?.display_name ?? null
    },
    rateLimits: {
      fiveHour: claudeLimitFromStatusline(rateLimits.five_hour, 300),
      sevenDay: claudeLimitFromStatusline(rateLimits.seven_day, 10080)
    },
    rawRateLimits: rateLimits,
    contextWindow: input.context_window
      ? {
          usedPercentage: input.context_window.used_percentage ?? null,
          remainingPercentage: input.context_window.remaining_percentage ?? null,
          contextWindowSize: input.context_window.context_window_size ?? null,
          totalInputTokens: input.context_window.total_input_tokens ?? null,
          totalOutputTokens: input.context_window.total_output_tokens ?? null
        }
      : null
  };

  if (previous?.provider === "claude" && previous?.sourceType === "statusline") {
    const sameSession = previous.sessionId && previous.sessionId === snapshot.sessionId;
    if (sameSession && !snapshot.rateLimits.fiveHour) {
      snapshot.rateLimits.fiveHour = previous.rateLimits?.fiveHour ?? null;
    }
    if (sameSession && !snapshot.rateLimits.sevenDay) {
      snapshot.rateLimits.sevenDay = previous.rateLimits?.sevenDay ?? null;
    }
  }

  if (snapshot.sessionId) {
    writeJsonAtomic(claudeSessionCachePath(snapshot.sessionId), snapshot);
  }
  if (sessionKind !== "bg") {
    writeJsonAtomic(claudeCachePath(), snapshot);
  }
  return snapshot;
}

function claudeStatuslineResultFromCache(cache, cachePath, options = {}) {
  if (!cache || cache.provider !== "claude" || cache.sourceType !== "statusline") return null;
  const sessionKind = claudeStatuslineSessionKind(cache);
  if (!options.includeBackground && sessionKind === "bg") return null;

  const primaryBase = normalizeClaudeCachedLimit(cache.rateLimits?.fiveHour);
  const secondaryBase = normalizeClaudeCachedLimit(cache.rateLimits?.sevenDay);
  if (!primaryBase && !secondaryBase) return null;

  const rateLimitHit = latestClaudeRateLimitHit();
  const primary = applyClaudeRateLimitHit(primaryBase, rateLimitHit, "fiveHour");
  const secondary = applyClaudeRateLimitHit(secondaryBase, rateLimitHit, "sevenDay");
  const appliedRateLimitHit = primary?.limitReached || secondary?.limitReached ? rateLimitHit : null;

  return {
    provider: "claude",
    ok: true,
    sourceType: "statusline",
    timestamp: cache.capturedAt ?? null,
    ageSeconds: cacheAgeSeconds(cache.capturedAt ?? null),
    source: cachePath,
    sessionId: cache.sessionId ?? null,
    sessionKind,
    model: cache.model?.displayName || cache.model?.id || null,
    percentRemaining: primary?.remainingPercent ?? secondary?.remainingPercent ?? null,
    percentUsed: primary?.usedPercent ?? secondary?.usedPercent ?? null,
    primary,
    secondary,
    rateLimitHit: appliedRateLimitHit,
    contextWindow: cache.contextWindow ?? null
  };
}

function listClaudeSessionCacheFiles(root = stateDir()) {
  let entries;
  try {
    entries = fs.readdirSync(claudeSessionCacheDir(root), { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const filePath = path.join(claudeSessionCacheDir(root), entry.name);
      const stat = safeStat(filePath);
      return stat ? { path: filePath, mtimeMs: stat.mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 20)
    .map((entry) => entry.path);
}

function readClaudeStatuslineCacheFrom(root) {
  const cachePaths = [
    path.join(root, "claude-statusline.json"),
    ...listClaudeSessionCacheFiles(root)
  ];
  const entries = cachePaths
    .map((cachePath) => ({ cachePath, cache: readJson(cachePath) }))
    .filter((entry) => entry.cache)
    .sort((a, b) => (Date.parse(b.cache.capturedAt ?? "") || 0) - (Date.parse(a.cache.capturedAt ?? "") || 0));

  // Evaluate newest-first and stop at the first usable snapshot so stale or
  // background-session caches do not cost extra transcript reads.
  for (const entry of entries) {
    const result = claudeStatuslineResultFromCache(entry.cache, entry.cachePath);
    if (result) return result;
  }
  return cachePaths.some((cachePath) => fs.existsSync(cachePath)) ? null : undefined;
}

function readClaudeStatuslineCache() {
  const primary = readClaudeStatuslineCacheFrom(stateDir());
  if (primary !== undefined) return primary;

  if (path.resolve(legacyStateDir()) === path.resolve(stateDir())) return null;
  return readClaudeStatuslineCacheFrom(legacyStateDir()) ?? null;
}

function installClaudeStatusline(args) {
  const settingsPath = homePath(".claude", "settings.json");
  const existing = readJson(settingsPath) ?? {};
  const command = `${shellArg(process.execPath)} ${shellArg(fileURLToPath(import.meta.url))} capture-claude --muted --left-padding 1`;

  if (existing.statusLine && !args.force) {
    throw new Error(`Claude statusLine already exists in ${settingsPath}. Re-run with --force to replace it.`);
  }

  const next = {
    ...existing,
    statusLine: {
      type: "command",
      command,
      padding: 0,
      refreshInterval: 5
    }
  };

  writeJsonAtomic(settingsPath, next);
  return {
    settingsPath,
    command
  };
}

function uninstallClaudeStatusline() {
  const settingsPath = homePath(".claude", "settings.json");
  const existing = readJson(settingsPath) ?? {};
  const command = existing.statusLine?.command ?? "";
  const installedByAiBattery = command.includes("ai-battery.js") && command.includes("capture-claude");

  if (!existing.statusLine) {
    return {
      settingsPath,
      changed: false,
      reason: "No Claude statusLine is configured"
    };
  }

  if (!installedByAiBattery) {
    throw new Error(`Claude statusLine exists but does not look like AI Battery's command: ${command}`);
  }

  const next = { ...existing };
  delete next.statusLine;
  writeJsonAtomic(settingsPath, next);
  return {
    settingsPath,
    changed: true
  };
}

function readCodex() {
  const running = isProviderRunning("codex");
  let scan = readScanCache("codex-status", scanCacheSeconds(4))?.value;
  if (!scan || typeof scan !== "object") {
    scan = scanCodexStatus();
    writeScanCache("codex-status", scan);
  }

  const result = { ...scan, running };
  if (result.ok) result.ageSeconds = cacheAgeSeconds(result.timestamp ?? null);
  return result;
}

function scanCodexStatus() {
  const roots = (process.env.CODEX_HOME || homePath(".codex"))
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^~(?=$|\/)/, userHome()));
  const files = prioritizeCodexSessionFiles(roots
    .flatMap((root) => listJsonlFiles(path.join(root, "sessions")))
    .sort((a, b) => b.mtimeMs - a.mtimeMs));

  if (!files.length) {
    return {
      provider: "codex",
      ok: false,
      error: "No Codex session logs found",
      roots
    };
  }

  const match = latestMatchingJsonLine(files, (line) => line.includes("\"rate_limits\""));
  const rateLimits = match?.json?.payload?.rate_limits;

  if (!rateLimits) {
    return {
      provider: "codex",
      ok: false,
      error: "No Codex rate-limit event found in recent logs",
      roots
    };
  }

  // The approval mode lives in turn_context events of the same session, so
  // only that file needs a second look.
  const sessionFiles = files.filter((file) => file.path === match.file);
  const contextMatch = latestMatchingJsonLine(sessionFiles, (line) => line.includes("\"turn_context\""));
  const turnContext = contextMatch?.json?.payload ?? null;
  const approvalPolicy = turnContext?.approval_policy ?? null;
  const sandboxMode = turnContext?.sandbox_policy?.type ?? null;
  const collaborationMode = turnContext?.collaboration_mode?.mode ?? null;

  const primary = normalizeLimit(rateLimits.primary);
  const secondary = normalizeLimit(rateLimits.secondary);

  return {
    provider: "codex",
    ok: true,
    planType: rateLimits.plan_type ?? null,
    limitId: rateLimits.limit_id ?? null,
    timestamp: match.json.timestamp ?? null,
    source: match.file,
    percentRemaining: primary?.remainingPercent ?? null,
    percentUsed: primary?.usedPercent ?? null,
    primary,
    secondary,
    approvalPolicy,
    sandboxMode,
    collaborationMode,
    mode: codexModeLabel(approvalPolicy, sandboxMode, collaborationMode),
    reachedType: rateLimits.rate_limit_reached_type ?? null
  };
}

function codexModeLabel(approvalPolicy, sandboxMode, collaborationMode) {
  // Mirror Claude's own indicator: label only noteworthy states and stay
  // quiet in the default ask-before-running mode. Approvals (whether Codex
  // asks) and sandbox (what it may touch) are separate axes; "auto" strictly
  // means approvals are off. Values come from the last turn_context, so a
  // mid-session switch shows up after the next message.
  if (collaborationMode === "plan") return "plan";
  if (sandboxMode === "danger-full-access") return "full access";
  if (sandboxMode === "read-only") return "read only";
  if (approvalPolicy === "never" || approvalPolicy === "on-failure") return "auto";
  return null;
}

function usageTotal(usage) {
  if (!usage) return 0;
  return [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens
  ].reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function readClaude() {
  const running = isProviderRunning("claude");
  const statuslineCache = readClaudeStatuslineCache();
  if (statuslineCache) return { ...statuslineCache, running };

  const root = homePath(".claude", "projects");
  const files = listJsonlFiles(root);
  const statsPath = homePath(".claude", "stats-cache.json");

  if (!files.length) {
    return {
      provider: "claude",
      ok: false,
      running,
      error: "No Claude Code project logs found",
      root
    };
  }

  const match = latestMatchingJsonLine(files, (line) => line.includes("\"usage\""));
  const message = match?.json?.message;
  const usage = message?.usage;

  if (!usage) {
    return {
      provider: "claude",
      ok: false,
      running,
      error: "No Claude usage event found in recent logs",
      root
    };
  }

  let stats = null;
  try {
    stats = JSON.parse(fs.readFileSync(statsPath, "utf8"));
  } catch {
    stats = null;
  }

  return {
    provider: "claude",
    ok: true,
    running,
    timestamp: match.json.timestamp ?? null,
    source: match.file,
    model: message.model ?? null,
    percentRemaining: null,
    percentUsed: null,
    note: "Claude Code local logs do not expose a remaining subscription percentage",
    lastTurnTokens: usageTotal(usage),
    lastTurn: {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      serviceTier: usage.service_tier ?? null
    },
    stats: stats
      ? {
          lastComputedDate: stats.lastComputedDate ?? null,
          totalSessions: stats.totalSessions ?? null,
          totalMessages: stats.totalMessages ?? null
        }
      : null
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function colorize(text, color, style) {
  if (style === "plain") return text;
  if (style === "muted") {
    // Muted style dims the status text, but the battery bar keeps its
    // green/orange/red charge color so the level reads at a glance.
    const mutedColorCodes = {
      white: 97,
      green: 32,
      orange: "38;5;208",
      red: 31
    };
    const code = mutedColorCodes[color] ?? 90;
    return `\u001b[${code}m${text}\u001b[0m`;
  }
  const codes = {
    white: 37,
    green: 32,
    orange: "38;5;208",
    red: 31,
    gray: 90,
    cyan: 36
  };
  const tmuxColors = {
    white: "white",
    green: "green",
    orange: "colour208",
    red: "red",
    gray: "colour244",
    cyan: "cyan"
  };
  if (style === "tmux") return `#[fg=${tmuxColors[color] || "default"}]${text}#[default]`;
  return `\u001b[${codes[color] || 0}m${text}\u001b[0m`;
}

function remainingColor(percent) {
  if (percent <= 20) return "red";
  if (percent <= 40) return "orange";
  return "green";
}

function activityColor(data) {
  return data?.running ? "white" : "gray";
}

function statusColorize(data, text, args) {
  return colorize(text, activityColor(data), args.style);
}

function bar(percent, width) {
  if (typeof percent !== "number") return "─".repeat(width);

  // Whole cells only: eighth-width partial blocks (▏▎▍…) leave the rest of
  // their cell as bare background, which reads as a hole between the solid
  // fill and the ░ shade, and they render inconsistently across terminal
  // fonts. Rounding keeps both provider bars visually identical in style.
  const exact = (clamp(percent, 0, 100) / 100) * width;
  let full = Math.round(exact);
  if (percent > 0 && full === 0) full = 1;
  return `${"█".repeat(full)}${"░".repeat(width - full)}`;
}

function duration(seconds) {
  if (typeof seconds !== "number") return "?";
  if (seconds <= 0) return "now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 48) return restMinutes ? `${hours}h${restMinutes}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d${restHours}h` : `${days}d`;
}

function shortWindow(minutes) {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "7d";
  if (!minutes) return "?";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function resetClock(limit) {
  if (!limit?.resetsAt || limit.resetPassed) return "--:--";
  const date = new Date(limit.resetsAt);
  if (Number.isNaN(date.getTime())) return "--:--";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function stripAnsi(text) {
  return String(text).replace(ANSI_RE, "");
}

function charWidth(char) {
  const code = char.codePointAt(0);
  if (
    (code >= 0x0300 && code <= 0x036f)
    || (code >= 0x1ab0 && code <= 0x1aff)
    || (code >= 0x1dc0 && code <= 0x1dff)
    || (code >= 0x20d0 && code <= 0x20ff)
    || (code >= 0xfe20 && code <= 0xfe2f)
  ) {
    return 0;
  }
  if (
    (code >= 0x1100 && code <= 0x115f)
    || code === 0x2329
    || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

function visibleWidth(text) {
  return Array.from(stripAnsi(text)).reduce((width, char) => width + charWidth(char), 0);
}

function takeVisibleStart(text, maxWidth) {
  let width = 0;
  let output = "";
  for (const char of Array.from(text)) {
    const nextWidth = width + charWidth(char);
    if (nextWidth > maxWidth) break;
    output += char;
    width = nextWidth;
  }
  return output;
}

function takeVisibleEnd(text, maxWidth) {
  let width = 0;
  let output = "";
  for (const char of Array.from(text).reverse()) {
    const nextWidth = width + charWidth(char);
    if (nextWidth > maxWidth) break;
    output = char + output;
    width = nextWidth;
  }
  return output;
}

function truncateMiddleVisible(text, maxWidth) {
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth <= 0) return "";
  if (maxWidth === 1) return "…";

  const marker = "…";
  const budget = maxWidth - visibleWidth(marker);
  const startWidth = Math.ceil(budget * 0.55);
  const endWidth = Math.max(0, budget - startWidth);
  return `${takeVisibleStart(text, startWidth)}${marker}${takeVisibleEnd(text, endWidth)}`;
}

function numericColumn(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const columns = Math.floor(number);
  if (columns < 20) return null;
  return clamp(columns, 20, 500);
}

function numericGuard(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return clamp(Math.floor(number), 0, 20);
}

function statusLineColumns(input) {
  const candidates = [
    process.env.AI_BATTERY_COLUMNS,
    process.env.CLAUDEX_BATTERY_COLUMNS,
    input.terminal?.columns,
    input.terminal?.cols,
    input.terminal?.width,
    input.terminal_columns,
    input.terminal_width,
    input.columns,
    input.width,
    process.env.COLUMNS,
    process.stdout.columns
  ];

  for (const candidate of candidates) {
    const columns = numericColumn(candidate);
    if (columns) return columns;
  }
  return 80;
}

function statusLineUsableColumns(input) {
  const guard = numericGuard(process.env.AI_BATTERY_COLUMN_GUARD)
    ?? numericGuard(process.env.CLAUDEX_BATTERY_COLUMN_GUARD)
    ?? DEFAULT_STATUSLINE_COLUMN_GUARD;
  return Math.max(20, statusLineColumns(input) - guard);
}

function contextRemainingPercent(input) {
  const context = input.context_window ?? input.contextWindow ?? null;
  const remaining = context?.remaining_percentage ?? context?.remainingPercentage;
  if (typeof remaining === "number") return clamp(Math.round(remaining), 0, 100);

  const used = context?.used_percentage ?? context?.usedPercentage;
  if (typeof used === "number") return clamp(100 - Math.round(used), 0, 100);
  return null;
}

function contextLeftText(input) {
  const remaining = contextRemainingPercent(input);
  if (remaining === null) return null;
  return `${remaining}% context left`;
}

function alignHeader(left, right, columns) {
  if (!right) return left;

  const gap = 2;
  const rightWidth = visibleWidth(right);
  if (!columns || columns <= rightWidth + gap) return `${left} ${right}`;

  const leftBudget = columns - rightWidth - gap;
  const fittedLeft = truncateMiddleVisible(left, leftBudget);
  const spaces = Math.max(gap, columns - visibleWidth(fittedLeft) - rightWidth);
  return `${fittedLeft}${" ".repeat(spaces)}${right}`;
}

function displayPath(dir) {
  if (!dir) return "~";
  const home = userHome();
  if (dir === home) return "~";
  if (dir.startsWith(`${home}/`)) return `~/${path.relative(home, dir)}`;
  return dir;
}

function gitBranchFromDir(dir) {
  if (!dir) return null;
  try {
    const branch = execFileSync("git", ["-C", dir, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

function statuslineGitBranch(input) {
  const explicit = input.git?.branch
    || input.git_branch
    || input.workspace?.git_branch
    || input.workspace?.git?.branch
    || null;
  if (explicit) return explicit;

  const dirs = [
    input.workspace?.current_dir,
    input.cwd,
    input.workspace?.project_dir
  ].filter(Boolean);

  for (const dir of dirs) {
    const branch = gitBranchFromDir(dir);
    if (branch) return branch;
  }
  return null;
}

function claudeHeader(input, args) {
  const model = input.model?.display_name || input.model?.id || "Claude";
  const effort = input.effort?.level || null;
  const workspaceRoot = input.workspace?.project_dir || input.cwd || input.workspace?.current_dir || "";
  const gitBranch = statuslineGitBranch(input);
  const parts = [model];
  if (effort) parts.push(effort);
  parts.push("·");
  parts.push(displayPath(workspaceRoot));
  if (gitBranch) {
    parts.push("·");
    parts.push(gitBranch);
  }
  const left = parts.join(" ");
  const right = contextLeftText(input);
  const columns = Math.max(20, statusLineUsableColumns(input) - (args.leftPadding || 0));
  const header = alignHeader(left, right, columns);
  return statusColorize({ running: false }, header, args);
}

function limitResetText(limit) {
  if (!limit) return null;
  const label = shortWindow(limit.windowMinutes);
  return `${label} ${resetClock(limit)}`.padEnd(8, " ");
}

function ageText(seconds) {
  if (typeof seconds !== "number" || seconds < 60) return null;
  return `seen ${duration(seconds)} ago`;
}

function divider(args) {
  return colorize(DIVIDER, "gray", args.style);
}

function weekText(secondary) {
  const label = shortWindow(secondary.windowMinutes);
  let text = `${label} ${secondary.remainingPercent}%`;
  if (secondary.remainingPercent <= 10 && !secondary.resetPassed) {
    text += ` ${resetClock(secondary)}`;
  }
  return text;
}

function formatCodex(data, args) {
  if (!data.ok) return statusColorize(data, `Codex ? (${data.error})`, args);

  const batteryColor = remainingColor(data.percentRemaining);
  const primary = data.primary;
  const secondary = data.secondary;
  const bits = [
    `${statusColorize(data, "Codex ", args)}${colorize(bar(data.percentRemaining, args.barWidth), batteryColor, args.style)}${statusColorize(data, ` ${data.percentRemaining}%`, args)}`
  ];

  const primaryReset = limitResetText(primary);
  if (primaryReset) {
    bits.push(divider(args));
    bits.push(statusColorize(data, primaryReset, args));
  }
  if (secondary) {
    bits.push(divider(args));
    bits.push(statusColorize(data, weekText(secondary), args));
  }
  if (data.reachedType) {
    bits.push(statusColorize(data, `limit ${data.reachedType}`, args));
  }
  if (args.showPaths) {
    const seen = ageText(data.ageSeconds);
    if (seen) bits.push(statusColorize(data, seen, args));
    bits.push(statusColorize(data, data.source, args));
  }

  return bits.join(" ");
}

function formatClaude(data, args) {
  if (!data.ok) return statusColorize(data, `Claude ? (${data.error})`, args);

  if (data.sourceType === "statusline") {
    const batteryColor = remainingColor(data.percentRemaining);
    const bits = [
      `${statusColorize(data, "Claude ", args)}${colorize(bar(data.percentRemaining, args.barWidth), batteryColor, args.style)}${statusColorize(data, ` ${data.percentRemaining}%`, args)}`
    ];
    const primaryReset = limitResetText(data.primary);
    if (primaryReset) {
      bits.push(divider(args));
      bits.push(statusColorize(data, primaryReset, args));
    }
    if (data.secondary) {
      bits.push(divider(args));
      bits.push(statusColorize(data, weekText(data.secondary), args));
    }
    if (args.showPaths) {
      const seen = ageText(data.ageSeconds);
      if (seen) bits.push(statusColorize(data, seen, args));
      bits.push(statusColorize(data, data.source, args));
    }
    return bits.join(" ");
  }

  const bits = [
    `${statusColorize(data, "Claude ", args)}${colorize(bar(null, args.barWidth), "gray", args.style)}${statusColorize(data, " --%", args)}`,
    divider(args),
    statusColorize(data, "5h --:--", args),
    divider(args),
    statusColorize(data, "7d ---%", args)
  ];

  if (args.showPaths) bits.push(statusColorize(data, data.source, args));
  return bits.join(" ");
}

function compactNumber(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}k`;
  return String(number);
}

function collect(args) {
  const results = [];
  const includeHidden = args.provider !== "all";
  if ((args.provider === "all" || args.provider === "codex") && (includeHidden || providerVisible("codex"))) {
    results.push(readCodex());
  }
  if ((args.provider === "all" || args.provider === "claude") && (includeHidden || providerVisible("claude"))) {
    results.push(readClaude());
  }
  return {
    generatedAt: new Date().toISOString(),
    results
  };
}

function renderLine(snapshot, args) {
  const providerDivider = `  ${colorize(PROVIDER_DIVIDER, "gray", args.style)}  `;
  return snapshot.results
    .map((result) => {
      if (result.provider === "codex") return formatCodex(result, args);
      if (result.provider === "claude") return formatClaude(result, args);
      return `${result.provider} ?`;
    })
    .join(providerDivider);
}

function applyLeftPadding(output, args) {
  const padding = Math.max(0, Number(args.leftPadding) || 0);
  if (!padding) return output;
  const prefix = " ".repeat(padding);
  return String(output)
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function render(snapshot, args) {
  if (args.json) return JSON.stringify(snapshot, null, 2);

  const maxWidth = args.maxWidth
    ? Math.max(20, args.maxWidth - (Number(args.leftPadding) || 0))
    : null;

  if (args.maxWidth) {
    for (let width = args.barWidth; width >= 4; width -= 1) {
      const trialArgs = { ...args, barWidth: width };
      const line = renderLine(snapshot, trialArgs);
      if (visibleWidth(line) <= maxWidth || width === 4) return applyLeftPadding(line, args);
    }
  }

  return applyLeftPadding(renderLine(snapshot, args), args);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.command === "setup") {
    const result = runSetup(args);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.claude) {
        console.log(`Claude statusLine installed: ${result.claude.settingsPath}`);
      }
      if (result.codex?.ok) {
        console.log(`Codex wrapper installed: ${result.codex.wrapperPath}`);
        console.log(`Original codex: ${result.codex.originalCommand}`);
        if (result.codex.path?.note) console.log(result.codex.path.note);
      } else if (result.codex?.skipped) {
        console.log(`Codex wrapper skipped: ${result.codex.reason}`);
      }
      const note = codexRestartNote();
      if (result.codex && note) console.log(note);
    }
    return;
  }

  if (args.command === "doctor") {
    const result = runDoctor();
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`AI Battery: ${result.aiBattery.script}`);
      console.log(`State: ${result.aiBattery.stateDir}`);
      console.log("");
      console.log(`Codex provider: ${result.codex.providerEnabled ? "on" : "off"}`);
      console.log(`Codex on PATH: ${result.codex.activeCodex || "not found"}`);
      console.log(`Codex wrapper: ${result.codex.wrapperInstalled ? "installed" : "missing"} (${result.codex.wrapperPath})`);
      console.log(`PATH uses wrapper: ${result.codex.activeIsWrapper ? "yes" : "no"}`);
      console.log(`Inside Codex: ${result.codex.insideCodex ? "yes" : "no"}`);
      console.log(`Current Codex wrapped: ${result.codex.currentCodexWrapped ? "yes" : "no"}`);
      if (result.codex.notes.length) {
        console.log("");
        for (const note of result.codex.notes) console.log(`- ${note}`);
      }
      console.log("");
      console.log(`Claude provider: ${result.claude.providerEnabled ? "on" : "off"}`);
      console.log(`Claude statusLine cache: ${result.claude.statuslineCache ? "found" : "missing"}`);
    }
    return;
  }

  if (args.command === "hud") {
    const result = runHud(args);
    process.exit(result.status ?? 0);
  }

  if (args.command === "on" || args.command === "off") {
    const visible = args.command === "on";
    const result = setProviderVisibility(args.targets, visible);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const state = visible ? "on" : "off";
      console.log(`${result.providers.join(", ")} ${state}`);
      console.log(`Updated ${result.configPath}`);
      const note = visible && result.providers.includes("codex") ? codexRestartNote() : null;
      if (note) console.log(note);
    }
    return;
  }

  if (args.command === "install-claude-statusline") {
    const result = installClaudeStatusline(args);
    if (!args.json) {
      console.log(`Installed Claude statusLine: ${result.command}`);
      console.log(`Updated ${result.settingsPath}`);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  if (args.command === "uninstall-claude-statusline") {
    const result = uninstallClaudeStatusline();
    if (!args.json) {
      if (result.changed) {
        console.log(`Removed Claude statusLine from ${result.settingsPath}`);
      } else {
        console.log(`${result.reason}: ${result.settingsPath}`);
      }
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  if (args.command === "capture-claude") {
    const inputText = await readStdin();
    if (!inputText.trim()) throw new Error("capture-claude expected Claude statusline JSON on stdin");
    const input = JSON.parse(inputText);
    const capturedClaude = captureClaudeStatusline(input);
    if (!args.silent) {
      const results = [];
      if (providerVisible("codex")) results.push(readCodex());
      if (providerVisible("claude")) {
        const capturedSource = capturedClaude.sessionKind === "bg" && capturedClaude.sessionId
          ? claudeSessionCachePath(capturedClaude.sessionId)
          : claudeCachePath();
        const claudeData = claudeStatuslineResultFromCache(capturedClaude, capturedSource, { includeBackground: true }) ?? readClaude();
        results.push({ ...claudeData, running: true });
      }
      const header = args.header ? applyLeftPadding(claudeHeader(input, args), args) : "";
      const usage = render({
        generatedAt: new Date().toISOString(),
        results
      }, { ...args, activeProvider: "claude", maxWidth: statusLineUsableColumns(input) });
      console.log(header && usage ? `${header}\n${usage}` : (usage || header));
    }
    return;
  }

  const watchTty = args.watch && process.stdout.isTTY;
  let lastFrame = null;

  const draw = () => {
    let renderArgs = args;
    if (watchTty && !args.maxWidth && Number.isFinite(process.stdout.columns)) {
      // Keep the line inside the terminal so the single-line repaint never
      // wraps and leaves residue rows behind.
      renderArgs = { ...args, maxWidth: Math.max(20, process.stdout.columns - 1) };
    }
    const output = render(collect(args), renderArgs);
    if (watchTty) {
      if (output === lastFrame) return;
      lastFrame = output;
      process.stdout.write("\u001b[2K\r");
      process.stdout.write(output);
    } else {
      console.log(output);
    }
  };

  draw();

  if (args.watch) {
    setInterval(draw, args.interval * 1000);
    if (watchTty) {
      process.stdout.on("resize", () => {
        lastFrame = null;
        draw();
      });
    }
  }
}

main().catch((error) => {
  console.error(`ai-battery: ${error.message}`);
  process.exit(1);
});
