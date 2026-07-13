import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function createProcessScanner({
  isWsl,
  readJson,
  readScanCache,
  scanCachePath,
  scanCacheSeconds,
  writeScanCache
}) {
function shellArg(value) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

const PROVIDER_EXECUTABLE_RE = {
  codex: /^codex(?:\.(?:cmd|exe|bat|js|mjs|cjs))?$/i,
  claude: /^(?:claude|claude-code)(?:\.(?:cmd|exe|bat|js|mjs|cjs))?$/i
};
const PROVIDER_PACKAGE_MARKERS = {
  codex: ["@openai/codex"],
  claude: ["@anthropic-ai/claude-code", "claude-code"]
};
const AI_BATTERY_RUNNER_RE = /^(?:ai-battery-run|claudex-battery-run|ai-battery-run-win\.js)$/i;
const RUNNER_OPTIONS_WITH_VALUES = new Set([
  "--interval",
  "--bar-width",
  "--provider",
  "--layout",
  "--left-padding"
]);

function claudeCommandIsBackground(cmdline) {
  return /(^|\s)daemon\s+run(\s|$)/.test(cmdline)
    || cmdline.includes("--bg-pty-host")
    || cmdline.includes("--bg-spare");
}

function codexCommandIsBackground(cmdline) {
  const tokens = commandLineTokens(cmdline);
  if (!tokens.length) return false;

  let commandIndex = -1;
  const firstBase = commandTokenBasename(tokens[0]).toLowerCase();
  if (tokenMatchesProviderExecutable(tokens[0], "codex")) {
    commandIndex = 0;
  } else if (/^node(?:\.exe)?$/i.test(firstBase) && tokenMatchesProviderExecutable(tokens[1], "codex")) {
    commandIndex = 1;
  }

  return commandIndex >= 0 && tokens[commandIndex + 1] === "app-server";
}

function commandLineTokens(cmdline) {
  return (String(cmdline || "").match(/"(?:(?:\\.|[^"\\])*)"|'[^']*'|\S+/g) || [])
    .map((token) => token.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1").replace(/\\"/g, "\""))
    .filter(Boolean);
}

function commandTokenBasename(token) {
  return String(token || "")
    .replace(/^["']|["']$/g, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || "";
}

function tokenMatchesProviderExecutable(token, provider) {
  return Boolean(PROVIDER_EXECUTABLE_RE[provider]?.test(commandTokenBasename(token)));
}

function tokenMatchesProviderPackage(token, provider) {
  const lower = String(token || "").toLowerCase();
  return (PROVIDER_PACKAGE_MARKERS[provider] || []).some((marker) => lower.includes(marker));
}

function commandInvokesAiBatteryRunner(tokens) {
  return tokens.some((token) => AI_BATTERY_RUNNER_RE.test(commandTokenBasename(token)));
}

function tokensAfterLastSeparator(tokens) {
  const index = tokens.lastIndexOf("--");
  return index >= 0 ? tokens.slice(index + 1) : [];
}

function aiBatteryRunnerCommandTokens(tokens) {
  const runnerIndex = tokens.findIndex((token) => AI_BATTERY_RUNNER_RE.test(commandTokenBasename(token)));
  if (runnerIndex < 0) return [];

  for (let i = runnerIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") return tokens.slice(i + 1);
    if (token.startsWith("--")) {
      const option = token.split("=", 1)[0];
      if (RUNNER_OPTIONS_WITH_VALUES.has(option) && !token.includes("=")) i += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return tokens.slice(i);
  }
  return [];
}

function commandMatchesProvider(cmdline, provider) {
  const text = String(cmdline || "");
  if (provider === "codex" && codexCommandIsBackground(text)) return false;
  if (provider === "claude" && claudeCommandIsBackground(text)) return false;
  if (
    text.includes("ai-battery.js")
    && !tokenMatchesProviderPackage(text, "codex")
    && !tokenMatchesProviderPackage(text, "claude")
  ) {
    return false;
  }

  const tokens = commandLineTokens(text);
  if (!tokens.length) return false;

  if (tokens.some((token) => tokenMatchesProviderPackage(token, provider))) return true;

  const firstBase = commandTokenBasename(tokens[0]).toLowerCase();
  if (tokenMatchesProviderExecutable(tokens[0], provider)) return true;
  if (/^node(?:\.exe)?$/i.test(firstBase) && tokenMatchesProviderExecutable(tokens[1], provider)) return true;

  const runnerCommand = commandInvokesAiBatteryRunner(tokens)
    ? aiBatteryRunnerCommandTokens(tokens)
    : [];
  if (runnerCommand.some((token) => tokenMatchesProviderExecutable(token, provider))) return true;

  const afterSeparator = tokensAfterLastSeparator(tokens);
  if (
    /^(?:rowpty(?:\.exe)?|cmd(?:\.exe)?)$/i.test(firstBase)
    && afterSeparator.some((token) => tokenMatchesProviderExecutable(token, provider))
  ) {
    return true;
  }

  if (/^cmd(?:\.exe)?$/i.test(firstBase)) {
    const callIndex = tokens.findIndex((token) => /^call$/i.test(token));
    if (callIndex >= 0 && tokens.slice(callIndex + 1).some((token) => tokenMatchesProviderExecutable(token, provider))) {
      return true;
    }
  }

  if (provider === "codex") {
    return false;
  }
  if (provider === "claude") return false;
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
      .map((cmdline) => ({ cmdline, hasTty: true, source: "windows" }));
  } catch {
    return null;
  }
}

function decodeCommandOutput(buffer) {
  return Buffer.from(buffer || "")
    .toString("utf8")
    .replace(/\0/g, "");
}

function parseTtyProcessListOutput(output, source = null) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      const space = trimmed.indexOf(" ");
      if (space < 0) return null;
      const tty = trimmed.slice(0, space);
      const cmdline = trimmed.slice(space + 1).trim();
      if (!cmdline) return null;
      const proc = { cmdline, hasTty: tty !== "??" && tty !== "-" };
      if (source) proc.source = source;
      return proc;
    })
    .filter(Boolean);
}

