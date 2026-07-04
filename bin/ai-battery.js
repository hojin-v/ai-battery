#!/usr/bin/env node

import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  "teardown",
  "uninstall",
  "doctor",
  "hud",
  "on",
  "off",
  "capture-claude",
  "install-claude-statusline",
  "uninstall-claude-statusline"
]);
const PROVIDERS = ["codex", "claude"];
const TEARDOWN_TARGETS = ["codex", "claude", "hud"];
const CODEX_WRAPPER_MARKER = "AI_BATTERY_MANAGED_CODEX_WRAPPER";
const CODEX_PREFERRED_BACKUP_SUFFIX = ".ai-battery-original-link";
const CODEX_TIMESTAMP_BACKUP_MARKER = ".ai-battery-backup-";
const DEFAULT_STATUSLINE_HEADER_COLUMN_GUARD = 2;

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
    menuBar: false,
    silent: false,
    force: false,
    header: true,
    help: false,
    version: false,
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
    } else if (!arg.startsWith("-") && ["setup", "teardown", "uninstall", "on", "off"].includes(args.command)) {
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
    } else if (arg === "--menu-bar") {
      args.menuBar = true;
      args.style = "plain";
    } else if (arg === "--version" || arg === "-v") {
      args.version = true;
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
  ai-battery uninstall [codex|claude|hud|all]
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
      --menu-bar                   Print compact macOS menu bar text
      --tmux                       Emit tmux status-line color markup
      --force                      Replace an existing Claude statusLine
      --no-color                   Disable ANSI colors
  -v, --version                    Show ai-battery version
  -h, --help                       Show this help

Compatibility:
  ai-battery install-claude-statusline [--force]
  ai-battery uninstall-claude-statusline
  ai-battery teardown [codex|claude|hud|all]
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

function dataDir() {
  if (process.env.AI_BATTERY_DATA_DIR) return process.env.AI_BATTERY_DATA_DIR;
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "ai-battery");
  return homePath(".local", "share", "ai-battery");
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
    codexWrapper: null,
    claudeStatusLineBackup: null
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

function teardownTargets(targets) {
  const requested = targets.length ? targets : ["all"];
  const selected = new Set();
  for (const target of requested) {
    if (target === "all") {
      TEARDOWN_TARGETS.forEach((item) => selected.add(item));
    } else if (TEARDOWN_TARGETS.includes(target)) {
      selected.add(target);
    } else {
      throw new Error("target must be one of: codex, claude, hud, all");
    }
  }
  return [...selected];
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

function packageInfo() {
  const pkg = readJson(path.join(scriptDir(), "..", "package.json")) ?? {};
  return {
    name: pkg.name || "ai-battery",
    version: pkg.version || "0.0.0"
  };
}

function npmRegistryPackageUrl(name) {
  const encoded = String(name)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("%2F");
  return `https://registry.npmjs.org/${encoded}/latest`;
}

function compareVersions(left, right) {
  const parse = (value) => {
    const [main, prerelease = ""] = String(value || "0.0.0").replace(/^v/, "").split("-", 2);
    return {
      parts: main.split(".").map((part) => Number.parseInt(part, 10) || 0),
      prerelease
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i += 1) {
    const diff = (a.parts[i] || 0) - (b.parts[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease === b.prerelease) return 0;
  return a.prerelease > b.prerelease ? 1 : -1;
}

function fetchJson(url, timeoutMs = 1800, redirectsLeft = 2) {
  return new Promise((resolve) => {
    const request = https.get(url, {
      headers: {
        Accept: "application/vnd.npm.install-v1+json, application/json",
        "User-Agent": "ai-battery"
      }
    }, (response) => {
      const location = response.headers.location;
      if (
        location
        && response.statusCode >= 300
        && response.statusCode < 400
        && redirectsLeft > 0
      ) {
        response.resume();
        const nextUrl = new URL(location, url).toString();
        fetchJson(nextUrl, timeoutMs, redirectsLeft - 1).then(resolve);
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) request.destroy(new Error("response too large"));
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          resolve({ ok: false, error: `HTTP ${response.statusCode}` });
          return;
        }
        try {
          resolve({ ok: true, value: JSON.parse(body) });
        } catch {
          resolve({ ok: false, error: "invalid JSON from npm registry" });
        }
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", (error) => {
      resolve({ ok: false, error: error.message || String(error) });
    });
  });
}

async function checkPackageVersion() {
  const current = packageInfo();
  const checkedAt = new Date().toISOString();
  if (process.env.AI_BATTERY_NO_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER) {
    return {
      name: current.name,
      current: current.version,
      latest: null,
      updateAvailable: false,
      checked: false,
      checkedAt,
      error: "disabled"
    };
  }

  const result = await fetchJson(npmRegistryPackageUrl(current.name));
  if (!result.ok) {
    return {
      name: current.name,
      current: current.version,
      latest: null,
      updateAvailable: false,
      checked: false,
      checkedAt,
      error: result.error
    };
  }

  const latest = result.value?.version ?? null;
  const comparison = latest ? compareVersions(latest, current.version) : 0;
  return {
    name: current.name,
    current: current.version,
    latest,
    updateAvailable: comparison > 0,
    checked: Boolean(latest),
    checkedAt,
    error: latest ? null : "npm registry response did not include a version"
  };
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
if [ -t 0 ] && [ -t 1 ] && [ -x ${shQuote(runner)} ]; then
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

function defaultCodexShimDir() {
  return path.join(dataDir(), "bin");
}

function legacyCodexWrapperPath() {
  return homePath(".local", "bin", "codex");
}

function legacyCodexShimDir() {
  return path.dirname(legacyCodexWrapperPath());
}

function pathIndexForDir(dir) {
  return pathEntries().findIndex((entry) => path.resolve(entry) === path.resolve(dir));
}

function pathDirPrecedesOriginal(dir, originalCommand) {
  const shimIndex = pathIndexForDir(dir);
  if (shimIndex < 0) return false;
  const originalIndex = pathIndexForDir(path.dirname(originalCommand));
  return originalIndex < 0 || shimIndex < originalIndex;
}

function codexInstallSkipPaths(config = readConfig()) {
  return uniquePaths([
    config.codexWrapper?.wrapperPath,
    process.env.AI_BATTERY_SHIM_DIR ? path.join(process.env.AI_BATTERY_SHIM_DIR, "codex") : null,
    path.join(defaultCodexShimDir(), "codex"),
    legacyCodexWrapperPath()
  ]);
}

function canUseCodexShimTarget(wrapperPath, originalCommand) {
  if (samePath(wrapperPath, originalCommand)) return false;
  if (!fs.existsSync(wrapperPath)) return true;
  return managedCodexWrapper(wrapperPath);
}

function selectCodexShimDir(originalCommand, pathCommand = originalCommand) {
  if (process.env.AI_BATTERY_SHIM_DIR) {
    return {
      shimDir: process.env.AI_BATTERY_SHIM_DIR,
      immediate: pathDirPrecedesOriginal(process.env.AI_BATTERY_SHIM_DIR, pathCommand),
      reason: "AI_BATTERY_SHIM_DIR"
    };
  }

  const legacyDir = legacyCodexShimDir();
  const legacyWrapper = path.join(legacyDir, "codex");
  if (
    pathDirPrecedesOriginal(legacyDir, pathCommand)
    && canUseCodexShimTarget(legacyWrapper, originalCommand)
  ) {
    return {
      shimDir: legacyDir,
      immediate: true,
      reason: `${legacyDir} is already before the original codex on PATH`
    };
  }

  const shimDir = defaultCodexShimDir();
  return {
    shimDir,
    immediate: pathDirPrecedesOriginal(shimDir, pathCommand),
    reason: "AI Battery-owned data directory"
  };
}

function findOriginalCodexCommand(skipPaths = []) {
  const skips = skipPaths.filter(Boolean);
  for (const dir of pathEntries()) {
    const candidate = path.join(dir, "codex");
    if (skips.some((skip) => samePath(candidate, skip))) continue;
    if (!safeStat(candidate)?.isFile() || !isExecutable(candidate)) continue;
    if (managedCodexWrapper(candidate)) continue;
    return candidate;
  }
  return null;
}

function shellRcPath() {
  if (process.env.AI_BATTERY_RC) return process.env.AI_BATTERY_RC;
  const shell = path.basename(process.env.SHELL || "");
  if (shell === "zsh") return homePath(".zshrc");
  if (shell === "bash" && process.platform === "darwin") return homePath(".bash_profile");
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

function removeAiBatteryShellPathBlock(text) {
  return String(text).replace(
    /(\r?\n)?# >>> ai-battery setup >>>\r?\n[\s\S]*?# <<< ai-battery setup <<<(?:\r?\n)?/g,
    (match, leadingNewline, offset) => (offset === 0 ? "" : (leadingNewline || "\n"))
  );
}

function uniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const filePath of paths.filter(Boolean)) {
    const key = path.resolve(filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(filePath);
  }
  return result;
}

function shellRcCandidates() {
  return uniquePaths([
    process.env.AI_BATTERY_RC,
    shellRcPath(),
    homePath(".zshrc"),
    homePath(".bashrc"),
    homePath(".bash_profile"),
    homePath(".profile"),
    homePath(".config", "fish", "config.fish")
  ]);
}

function removeShellPathBlocks() {
  const changed = [];
  for (const rcPath of shellRcCandidates()) {
    if (!fs.existsSync(rcPath)) continue;
    const existing = fs.readFileSync(rcPath, "utf8");
    const next = removeAiBatteryShellPathBlock(existing);
    if (next === existing) continue;
    fs.writeFileSync(rcPath, next, "utf8");
    changed.push(rcPath);
  }
  return changed;
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
      note: `${shimDir} is already before the original codex on PATH. Plain "codex" can use AI Battery in new command lookups. If this shell already cached codex, run "hash -r" once.`
    };
  }

  const rcPath = shellRcPath();
  fs.mkdirSync(path.dirname(rcPath), { recursive: true });
  const existing = fs.existsSync(rcPath) ? fs.readFileSync(rcPath, "utf8") : "";
  const withoutAiBatteryBlock = removeAiBatteryShellPathBlock(existing);
  const separator = withoutAiBatteryBlock && !withoutAiBatteryBlock.endsWith("\n") ? "\n" : "";
  const next = `${withoutAiBatteryBlock}${separator}${shellPathBlock(shimDir)}`;
  fs.writeFileSync(rcPath, next, "utf8");

  return {
    changed: true,
    rcPath,
    note: `${existing === withoutAiBatteryBlock ? "Added" : "Updated"} ${shimDir} before PATH in ${rcPath}. Open a new terminal for plain "codex" to use AI Battery.`
  };
}

function codexWrapperCandidates(config = readConfig()) {
  const activeCodex = findCommand("codex");
  return uniquePaths([
    config.codexWrapper?.wrapperPath,
    process.env.AI_BATTERY_SHIM_DIR ? path.join(process.env.AI_BATTERY_SHIM_DIR, "codex") : null,
    path.join(defaultCodexShimDir(), "codex"),
    legacyCodexWrapperPath(),
    activeCodex && managedCodexWrapper(activeCodex) ? activeCodex : null
  ]);
}

function codexTimestampBackups(wrapperPath) {
  const dir = path.dirname(wrapperPath);
  const prefix = `${path.basename(wrapperPath)}${CODEX_TIMESTAMP_BACKUP_MARKER}`;
  try {
    return fs.readdirSync(dir)
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => path.join(dir, entry))
      .filter((entryPath) => fs.existsSync(entryPath))
      .sort((left, right) => {
        const leftStat = safeStat(left);
        const rightStat = safeStat(right);
        return (rightStat?.mtimeMs ?? 0) - (leftStat?.mtimeMs ?? 0);
      });
  } catch {
    return [];
  }
}

function codexWrapperBackupCandidates(wrapperPath, config = readConfig()) {
  return uniquePaths([
    config.codexWrapper?.wrapperPath === wrapperPath ? config.codexWrapper?.backupPath : null,
    `${wrapperPath}${CODEX_PREFERRED_BACKUP_SUFFIX}`,
    ...codexTimestampBackups(wrapperPath)
  ]);
}

function existingCodexWrapperBackup(wrapperPath, config = readConfig()) {
  return codexWrapperBackupCandidates(wrapperPath, config).find((backupPath) => fs.existsSync(backupPath)) || null;
}

function nextCodexBackupPath(wrapperPath) {
  const preferred = `${wrapperPath}${CODEX_PREFERRED_BACKUP_SUFFIX}`;
  if (!fs.existsSync(preferred)) return preferred;
  return `${wrapperPath}${CODEX_TIMESTAMP_BACKUP_MARKER}${Date.now()}`;
}

function sameOrInsidePath(childPath, parentPath) {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function canRemoveCodexWrapperWithoutBackup(wrapperPath, config = readConfig()) {
  if (sameOrInsidePath(wrapperPath, defaultCodexShimDir())) return true;
  if (samePath(wrapperPath, legacyCodexWrapperPath())) return true;
  const configuredWrapper = config.codexWrapper?.wrapperPath;
  if (
    configuredWrapper
    && samePath(wrapperPath, configuredWrapper)
    && sameOrInsidePath(wrapperPath, dataDir())
  ) {
    return true;
  }
  return false;
}

function removeOrRestoreCodexWrapper(wrapperPath, config) {
  const backupPath = existingCodexWrapperBackup(wrapperPath, config);
  if (!backupPath && !canRemoveCodexWrapperWithoutBackup(wrapperPath, config)) {
    return {
      wrapperPath,
      restoredFrom: null,
      skipped: true,
      reason: "Managed wrapper is outside AI Battery-owned paths and no backup is available for restore"
    };
  }
  fs.rmSync(wrapperPath, { force: true });
  if (backupPath) {
    fs.renameSync(backupPath, wrapperPath);
    return {
      wrapperPath,
      restoredFrom: backupPath
    };
  }
  return {
    wrapperPath,
    restoredFrom: null
  };
}

function uninstallCodexWrapper() {
  const config = readConfig();
  const candidates = codexWrapperCandidates(config);
  const unmanaged = [];
  const skippedWrappers = [];
  const removedWrappers = [];
  const restoredWrappers = [];

  for (const wrapperPath of candidates) {
    if (!fs.existsSync(wrapperPath)) continue;
    if (!managedCodexWrapper(wrapperPath)) {
      unmanaged.push(wrapperPath);
      continue;
    }
    const result = removeOrRestoreCodexWrapper(wrapperPath, config);
    if (result.skipped) {
      skippedWrappers.push(result);
    } else if (result.restoredFrom) {
      restoredWrappers.push(result);
    } else {
      removedWrappers.push(result.wrapperPath);
    }
  }

  const rcPaths = removeShellPathBlocks();
  const hadConfig = Boolean(config.codexWrapper);
  if (hadConfig) {
    config.codexWrapper = null;
    writeConfig(config);
  }

  return {
    changed: Boolean(removedWrappers.length || restoredWrappers.length || rcPaths.length || hadConfig),
    wrapperPath: restoredWrappers[0]?.wrapperPath || removedWrappers[0] || null,
    removedWrappers,
    restoredWrappers,
    skippedWrappers,
    rcPaths,
    configPath: hadConfig ? configPath() : null,
    unmanaged,
    reason: (removedWrappers.length || restoredWrappers.length)
      ? null
      : (skippedWrappers.length ? "Managed Codex wrapper found but left untouched because no restore backup was available" : "No managed Codex wrapper found")
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

  const config = readConfig();
  const configuredOriginal = config.codexWrapper?.originalCommand;
  const discoveredOriginal = findOriginalCodexCommand(codexInstallSkipPaths(config));
  const originalCandidate = configuredOriginal && fs.existsSync(configuredOriginal) && !managedCodexWrapper(configuredOriginal)
    ? configuredOriginal
    : discoveredOriginal;
  const originalPathForPath = discoveredOriginal || originalCandidate;
  const originalCommand = originalCandidate ? executableTarget(originalCandidate) : null;

  if (!originalCommand) {
    return {
      ok: false,
      skipped: true,
      reason: "codex command was not found on PATH"
    };
  }

  const shimSelection = selectCodexShimDir(originalCommand, originalPathForPath);
  const shimDir = shimSelection.shimDir;
  const wrapperPath = path.join(shimDir, "codex");

  if (samePath(wrapperPath, originalCommand)) {
    return {
      ok: false,
      skipped: true,
      reason: `Refusing to replace the original codex command at ${wrapperPath}`
    };
  }

  fs.mkdirSync(shimDir, { recursive: true, mode: 0o755 });
  let backupPath = null;
  if (fs.existsSync(wrapperPath) && !managedCodexWrapper(wrapperPath)) {
    return {
      ok: false,
      skipped: true,
      reason: `Refusing to replace unmanaged codex command at ${wrapperPath}. Set AI_BATTERY_SHIM_DIR to an empty AI Battery-owned directory.`
    };
  }

  fs.writeFileSync(wrapperPath, codexWrapperScript(originalCommand), { mode: 0o755 });

  const wrapperCleanup = [];
  for (const staleWrapperPath of codexInstallSkipPaths(config)) {
    if (samePath(staleWrapperPath, wrapperPath)) continue;
    if (!fs.existsSync(staleWrapperPath) || !managedCodexWrapper(staleWrapperPath)) continue;
    wrapperCleanup.push(removeOrRestoreCodexWrapper(staleWrapperPath, config));
  }

  const pathResult = ensureShimPath(shimDir, originalPathForPath || originalCommand);
  config.codexWrapper = {
    wrapperPath,
    originalCommand,
    backupPath,
    installedAt: new Date().toISOString()
  };
  writeConfig(config);

  return {
    ok: true,
    wrapperPath,
    originalCommand,
    backupPath,
    legacyCleanup: wrapperCleanup,
    wrapperCleanup,
    shimSelection,
    path: pathResult
  };
}

function sourcePathCommand(rcPath) {
  const shell = path.basename(process.env.SHELL || "");
  if (!rcPath) return null;
  if (["bash", "fish", "zsh"].includes(shell)) return `source ${shellArg(rcPath)}`;
  return `. ${shellArg(rcPath)}`;
}

function codexRestartNote() {
  if (!runningInsideCodex() || runningInsideAiBatteryCodexWrapper()) return null;
  return "Current Codex was not started through AI Battery. Exit this Codex session and run plain \"codex\" again from a normal terminal.";
}

function diagnoseCodex() {
  const config = readConfig();
  const configuredWrapper = config.codexWrapper?.wrapperPath || path.join(defaultCodexShimDir(), "codex");
  const configuredOriginal = config.codexWrapper?.originalCommand || null;
  const activeCodex = findCommand("codex");
  const wrapperInstalled = configuredWrapper ? managedCodexWrapper(configuredWrapper) : false;
  const activeIsWrapper = activeCodex ? managedCodexWrapper(activeCodex) : false;
  const activeWrapperBackup = activeIsWrapper ? existingCodexWrapperBackup(activeCodex, config) : null;
  const originalExists = configuredOriginal ? fs.existsSync(configuredOriginal) : false;
  const runnerPath = path.join(scriptDir(), "ai-battery-run");
  const runnerExists = isExecutable(runnerPath);
  const python3 = findCommand("python3");
  const providerEnabled = providerVisible("codex");
  const notes = [];

  if (!providerEnabled) {
    notes.push("Codex provider is hidden. Run: ai-battery on codex");
  }
  if (!wrapperInstalled) {
    notes.push("Codex wrapper is not installed. Run: ai-battery setup codex");
  }
  if (activeIsWrapper && !wrapperInstalled) {
    notes.push("Plain \"codex\" still resolves to an AI Battery wrapper outside the configured shim. Run: ai-battery uninstall codex");
  }
  if (activeWrapperBackup) {
    notes.push(`A Codex backup is available for restore: ${activeWrapperBackup}`);
  }
  if (wrapperInstalled && !activeIsWrapper) {
    notes.push(`Plain "codex" does not resolve to the AI Battery wrapper in this shell. Ensure ${path.dirname(configuredWrapper)} is before the original codex on PATH, then open a new terminal or run "hash -r" in the parent shell.`);
  }
  if (!runnerExists) {
    notes.push(`AI Battery runner is missing or not executable: ${runnerPath}`);
  }
  if (wrapperInstalled && !python3) {
    notes.push("Codex wrapper needs python3 for the POSIX PTY row. Install Python 3, then run plain \"codex\" again.");
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
    activeWrapperBackup,
    wrapperPath: configuredWrapper,
    wrapperInstalled,
    runnerPath,
    runnerExists,
    python3,
    originalCommand: configuredOriginal,
    originalExists: configuredOriginal ? originalExists : null,
    insideCodex: runningInsideCodex(),
    currentCodexWrapped: runningInsideAiBatteryCodexWrapper(),
    notes
  };
}

async function runDoctor() {
  const version = await checkPackageVersion();
  return {
    generatedAt: new Date().toISOString(),
    aiBattery: {
      script: fileURLToPath(import.meta.url),
      packageName: version.name,
      version: version.current,
      latestVersion: version.latest,
      updateAvailable: version.updateAvailable,
      updateCheck: {
        checked: version.checked,
        checkedAt: version.checkedAt,
        error: version.error
      },
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
    results.claude = installClaudeStatusline(args);
  }
  if (targets.includes("codex")) {
    results.codex = installCodexWrapper(args);
  }
  return results;
}

function isWsl() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return fs.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

function runHud(args) {
  const hudPath = path.join(scriptDir(), "ai-battery-hud.js");
  return spawnSync(process.execPath, [hudPath, ...args.rest], {
    stdio: "inherit",
    windowsHide: true
  });
}

function desktopHudSupported() {
  return process.platform === "darwin" || process.platform === "win32" || isWsl();
}

function childResult(result) {
  return {
    ok: !result.error && result.status === 0,
    status: result.status ?? null,
    error: result.error?.message ?? null,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim()
  };
}

function runHudCommand(args) {
  const hudPath = path.join(scriptDir(), "ai-battery-hud.js");
  return childResult(spawnSync(process.execPath, [hudPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
    windowsHide: true
  }));
}

function uninstallHud() {
  if (!desktopHudSupported()) {
    return {
      changed: false,
      skipped: true,
      reason: "Desktop HUD is not supported on this platform"
    };
  }

  const autostart = runHudCommand(["autostart", "off"]);
  const stop = runHudCommand(["stop"]);
  return {
    changed: autostart.ok || stop.ok,
    autostart,
    stop
  };
}

function runTeardown(args) {
  const targets = teardownTargets(args.targets);
  const results = {};

  const runStep = (name, action) => {
    results[name] = action();
  };

  if (targets.includes("claude")) {
    runStep("claude", () => uninstallClaudeStatusline({ strict: false }));
  }
  if (targets.includes("codex")) {
    runStep("codex", uninstallCodexWrapper);
  }
  if (targets.includes("hud")) {
    runStep("hud", uninstallHud);
  }
  return {
    targets,
    results
  };
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

function firstFiniteEntry(source, keys) {
  for (const key of [keys].flat().filter(Boolean)) {
    const value = source?.[key];
    if (Number.isFinite(value)) return { key, value };
    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return { key, value: numeric };
    }
  }
  return null;
}

function firstFiniteValue(source, keys) {
  return firstFiniteEntry(source, keys)?.value ?? null;
}

function keyUsesFractionalPercent(key) {
  return /(?:ratio|fraction|utilization)$/i.test(String(key));
}

function percentValue(value, options = {}) {
  if (!Number.isFinite(value)) return null;
  return options.scaleFraction && value >= 0 && value <= 1 ? value * 100 : value;
}

function firstPercentValue(source, keys) {
  const entry = firstFiniteEntry(source, keys);
  if (!entry) return null;
  return percentValue(entry.value, {
    scaleFraction: keyUsesFractionalPercent(entry.key)
  });
}

function usageInputTokens(usage) {
  if (!usage) return null;
  const inputTokens = firstFiniteValue(usage, ["input_tokens", "inputTokens"]);
  const cacheCreationTokens = firstFiniteValue(usage, ["cache_creation_input_tokens", "cacheCreationInputTokens"]);
  const cacheReadTokens = firstFiniteValue(usage, ["cache_read_input_tokens", "cacheReadInputTokens"]);
  if (
    !Number.isFinite(inputTokens)
    && !Number.isFinite(cacheCreationTokens)
    && !Number.isFinite(cacheReadTokens)
  ) {
    return null;
  }
  return (Number(inputTokens) || 0) + (Number(cacheCreationTokens) || 0) + (Number(cacheReadTokens) || 0);
}

function resetEpochSeconds(value) {
  if (Number.isFinite(value)) return value > 1_000_000_000_000 ? Math.floor(value / 1000) : value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return resetEpochSeconds(numeric);
    const millis = Date.parse(value);
    if (!Number.isNaN(millis)) return Math.floor(millis / 1000);
  }
  return null;
}

function normalizeLimit(limit, options = {}) {
  if (!limit) return null;

  const usedKeys = options.usedKey || "used_percent";
  const remainingKeys = [options.remainingKey].flat().filter(Boolean);
  const windowMinutes = options.windowMinutes ?? limit?.window_minutes ?? limit?.windowMinutes ?? null;
  const usedValue = firstPercentValue(limit, usedKeys);
  const remainingValue = firstPercentValue(limit, remainingKeys);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const resetsAtSeconds = resetEpochSeconds(limit.resets_at ?? limit.resetsAt ?? limit.reset_at ?? limit.resetAt);
  const resetPassed = Number.isFinite(resetsAtSeconds) && resetsAtSeconds <= nowSeconds;
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
    resetsAt: resetsAtSeconds ? new Date(resetsAtSeconds * 1000).toISOString() : null,
    resetsInSeconds: resetsAtSeconds ? Math.max(0, resetsAtSeconds - nowSeconds) : null,
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

const SCAN_CACHE_VERSION = 2;

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
  const usedPercentage = firstPercentValue(limit, [
    "used_percentage",
    "usedPercent",
    "percent_used",
    "percentUsed",
    "utilization"
  ]);
  const remainingPercentage = firstPercentValue(limit, [
    "remaining_percentage",
    "remainingPercent",
    "remaining_percent",
    "percent_remaining",
    "percentRemaining"
  ]);
  const resetsAt = resetEpochSeconds(limit.resets_at ?? limit.resetsAt ?? limit.reset_at ?? limit.resetAt);
  const hasUsedPercentage = Number.isFinite(usedPercentage);
  const hasRemainingPercentage = Number.isFinite(remainingPercentage);
  const hasReset = Number.isFinite(resetsAt);
  if (!hasUsedPercentage && !hasRemainingPercentage && !hasReset) return null;
  return {
    ...limit,
    used_percentage: hasUsedPercentage ? usedPercentage : null,
    remaining_percentage: hasRemainingPercentage ? remainingPercentage : null,
    resets_at: hasReset ? resetsAt : null,
    window_minutes: limit.window_minutes ?? limit.windowMinutes ?? windowMinutes
  };
}

function normalizeClaudeCachedLimit(limit, options = {}) {
  if (!limit) return null;
  return normalizeLimit(limit, {
    usedKey: ["used_percentage", "usedPercent", "percent_used", "percentUsed", "utilization"],
    remainingKey: ["remaining_percentage", "remainingPercent", "remaining_percent", "percent_remaining", "percentRemaining"],
    windowMinutes: limit.window_minutes ?? limit.windowMinutes ?? null,
    ...options
  });
}

function claudeRateLimitsFromStatusline(input) {
  const rateLimits = input.rate_limits ?? input.rateLimits ?? input.limits ?? {};
  const fiveHour = rateLimits.five_hour
    ?? rateLimits.fiveHour
    ?? rateLimits.five_hour_limit
    ?? rateLimits.fiveHourLimit
    ?? rateLimits.session
    ?? rateLimits.session_limit
    ?? rateLimits.sessionLimit
    ?? rateLimits.primary
    ?? null;
  const sevenDay = rateLimits.seven_day
    ?? rateLimits.sevenDay
    ?? rateLimits.seven_day_limit
    ?? rateLimits.sevenDayLimit
    ?? rateLimits.weekly
    ?? rateLimits.weekly_limit
    ?? rateLimits.weeklyLimit
    ?? rateLimits.weekly_scoped
    ?? rateLimits.weeklyScoped
    ?? rateLimits.secondary
    ?? null;
  return { fiveHour, sevenDay, raw: rateLimits };
}

function normalizeClaudeContextWindow(context) {
  if (!context) return null;

  const usedPercentage = firstPercentValue(context, ["used_percentage", "usedPercentage", "percent_used", "percentUsed"]);
  let remainingPercentage = firstPercentValue(context, [
    "remaining_percentage",
    "remainingPercentage",
    "percent_remaining",
    "percentRemaining"
  ]);
  const currentUsage = context.current_usage ?? context.currentUsage ?? null;
  const contextWindowSize = firstFiniteValue(context, ["context_window_size", "contextWindowSize", "size", "max_tokens", "maxTokens"]);
  const totalInputTokens = firstFiniteValue(context, ["total_input_tokens", "totalInputTokens"])
    ?? usageInputTokens(currentUsage)
    ?? firstFiniteValue(context, ["input_tokens", "inputTokens"]);
  const totalOutputTokens = firstFiniteValue(context, ["total_output_tokens", "totalOutputTokens", "output_tokens", "outputTokens"])
    ?? firstFiniteValue(currentUsage, ["output_tokens", "outputTokens"]);
  const totalTokens = firstFiniteValue(context, ["total_tokens", "totalTokens"])
    ?? ((Number.isFinite(totalInputTokens) || Number.isFinite(totalOutputTokens))
      ? (Number(totalInputTokens) || 0) + (Number(totalOutputTokens) || 0)
      : null);

  if (!Number.isFinite(remainingPercentage) && Number.isFinite(usedPercentage)) {
    remainingPercentage = 100 - usedPercentage;
  }
  if (!Number.isFinite(remainingPercentage) && Number.isFinite(contextWindowSize) && Number.isFinite(totalTokens) && contextWindowSize > 0) {
    remainingPercentage = 100 - ((totalTokens / contextWindowSize) * 100);
  }

  return {
    usedPercentage: Number.isFinite(usedPercentage)
      ? clamp(Math.round(usedPercentage), 0, 100)
      : (Number.isFinite(remainingPercentage) ? clamp(100 - Math.round(remainingPercentage), 0, 100) : null),
    remainingPercentage: Number.isFinite(remainingPercentage) ? clamp(Math.round(remainingPercentage), 0, 100) : null,
    contextWindowSize: contextWindowSize ?? null,
    totalInputTokens: totalInputTokens ?? null,
    totalOutputTokens: totalOutputTokens ?? null
  };
}

function claudeContextWindowFromStatusline(input) {
  const context = input.context_window
    ?? input.contextWindow
    ?? input.context
    ?? input.context_window_info
    ?? (input.context_window_size || input.contextWindowSize ? input : null)
    ?? null;
  return normalizeClaudeContextWindow(context);
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
  const rateLimits = claudeRateLimitsFromStatusline(input);
  const sessionId = input.session_id ?? input.sessionId ?? null;
  const previous = (sessionId ? readJson(claudeSessionCachePath(sessionId)) : null) ?? readJson(claudeCachePath());
  const sessionKind = claudeStatuslineSessionKind(input);
  const contextWindow = claudeContextWindowFromStatusline(input);
  const snapshot = {
    version: 1,
    provider: "claude",
    sourceType: "statusline",
    capturedAt: new Date().toISOString(),
    sessionId,
    promptId: input.prompt_id ?? input.promptId ?? null,
    transcriptPath: input.transcript_path ?? input.transcriptPath ?? null,
    sessionKind,
    claudeVersion: input.version ?? null,
    model: {
      id: typeof input.model === "string" ? input.model : input.model?.id ?? null,
      displayName: typeof input.model === "string" ? input.model : input.model?.display_name ?? input.model?.displayName ?? null
    },
    rateLimits: {
      fiveHour: claudeLimitFromStatusline(rateLimits.fiveHour, 300),
      sevenDay: claudeLimitFromStatusline(rateLimits.sevenDay, 10080)
    },
    rawRateLimits: rateLimits.raw,
    contextWindow
  };

  if (previous?.provider === "claude" && previous?.sourceType === "statusline") {
    const sameSession = previous.sessionId && snapshot.sessionId && previous.sessionId === snapshot.sessionId;
    if (!snapshot.rateLimits.fiveHour) {
      snapshot.rateLimits.fiveHour = previous.rateLimits?.fiveHour ?? null;
    }
    if (!snapshot.rateLimits.sevenDay) {
      snapshot.rateLimits.sevenDay = previous.rateLimits?.sevenDay ?? null;
    }
    if (sameSession && !snapshot.contextWindow) {
      snapshot.contextWindow = previous.contextWindow ?? null;
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

function claudeStatuslineRefreshInterval() {
  const value = Number(process.env.AI_BATTERY_CLAUDE_REFRESH ?? process.env.CLAUDEX_BATTERY_CLAUDE_REFRESH);
  if (!Number.isFinite(value)) return 1;
  return clamp(Math.floor(value), 1, 60);
}

function installClaudeStatusline(args) {
  const settingsPath = homePath(".claude", "settings.json");
  const existing = readJson(settingsPath) ?? {};
  const command = `${shellArg(process.execPath)} ${shellArg(fileURLToPath(import.meta.url))} capture-claude --muted --left-padding 1`;
  const currentCommand = existing.statusLine?.command ?? "";
  const installedByAiBattery = currentCommand.includes("ai-battery.js") && currentCommand.includes("capture-claude");
  const config = readConfig();

  if (existing.statusLine && !installedByAiBattery && !args.force) {
    return {
      settingsPath,
      command,
      skipped: true,
      reason: "Claude statusLine is already configured by another tool. Re-run with --force to replace it with a restorable backup."
    };
  }

  let backedUp = false;
  if (existing.statusLine && !installedByAiBattery && args.force) {
    config.claudeStatusLineBackup = {
      settingsPath,
      statusLine: existing.statusLine,
      savedAt: new Date().toISOString()
    };
    backedUp = true;
  }

  const next = {
    ...existing,
    statusLine: {
      type: "command",
      command,
      padding: 0,
      refreshInterval: claudeStatuslineRefreshInterval()
    }
  };

  writeJsonAtomic(settingsPath, next);
  if (backedUp) writeConfig(config);
  return {
    settingsPath,
    command,
    backedUp
  };
}

function uninstallClaudeStatusline(options = {}) {
  const settingsPath = homePath(".claude", "settings.json");
  const existing = readJson(settingsPath) ?? {};
  const command = existing.statusLine?.command ?? "";
  const installedByAiBattery = command.includes("ai-battery.js") && command.includes("capture-claude");
  const strict = options.strict !== false;
  const config = readConfig();
  const backup = config.claudeStatusLineBackup;

  if (!existing.statusLine) {
    return {
      settingsPath,
      changed: false,
      reason: "No Claude statusLine is configured"
    };
  }

  if (!installedByAiBattery) {
    if (!strict) {
      return {
        settingsPath,
        changed: false,
        reason: "Claude statusLine is configured by another tool"
      };
    }
    throw new Error(`Claude statusLine exists but does not look like AI Battery's command: ${command}`);
  }

  const next = { ...existing };
  if (backup?.statusLine && (!backup.settingsPath || path.resolve(backup.settingsPath) === path.resolve(settingsPath))) {
    next.statusLine = backup.statusLine;
  } else {
    delete next.statusLine;
  }
  writeJsonAtomic(settingsPath, next);
  if (backup) {
    config.claudeStatusLineBackup = null;
    writeConfig(config);
  }
  return {
    settingsPath,
    changed: true,
    restored: Boolean(backup?.statusLine)
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

function sttyColumns() {
  if (process.platform === "win32") return null;

  let ttyFd = null;
  try {
    ttyFd = fs.openSync("/dev/tty", "r");
    const output = execFileSync("stty", ["size"], {
      encoding: "utf8",
      stdio: [ttyFd, "pipe", "ignore"],
      timeout: 100
    }).trim();
    const [, columns] = output.split(/\s+/).map((part) => Number(part));
    return numericColumn(columns);
  } catch {
    return null;
  } finally {
    if (ttyFd !== null) {
      try {
        fs.closeSync(ttyFd);
      } catch {
        // Nothing to clean up if the fd was already closed by the OS.
      }
    }
  }
}

function runtimeTerminalColumns() {
  return numericColumn(process.stdout.columns) ?? sttyColumns();
}

function statusLineColumns(input) {
  const explicitColumns = numericColumn(process.env.AI_BATTERY_COLUMNS)
    ?? numericColumn(process.env.CLAUDEX_BATTERY_COLUMNS);
  if (explicitColumns) return explicitColumns;

  const runtimeColumns = runtimeTerminalColumns();
  const payloadCandidates = [
    input.terminal?.columns,
    input.terminal?.cols,
    input.terminal?.width,
    input.terminal_columns,
    input.terminal_width,
    input.columns,
    input.width
  ];

  let payloadColumns = null;
  for (const candidate of payloadCandidates) {
    const columns = numericColumn(candidate);
    if (columns) {
      payloadColumns = columns;
      break;
    }
  }

  if (payloadColumns && runtimeColumns) return Math.min(payloadColumns, runtimeColumns);
  if (payloadColumns) return payloadColumns;
  if (runtimeColumns) return runtimeColumns;

  const envColumns = numericColumn(process.env.COLUMNS) ?? numericColumn(process.stdout.columns);
  if (envColumns) return envColumns;
  return 80;
}

function statusLineHeaderColumns(input, args) {
  const guard = numericGuard(process.env.AI_BATTERY_HEADER_COLUMN_GUARD)
    ?? numericGuard(process.env.CLAUDEX_BATTERY_HEADER_COLUMN_GUARD)
    ?? DEFAULT_STATUSLINE_HEADER_COLUMN_GUARD;
  return Math.max(20, statusLineColumns(input) - guard - (Number(args.leftPadding) || 0));
}

function statusLineUsableColumns(input) {
  const guard = numericGuard(process.env.AI_BATTERY_COLUMN_GUARD)
    ?? numericGuard(process.env.CLAUDEX_BATTERY_COLUMN_GUARD)
    ?? DEFAULT_STATUSLINE_COLUMN_GUARD;
  return Math.max(20, statusLineColumns(input) - guard);
}

function contextRemainingPercent(input, fallbackContext = null) {
  const context = claudeContextWindowFromStatusline(input) ?? fallbackContext;
  const remaining = context?.remainingPercentage;
  if (typeof remaining === "number") return clamp(Math.round(remaining), 0, 100);

  const used = context?.usedPercentage;
  if (typeof used === "number") return clamp(100 - Math.round(used), 0, 100);
  return null;
}

function contextLeftText(input, fallbackContext = null) {
  const remaining = contextRemainingPercent(input, fallbackContext);
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
    || input.workspace?.branch
    || input.worktree?.branch
    || input.worktree?.original_branch
    || null;
  if (explicit) return explicit;

  const dirs = [
    input.workspace?.current_dir,
    input.workspace?.currentDir,
    input.cwd,
    input.current_dir,
    input.currentDir,
    input.workspace?.project_dir,
    input.workspace?.projectDir
  ].filter(Boolean);

  for (const dir of dirs) {
    const branch = gitBranchFromDir(dir);
    if (branch) return branch;
  }
  return null;
}

function claudeHeader(input, args, capturedClaude = null) {
  const model = typeof input.model === "string"
    ? input.model
    : input.model?.display_name || input.model?.displayName || input.model?.id || "Claude";
  const effort = input.effort?.level || input.effortLevel || null;
  const workspaceRoot = input.workspace?.project_dir
    || input.workspace?.projectDir
    || input.cwd
    || input.current_dir
    || input.currentDir
    || input.workspace?.current_dir
    || input.workspace?.currentDir
    || "";
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
  const right = contextLeftText(input, capturedClaude?.contextWindow ?? null);
  const columns = statusLineHeaderColumns(input, args);
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

function renderMenuBar(snapshot) {
  const parts = snapshot.results
    .map((result) => {
      const label = result.provider === "codex" ? "Cx" : "Cl";
      if (!result.ok || typeof result.percentRemaining !== "number") return `${label} --`;
      return `${label} ${result.percentRemaining}%`;
    })
    .filter(Boolean);
  return parts.length ? parts.join(" | ") : "AI --";
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
  if (args.menuBar) return renderMenuBar(snapshot);

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

function printTeardownResult(result) {
  if (result.skipped) {
    console.log(`Teardown skipped: ${result.reason}`);
    return;
  }

  const { codex, claude, hud } = result.results;
  if (codex) {
    if (codex.error) {
      console.log(`Codex wrapper error: ${codex.error}`);
    } else {
      for (const restored of codex.restoredWrappers || []) {
        console.log(`Restored Codex command: ${restored.wrapperPath}`);
        console.log(`Restored from: ${restored.restoredFrom}`);
      }
      for (const wrapperPath of codex.removedWrappers || []) {
        console.log(`Removed Codex wrapper: ${wrapperPath}`);
      }
      for (const skipped of codex.skippedWrappers || []) {
        console.log(`Left Codex wrapper untouched: ${skipped.wrapperPath}`);
        console.log(`Reason: ${skipped.reason}`);
      }
      if (!(codex.restoredWrappers?.length || codex.removedWrappers?.length || codex.skippedWrappers?.length)) {
        console.log(`Codex wrapper: ${codex.reason}`);
      }
    }
    for (const rcPath of codex.rcPaths || []) {
      console.log(`Removed shell PATH block: ${rcPath}`);
    }
    if (codex.configPath) console.log(`Updated ${codex.configPath}`);
    for (const wrapperPath of codex.unmanaged || []) {
      console.log(`Skipped unmanaged codex command: ${wrapperPath}`);
    }
  }

  if (claude) {
    if (claude.error) {
      console.log(`Claude statusLine error: ${claude.error}`);
    } else if (claude.changed) {
      console.log(`${claude.restored ? "Restored previous Claude statusLine" : "Removed Claude statusLine"}: ${claude.settingsPath}`);
    } else {
      console.log(`${claude.reason}: ${claude.settingsPath}`);
    }
  }

  if (hud) {
    if (hud.error) {
      console.log(`HUD error: ${hud.error}`);
    } else if (hud.skipped) {
      console.log(`HUD: ${hud.reason}`);
    } else {
      console.log(`HUD autostart: ${hud.autostart.ok ? "off" : "not changed"}`);
      if (!hud.autostart.ok && hud.autostart.error) console.log(`HUD autostart error: ${hud.autostart.error}`);
      if (!hud.autostart.ok && hud.autostart.stderr) console.log(`HUD autostart error: ${hud.autostart.stderr}`);
      console.log(`HUD process: ${hud.stop.ok ? "stopped" : "not changed"}`);
      if (!hud.stop.ok && hud.stop.error) console.log(`HUD stop error: ${hud.stop.error}`);
      if (!hud.stop.ok && hud.stop.stderr) console.log(`HUD stop error: ${hud.stop.stderr}`);
    }
  }

  if (runningInsideAiBatteryCodexWrapper()) {
    console.log("Current Codex session was already started through AI Battery; exit this session to remove the terminal row.");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    console.log(packageInfo().version);
    return;
  }
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
        if (result.claude.skipped) {
          console.log(`Claude statusLine skipped: ${result.claude.reason}`);
        } else {
          console.log(`Claude statusLine installed: ${result.claude.settingsPath}`);
          if (result.claude.backedUp) console.log("Backed up previous Claude statusLine for uninstall restore.");
        }
      }
      if (result.codex?.ok) {
        console.log(`Codex wrapper installed: ${result.codex.wrapperPath}`);
        console.log(`Original codex: ${result.codex.originalCommand}`);
        if (result.codex.path?.note) console.log(result.codex.path.note);
        const reloadCommand = sourcePathCommand(result.codex.path?.rcPath);
        if (reloadCommand) console.log(`For this terminal now, run: ${reloadCommand}`);
      } else if (result.codex?.skipped) {
        console.log(`Codex wrapper skipped: ${result.codex.reason}`);
      }
      console.log("To remove AI Battery cleanly later, run: ai-battery uninstall");
      const note = codexRestartNote();
      if (result.codex && note) console.log(note);
    }
    return;
  }

  if (args.command === "teardown" || args.command === "uninstall") {
    const result = runTeardown(args);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (!args.silent) {
      printTeardownResult(result);
    }
    return;
  }

  if (args.command === "doctor") {
    const result = await runDoctor();
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`AI Battery: ${result.aiBattery.script}`);
      console.log(`Version: ${result.aiBattery.version}`);
      if (result.aiBattery.latestVersion) {
        console.log(`npm latest: ${result.aiBattery.latestVersion}`);
        if (result.aiBattery.updateAvailable) {
          console.log(`Update: available (npm install -g ${result.aiBattery.packageName}@latest)`);
        } else if (compareVersions(result.aiBattery.version, result.aiBattery.latestVersion) > 0) {
          console.log("Update: local version is newer than npm latest");
        } else {
          console.log("Update: up to date");
        }
      } else if (result.aiBattery.updateCheck.error === "disabled") {
        console.log("npm latest: skipped");
      } else {
        console.log(`npm latest: unavailable (${result.aiBattery.updateCheck.error || "unknown error"})`);
      }
      console.log(`State: ${result.aiBattery.stateDir}`);
      console.log("");
      console.log(`Codex provider: ${result.codex.providerEnabled ? "on" : "off"}`);
      console.log(`Codex on PATH: ${result.codex.activeCodex || "not found"}`);
      console.log(`Codex wrapper: ${result.codex.wrapperInstalled ? "installed" : "missing"} (${result.codex.wrapperPath})`);
      console.log(`AI Battery runner: ${result.codex.runnerExists ? "found" : "missing"} (${result.codex.runnerPath})`);
      console.log(`python3: ${result.codex.python3 || "not found"}`);
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
      if (result.skipped) {
        console.log(`Claude statusLine skipped: ${result.reason}`);
      } else {
        console.log(`Installed Claude statusLine: ${result.command}`);
        console.log(`Updated ${result.settingsPath}`);
        if (result.backedUp) console.log("Backed up previous Claude statusLine for uninstall restore.");
      }
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  if (args.command === "uninstall-claude-statusline") {
    const result = uninstallClaudeStatusline();
    if (!args.json) {
      if (result.changed) {
        console.log(`${result.restored ? "Restored previous Claude statusLine in" : "Removed Claude statusLine from"} ${result.settingsPath}`);
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
      const header = args.header ? applyLeftPadding(claudeHeader(input, args, capturedClaude), args) : "";
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

export {
  claudeHeader,
  codexWrapperScript,
  firstPercentValue,
  installClaudeStatusline,
  installCodexWrapper,
  normalizeLimit,
  removeOrRestoreCodexWrapper,
  removeAiBatteryShellPathBlock,
  percentValue,
  sameFilePath,
  visibleWidth,
  uninstallClaudeStatusline
};

function sameFilePath(leftPath, rightPath) {
  try {
    return fs.realpathSync(leftPath) === fs.realpathSync(rightPath);
  } catch {
    return pathToFileURL(leftPath).href === pathToFileURL(rightPath).href;
  }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  return sameFilePath(fileURLToPath(import.meta.url), process.argv[1]);
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(`ai-battery: ${error.message}`);
    process.exit(1);
  });
}
