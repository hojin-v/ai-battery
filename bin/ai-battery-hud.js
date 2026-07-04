#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fs.realpathSync(fileURLToPath(import.meta.url));
const scriptDir = path.dirname(scriptPath);
const ps1Path = path.join(scriptDir, "ai-battery-hud.ps1");
const macStatusPath = path.join(scriptDir, "ai-battery-macos-status.applescript");

function isWsl() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return fs.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

function commandExists(command) {
  const result = spawnSync(command, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8",
    stdio: "ignore",
    windowsHide: true
  });
  return result.status === 0;
}

function wslPath(filePath) {
  const result = spawnSync("wslpath", ["-w", filePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("wslpath failed while resolving the HUD PowerShell script path");
  }
  return result.stdout.trim();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function wslEnvPrefix() {
  const names = [
    "AI_BATTERY_STATE_DIR",
    "CLAUDEX_BATTERY_STATE_DIR",
    "AI_BATTERY_COLUMNS",
    "CLAUDEX_BATTERY_COLUMNS",
    "AI_BATTERY_COLUMN_GUARD",
    "CLAUDEX_BATTERY_COLUMN_GUARD",
    "CODEX_HOME"
  ];
  return names
    .filter((name) => process.env[name])
    .map((name) => `${name}=${shellQuote(process.env[name])}`)
    .join(" ");
}

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function winArgQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildStartProcessCommand(filePath, args) {
  const commandLine = args.map(winArgQuote).join(" ");
  return `Start-Process -WindowStyle Hidden -FilePath ${psSingleQuote(filePath)} -ArgumentList ${psSingleQuote(commandLine)}`;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function snapshotHasWeekly(jsonText) {
  try {
    const snapshot = JSON.parse(jsonText);
    if (!Array.isArray(snapshot.results)) return false;
    const usageResults = snapshot.results.filter((result) => {
      return result
        && result.ok
        && ["codex", "claude"].includes(result.provider)
        && typeof result.percentRemaining === "number";
    });
    return usageResults.length > 0 && usageResults.every((result) => result.secondary);
  } catch {
    return false;
  }
}

function prefetchInitialJson(command, useWslCommand) {
  if (process.env.AI_BATTERY_HUD_NO_PREFETCH) return null;

  const attempts = 8;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = useWslCommand
      ? spawnSync("bash", ["-lc", command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 })
      : spawnSync(process.execPath, [batteryJs, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });

    const text = result.stdout?.trim();
    if (result.status === 0 && text) {
      if (snapshotHasWeekly(text) || attempt === attempts - 1) return text;
    }
    sleepSync(180);
  }

  return null;
}

function relevantEnvPrefix() {
  const names = [
    "AI_BATTERY_STATE_DIR",
    "CLAUDEX_BATTERY_STATE_DIR",
    "AI_BATTERY_COLUMNS",
    "CLAUDEX_BATTERY_COLUMNS",
    "AI_BATTERY_COLUMN_GUARD",
    "CLAUDEX_BATTERY_COLUMN_GUARD",
    "CODEX_HOME"
  ];
  const pairs = [`HOME=${shellQuote(os.homedir())}`];
  for (const name of names) {
    if (process.env[name]) pairs.push(`${name}=${shellQuote(process.env[name])}`);
  }
  return pairs.join(" ");
}

function parseMacHudArgs(cliArgs) {
  const options = {
    foreground: false,
    once: false,
    stop: false,
    subcommand: null,
    autostartAction: "status",
    interval: 10,
    provider: "all"
  };

  for (let i = 0; i < cliArgs.length; i += 1) {
    const arg = cliArgs[i];
    if (arg === "-Foreground" || arg === "--foreground") {
      options.foreground = true;
    } else if (arg === "-Once" || arg === "--once") {
      options.once = true;
    } else if (arg === "-Stop" || arg === "--stop" || arg === "stop") {
      options.stop = true;
    } else if (arg === "start") {
      // Starting is the default action.
    } else if (arg === "status") {
      options.subcommand = "status";
    } else if (arg === "autostart") {
      options.subcommand = "autostart";
      const next = cliArgs[i + 1];
      if (next === "on" || next === "off" || next === "status") {
        options.autostartAction = next;
        i += 1;
      }
    } else if (arg === "-Interval" || arg === "--interval") {
      const next = cliArgs[i + 1];
      if (next && !next.startsWith("-")) {
        options.interval = Math.max(1, Number(next) || options.interval);
        i += 1;
      }
    } else if (arg === "--provider" || arg === "-p") {
      const next = cliArgs[i + 1];
      if (["all", "codex", "claude"].includes(next)) {
        options.provider = next;
        i += 1;
      }
    }
  }

  return options;
}

function macProviderArgs(provider) {
  return provider === "all" ? "" : ` --provider ${shellQuote(provider)}`;
}

function macCommands(options) {
  const node = shellQuote(process.execPath);
  const batteryJs = shellQuote(path.join(scriptDir, "ai-battery.js"));
  const providerArgs = macProviderArgs(options.provider);
  const envPrefix = relevantEnvPrefix();
  return {
    title: `${envPrefix} ${node} ${batteryJs} --menu-bar${providerArgs} 2>/dev/null`,
    detail: `${envPrefix} ${node} ${batteryJs} --no-color${providerArgs} 2>/dev/null`
  };
}

function macHudPids() {
  const result = spawnSync("pgrep", ["-f", macStatusPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) return [];
  return (result.stdout || "")
    .trim()
    .split(/\s+/)
    .map((pid) => Number(pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

function macLaunchAgentPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", "com.ai-battery.hud.plist");
}

function macLaunchctlDomain() {
  return `gui/${typeof process.getuid === "function" ? process.getuid() : ""}`;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function plistString(value) {
  return `    <string>${xmlEscape(value)}</string>`;
}

function macAutostartPlist(options) {
  const args = [process.execPath, scriptPath, "start", "--interval", String(options.interval)];
  if (options.provider !== "all") args.push("--provider", options.provider);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ai-battery.hud</string>
  <key>ProgramArguments</key>
  <array>
${args.map(plistString).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

function macAutostartStatus() {
  const filePath = macLaunchAgentPath();
  return { enabled: fs.existsSync(filePath), filePath };
}

function macAutostartEnable(options) {
  const filePath = macLaunchAgentPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, macAutostartPlist(options), "utf8");
  spawnSync("launchctl", ["bootstrap", macLaunchctlDomain(), filePath], { stdio: "ignore" });
  return filePath;
}

function macAutostartDisable() {
  const filePath = macLaunchAgentPath();
  spawnSync("launchctl", ["bootout", macLaunchctlDomain(), filePath], { stdio: "ignore" });
  fs.rmSync(filePath, { force: true });
  return filePath;
}

function runMacHud(cliArgs) {
  const options = parseMacHudArgs(cliArgs);
  const commands = macCommands(options);

  if (options.once) {
    const result = spawnSync(process.execPath, [
      path.join(scriptDir, "ai-battery.js"),
      "--menu-bar",
      ...(options.provider === "all" ? [] : ["--provider", options.provider])
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    if (result.stdout) process.stdout.write(result.stdout);
    process.exit(result.status ?? 0);
  }

  if (options.subcommand === "status") {
    const pids = macHudPids();
    const auto = macAutostartStatus();
    console.log(`HUD: ${pids.length ? `running (PID ${pids[0]})` : "stopped"}`);
    console.log(`Autostart: ${auto.enabled ? "on" : "off"}`);
    if (auto.enabled) console.log(`  ${auto.filePath}`);
    process.exit(0);
  }

  if (options.subcommand === "autostart") {
    if (options.autostartAction === "on") {
      console.log(`HUD autostart enabled: ${macAutostartEnable(options)}`);
    } else if (options.autostartAction === "off") {
      console.log(`HUD autostart disabled: ${macAutostartDisable()}`);
    } else {
      const auto = macAutostartStatus();
      console.log(`Autostart: ${auto.enabled ? "on" : "off"}`);
      if (auto.enabled) console.log(`  ${auto.filePath}`);
    }
    process.exit(0);
  }

  if (options.stop) {
    const pids = macHudPids();
    if (!pids.length) {
      console.log("AI Battery menu bar is not running.");
      process.exit(0);
    }
    const result = spawnSync("kill", pids.map(String), { stdio: "inherit" });
    if ((result.status ?? 0) === 0) console.log("AI Battery menu bar stopped.");
    process.exit(result.status ?? 0);
  }

  if (macHudPids().length) {
    console.log("AI Battery menu bar is already running.");
    process.exit(0);
  }

  const osascriptArgs = [
    macStatusPath,
    commands.title,
    commands.detail,
    String(options.interval)
  ];

  if (options.foreground) {
    const result = spawnSync("osascript", osascriptArgs, { stdio: "inherit" });
    process.exit(result.status ?? 0);
  }

  const child = spawn("osascript", osascriptArgs, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  console.log("AI Battery menu bar started. Click the menu bar item for details; use \"ai-battery hud stop\" to close it.");
  process.exit(0);
}

if (process.platform === "darwin") {
  runMacHud(process.argv.slice(2));
}

const useWsl = isWsl();
const powershell = "powershell.exe";

if (!useWsl && process.platform !== "win32") {
  console.error("ai-battery-hud: desktop HUD needs Windows (native or WSL) or macOS.");
  console.error("On Linux terminals use: ai-battery --watch");
  process.exit(1);
}

if (!commandExists(powershell)) {
  console.error("ai-battery-hud: powershell.exe is required for the Windows HUD.");
  process.exit(1);
}

const filteredArgs = [];
let foreground = false;
let once = false;
let stop = false;
let subcommand = null;
let autostartAction = "status";

const cliArgs = process.argv.slice(2);
for (let i = 0; i < cliArgs.length; i += 1) {
  const arg = cliArgs[i];
  if (arg === "-Foreground" || arg === "--foreground") {
    foreground = true;
  } else if (arg === "-Movable" || arg === "--movable") {
    filteredArgs.push("-Movable");
  } else if (arg === "-Once" || arg === "--once") {
    once = true;
    filteredArgs.push("-Once");
  } else if (arg === "-Stop" || arg === "--stop" || arg === "stop") {
    stop = true;
    filteredArgs.push("-StopExisting");
  } else if (arg === "start") {
    // Launching is the default action.
  } else if (arg === "status") {
    subcommand = "status";
  } else if (arg === "autostart") {
    subcommand = "autostart";
    const next = cliArgs[i + 1];
    if (next === "on" || next === "off" || next === "status") {
      autostartAction = next;
      i += 1;
    }
  } else {
    filteredArgs.push(arg);
  }
}

const hudScript = useWsl ? wslPath(ps1Path) : ps1Path;
const nodePath = process.execPath;
const batteryJs = path.join(scriptDir, "ai-battery.js");
const configuredCommand = process.env.AI_BATTERY_COMMAND || process.env.CLAUDEX_BATTERY_COMMAND;
const envPrefix = useWsl ? wslEnvPrefix() : "";
const batteryCommand = configuredCommand || (useWsl
  ? `${envPrefix ? `${envPrefix} ` : ""}HOME=${shellQuote(os.homedir())} ${shellQuote(nodePath)} ${shellQuote(batteryJs)} --json`
  : `${winArgQuote(nodePath)} ${winArgQuote(batteryJs)} --json`);

const AUTOSTART_REG_PATH = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const AUTOSTART_REG_NAME = "AiBatteryHud";

function runPowerShell(command) {
  return spawnSync(powershell, ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    windowsHide: true
  });
}

function hudProcessStatus() {
  const query = "$hud = Get-CimInstance Win32_Process | Where-Object { "
    + "$_.ProcessId -ne $PID -and "
    + "$_.Name -match '^(powershell|pwsh)' -and "
    + "$_.CommandLine -like '*ai-battery-hud.ps1*' -and "
    + "$_.CommandLine -notlike '*Start-Process*' }; "
    + "if ($hud) { 'running (PID ' + @($hud)[0].ProcessId + ')' } else { 'stopped' }";
  const result = runPowerShell(query);
  return (result.stdout || "").trim() || "unknown";
}

function autostartStatus() {
  const result = runPowerShell(
    `$v = (Get-ItemProperty -Path '${AUTOSTART_REG_PATH}' -Name '${AUTOSTART_REG_NAME}' -ErrorAction SilentlyContinue).${AUTOSTART_REG_NAME}; `
    + "if ($v) { 'on'; $v } else { 'off' }"
  );
  const lines = (result.stdout || "").trim().split(/\r?\n/);
  return { enabled: lines[0] === "on", command: lines.slice(1).join("\n") || null };
}

function autostartEnable() {
  // autostart.ps1 refreshes the local copy of the HUD script when the source
  // is reachable (the WSL share is not mounted until the distro starts), then
  // launches the copy so sign-in start never depends on WSL being up. The HUD
  // must run as a separate "powershell -File ...ai-battery-hud.ps1" process:
  // stop/status and the single-instance cleanup all match that command line.
  const hudArgLiterals = [
    "'-NoProfile'",
    "'-ExecutionPolicy'",
    "'Bypass'",
    "'-File'",
    "('\"' + $hud + '\"')",
    "'-BatteryCommand'",
    "('\"' + ($battery -replace '\"', '\\\"') + '\"')"
  ];
  if (useWsl) hudArgLiterals.push("'-UseWsl'");

  const autostartScript = [
    "# Generated by: ai-battery hud autostart on",
    `$src = ${psSingleQuote(hudScript)}`,
    "$hud = Join-Path $PSScriptRoot 'ai-battery-hud.ps1'",
    "try { Copy-Item $src $hud -Force -ErrorAction Stop } catch { }",
    `$battery = ${psSingleQuote(batteryCommand)}`,
    `$argList = @(${hudArgLiterals.join(", ")}) -join ' '`,
    "Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList $argList",
    ""
  ].join("\r\n");
  const autostartB64 = Buffer.from(autostartScript, "utf8").toString("base64");

  const script = [
    "$dir = Join-Path $env:LOCALAPPDATA 'ai-battery'",
    "New-Item -ItemType Directory -Force -Path $dir | Out-Null",
    "$auto = Join-Path $dir 'autostart.ps1'",
    `[System.IO.File]::WriteAllText($auto, [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${autostartB64}')))`,
    `Copy-Item ${psSingleQuote(hudScript)} (Join-Path $dir 'ai-battery-hud.ps1') -Force`,
    `Set-ItemProperty -Path '${AUTOSTART_REG_PATH}' -Name '${AUTOSTART_REG_NAME}' -Value ('powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $auto + '"')`,
    "Write-Output $auto"
  ].join("; ");
  return runPowerShell(script);
}

function autostartDisable() {
  return runPowerShell(
    `Remove-ItemProperty -Path '${AUTOSTART_REG_PATH}' -Name '${AUTOSTART_REG_NAME}' -ErrorAction SilentlyContinue`
  );
}

if (subcommand === "status") {
  const auto = autostartStatus();
  console.log(`HUD: ${hudProcessStatus()}`);
  console.log(`Autostart: ${auto.enabled ? "on" : "off"}`);
  if (auto.command) console.log(`  ${auto.command}`);
  process.exit(0);
}

if (subcommand === "autostart") {
  if (autostartAction === "on") {
    const result = autostartEnable();
    const output = (result.stdout || "").trim();
    if (result.status !== 0 || !output) {
      console.error("ai-battery-hud: failed to register autostart.");
      if ((result.stderr || "").trim()) console.error((result.stderr || "").trim());
      process.exit(1);
    }
    console.log("HUD autostart enabled: launches at Windows sign-in.");
    console.log(`Launcher: ${output}`);
    console.log("After updating ai-battery, run \"ai-battery hud autostart on\" again to refresh it.");
  } else if (autostartAction === "off") {
    autostartDisable();
    console.log("HUD autostart disabled.");
  } else {
    const auto = autostartStatus();
    console.log(`Autostart: ${auto.enabled ? "on" : "off"}`);
    if (auto.command) console.log(`  ${auto.command}`);
  }
  process.exit(0);
}

const initialJson = stop ? null : prefetchInitialJson(batteryCommand, useWsl);

const psArgs = [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  hudScript,
  "-BatteryCommand",
  batteryCommand,
  ...filteredArgs
];

if (initialJson) {
  psArgs.push("-InitialJsonBase64", Buffer.from(initialJson, "utf8").toString("base64"));
}

if (useWsl) {
  psArgs.push("-UseWsl");
}

if (foreground || once || stop) {
  const result = spawnSync(powershell, psArgs, { stdio: "inherit", windowsHide: true });
  if (stop && (result.status ?? 0) === 0) {
    console.log("AI Battery HUD stopped.");
  }
  process.exit(result.status ?? 0);
}

if (useWsl) {
  const start = spawnSync(powershell, [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    buildStartProcessCommand("powershell.exe", psArgs)
  ], {
    stdio: "ignore",
    windowsHide: true
  });
  if (start.status !== 0) process.exit(start.status ?? 1);
} else {
  const child = spawn(powershell, psArgs, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

console.log("AI Battery HUD started or already running. Drag it to place it; right-click and choose Exit to close.");
