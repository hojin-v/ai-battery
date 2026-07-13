#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMacHudPlatform } from "../platforms/macos/hud.js";
import { isWsl } from "../platforms/runtime.js";
import { createWindowsHudPlatform } from "../platforms/windows/hud-launcher.js";

const scriptPath = fs.realpathSync(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(path.dirname(scriptPath), "../..");
const scriptDir = path.join(projectRoot, "bin");
const ps1Path = path.join(scriptDir, "ai-battery-hud.ps1");
const windowsHudSourceDir = path.resolve(scriptDir, "../lib/platforms/windows/hud");
const windowsHudMainPath = path.join(windowsHudSourceDir, "main.ps1");
const macStatusPath = path.join(scriptDir, "ai-battery-macos-status.applescript");

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
    "AI_BATTERY_SHARED_USAGE_STATE_DIR",
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

function psInvocationArg(value) {
  const text = String(value);
  if (/^-[A-Za-z][A-Za-z0-9]*$/.test(text)) return text;
  return psSingleQuote(text);
}

function powerShellCommandArgs(scriptPath, scriptArgs) {
  const invocation = `& ${psSingleQuote(scriptPath)} ${scriptArgs.map(psInvocationArg).join(" ")}`;
  return [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    invocation
  ];
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(filePath, timeoutMs = 3500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) return true;
    sleepSync(100);
  }
  return false;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === scriptPath;
  } catch {
    return false;
  }
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

function prefetchInitialJson(command, useWslCommand, batteryModulePath = path.join(scriptDir, "ai-battery.js")) {
  if (process.env.AI_BATTERY_HUD_NO_PREFETCH) return null;

  const attempts = 8;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = useWslCommand
      ? spawnSync("bash", ["-lc", command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 })
      : spawnSync(process.execPath, [batteryModulePath, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });

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
    "AI_BATTERY_SHARED_USAGE_STATE_DIR",
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

const useWsl = isWsl();

const {
  macHudCommandMatches,
  macHudPidsFromPsOutput,
  runMacHud
} = createMacHudPlatform({ macStatusPath, relevantEnvPrefix, scriptDir, shellQuote });
const {
  describeWindowsHudOptions,
  parseWindowsHudArgs,
  runDesktopHud,
  windowsHudUsage
} = createWindowsHudPlatform({
  buildStartProcessCommand,
  commandExists,
  macRunHud: runMacHud,
  powerShellCommandArgs,
  prefetchInitialJson,
  ps1Path,
  psSingleQuote,
  scriptDir,
  shellQuote,
  useWsl,
  waitForFile,
  winArgQuote,
  windowsHudMainPath,
  windowsHudSourceDir,
  wslEnvPrefix,
  wslPath
});
if (isDirectRun()) {
  runDesktopHud(process.argv.slice(2));
}

export {
  macHudCommandMatches,
  macHudPidsFromPsOutput,
  describeWindowsHudOptions,
  prefetchInitialJson,
  parseWindowsHudArgs,
  runDesktopHud,
  windowsHudUsage
};
