import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function createMacHudPlatform({ macStatusPath, relevantEnvPrefix, scriptDir, shellQuote }) {
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
    title: `${envPrefix} ${node} ${batteryJs} --menu-bar-image${providerArgs} 2>/dev/null`,
    detailImage: `${envPrefix} ${node} ${batteryJs} --menu-detail-image${providerArgs} 2>/dev/null`,
    detail: `${envPrefix} ${node} ${batteryJs} --no-color${providerArgs} 2>/dev/null`,
    state: `${envPrefix} ${node} ${batteryJs} --hud-state${providerArgs} 2>/dev/null`
  };
}

function macHudPids() {
  const result = spawnSync("ps", ["-axo", "pid=,args="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) return [];
  return macHudPidsFromPsOutput(result.stdout, process.pid);
}

function macHudCommandMatches(cmdline) {
  const text = String(cmdline || "").trim();
  if (!text.includes("ai-battery-macos-status.applescript")) return false;
  if (!text.includes("--menu-bar-image") || !text.includes("--menu-detail-image")) return false;
  return path.basename(text.split(/\s+/, 1)[0] || "") === "osascript";
}

function macHudPidsFromPsOutput(output, ownPid = process.pid) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!match) return null;
      return { pid: Number(match[1]), cmdline: match[2] };
    })
    .filter((proc) => proc
      && Number.isInteger(proc.pid)
      && proc.pid > 0
      && proc.pid !== ownPid
      && macHudCommandMatches(proc.cmdline))
    .map((proc) => proc.pid);
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

  const existingPids = macHudPids();
  if (existingPids.length) {
    spawnSync("kill", existingPids.map(String), { stdio: "ignore" });
    sleepSync(400);
  }

  const osascriptArgs = [
    macStatusPath,
    commands.title,
    commands.detailImage,
    commands.detail,
    String(options.interval),
    commands.state
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
  console.log(`${existingPids.length ? "AI Battery menu bar restarted" : "AI Battery menu bar started"}. Click the menu bar item for details; use "ai-battery hud stop" to close it.`);
  process.exit(0);
}

  return {
    macHudCommandMatches,
    macHudPidsFromPsOutput,
    runMacHud
  };
}