function listDarwinProcessCommands() {
  try {
    const output = execFileSync("ps", ["-axo", "tty=,args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
      maxBuffer: 4 * 1024 * 1024
    });
    return parseTtyProcessListOutput(output);
  } catch {
    return [];
  }
}

function runningWslDistros() {
  if (process.platform !== "win32") return [];
  try {
    const output = decodeCommandOutput(execFileSync("wsl.exe", [
      "--list",
      "--running",
      "--quiet"
    ], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
      maxBuffer: 256 * 1024,
      windowsHide: true
    }));
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listWslProcessCommands() {
  const distros = runningWslDistros();
  if (!distros.length) return [];

  const commands = [];
  for (const distro of distros) {
    try {
      const output = decodeCommandOutput(execFileSync("wsl.exe", [
        "--distribution",
        distro,
        "bash",
        "-lc",
        "ps -axo tty=,args="
      ], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1500,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true
      }));
      commands.push(...parseTtyProcessListOutput(output, "wsl"));
    } catch {
      // A distro can exit between --list --running and the process query.
    }
  }
  return commands;
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
    // Windows and WSL draw on the same desktop, so include running WSL distros
    // when they are already up; --list --running avoids starting WSL just to
    // satisfy a HUD refresh.
    const cached = readScanCache("windows-processes", scanCacheSeconds(3));
    if (cached) {
      commands = Array.isArray(cached.value) ? cached.value : [];
    } else {
      const windowsCommands = listWindowsProcessCommands();
      if (windowsCommands === null) {
        commands = readJson(scanCachePath("windows-processes"))?.value ?? [];
      } else {
        commands = [
          ...windowsCommands,
          ...listWslProcessCommands()
        ];
        writeScanCache("windows-processes", commands);
      }
    }
  } else if (process.platform === "darwin") {
    commands = listDarwinProcessCommands();
  } else {
    commands = listProcProcessCommands();
    if (isWsl()) {
      // WSL shares a visible desktop with native Windows apps. Pull in the
      // Windows process list too, while keeping the Linux /proc scan as the
      // source for WSL TTY ownership.
      commands = [
        ...commands,
        ...(listWindowsProcessCommands() || [])
      ];
    }
  }

  processScanMemo = { at: Date.now(), commands };
  return commands;
}

function providerRunningInProcesses(provider, processes, platform = process.platform) {
  const needsTty = platform !== "win32";
  return processes.some((proc) => {
    if (!commandMatchesProvider(proc.cmdline, provider)) return false;
    if (proc.source === "wsl" && proc.hasTty === false) return false;
    if (!needsTty) return true;
    if (proc.hasTty === undefined) proc.hasTty = processHasControllingTty(proc.pid);
    return proc.hasTty;
  });
}

function isProviderRunning(provider) {
  return providerRunningInProcesses(provider, scanProcessCommands());
}

function codexBackgroundReadyInProcesses(processes) {
  return processes.some((proc) => codexCommandIsBackground(proc.cmdline));
}
  return {
    codexBackgroundReadyInProcesses,
    commandMatchesProvider,
    isProviderRunning,
    parseTtyProcessListOutput,
    providerRunningInProcesses,
    scanProcessCommands,
    shellArg
  };
}
