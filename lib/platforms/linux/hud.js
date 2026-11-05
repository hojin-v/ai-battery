import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cliError, cliText, helpText, invalidChoice, requiredValue } from "../../core/cli-help.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const marker = "X-AI-Battery-Managed=true";
const busPrefix = "org.hnode.AiBattery.Hud";

export function linuxHudStateDir(env = process.env, home = os.homedir()) {
  return env.AI_BATTERY_STATE_DIR || env.CLAUDEX_BATTERY_STATE_DIR
    || path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "ai-battery");
}

export function linuxHudBusName(root) {
  return `${busPrefix}.state_${crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16)}`;
}

export function parseLinuxHudArgs(argv) {
  const options = { action: "start", autostart: "status", interval: 10, provider: "all", foreground: false, once: false };
  let actionSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (["start", "stop", "status", "autostart"].includes(arg) && !actionSeen) {
      options.action = arg;
      actionSeen = true;
      if (arg === "autostart" && ["on", "off", "status"].includes(argv[i + 1])) options.autostart = argv[++i];
    } else if (["--interval", "-Interval"].includes(arg)) {
      const value = requiredValue(argv, i, "hud");
      options.interval = Number(value);
      if (!Number.isFinite(options.interval) || options.interval < 1) throw cliError("--interval must be at least 1 second.", "--interval은 1초 이상이어야 합니다.", "hud");
      i += 1;
    } else if (arg === "--provider" || arg === "-p") {
      options.provider = requiredValue(argv, i, "hud");
      if (!["all", "codex", "claude"].includes(options.provider)) throw invalidChoice(arg, "all, codex, claude", "hud");
      i += 1;
    } else if (arg === "--foreground" || arg === "-Foreground") {
      options.foreground = true;
    } else if (arg === "--once" || arg === "-Once") {
      options.once = true;
    } else if (arg === "--stop" || arg === "-Stop") {
      options.action = "stop";
      actionSeen = true;
    } else {
      throw cliError(`Unknown HUD command or option: ${arg}.`, `알 수 없는 HUD 명령 또는 옵션: ${arg}.`, "hud");
    }
  }
  return options;
}

export function desktopExecArg(value) {
  if (/[\r\n\0]/.test(String(value))) throw new Error("Invalid newline in desktop command");
  // Desktop Entry string escaping is decoded before Exec argument quoting.
  return `"${String(value).replace(/%/g, "%%").replace(/\\/g, "\\\\\\\\").replace(/["`$]/g, char => `\\\\${char}`)}"`;
}

export function createLinuxHudPlatform({ scriptDir, home = os.homedir(), env = process.env,
  run = spawnSync, launch = spawn, node = process.execPath } = {}) {
  const root = linuxHudStateDir(env, home);
  const bus = linuxHudBusName(root);
  const native = path.join(directory, "panel.js");
  const gjs = env.AI_BATTERY_GJS || (fs.existsSync("/usr/bin/gjs") ? "/usr/bin/gjs" : "gjs");
  const desktopFile = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "autostart", "ai-battery-hud.desktop");
  const hudEntry = path.join(scriptDir || path.resolve(directory, "../../../bin"), "ai-battery-hud.js");

  function control(action) {
    const result = run(gjs, ["-m", native, "--bus-name", bus, "--control", action], { env, encoding: "utf8", timeout: 4000 });
    if (result.error || result.status !== 0) {
      if (action === "status") return { running: false, error: result.error?.message || result.stderr?.trim() };
      throw new Error(result.error?.message || result.stderr?.trim() || "Linux HUD control failed");
    }
    return JSON.parse(result.stdout);
  }

  function verifyAutostart() {
    let stat;
    try { stat = fs.lstatSync(desktopFile); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    const text = stat.isFile() && !stat.isSymbolicLink() ? fs.readFileSync(desktopFile, "utf8") : "";
    if (!text.split(/\r?\n/).includes(marker) || !/^Exec=.*ai-battery-hud\.js/m.test(text)) {
      throw new Error(`Linux autostart ownership could not be verified; left untouched: ${desktopFile}`);
    }
    return true;
  }

  function linuxAutostartEnable(options) {
    verifyAutostart();
    const names = ["AI_BATTERY_STATE_DIR", "CLAUDEX_BATTERY_STATE_DIR", "AI_BATTERY_DATA_DIR", "AI_BATTERY_SHARED_USAGE_STATE_DIR", "XDG_STATE_HOME", "XDG_DATA_HOME", "CODEX_HOME", "LANGUAGE"];
    const vars = [`HOME=${home}`, ...names.filter(name => env[name]).map(name => `${name}=${env[name]}`)];
    const command = ["/usr/bin/env", ...vars, node, hudEntry, "start", "--interval", String(options.interval), "--provider", options.provider];
    const text = ["[Desktop Entry]", "Type=Application", "Version=1.0", "Name=AI Battery", "Comment=Codex and Claude usage in the panel",
      `Exec=${command.map(desktopExecArg).join(" ")}`, "Terminal=false", "X-GNOME-Autostart-enabled=true", marker, ""].join("\n");
    fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
    fs.writeFileSync(desktopFile, text, { mode: 0o600 });
    return desktopFile;
  }

  function linuxAutostartDisable() {
    if (verifyAutostart()) fs.unlinkSync(desktopFile);
    return desktopFile;
  }

  function runLinuxHud(argv) {
    if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
      console.log(helpText("hud", { platform: "linux" }));
      return;
    }
    const options = parseLinuxHudArgs(argv);
    if (options.action === "autostart") {
      if (options.autostart === "on") {
        console.log(`Autostart: on · ${linuxAutostartEnable(options)}`);
        console.log(cliText("Starts at desktop login.", "데스크톱 로그인 시 실행합니다."));
      } else if (options.autostart === "off") console.log(`Autostart: off · ${linuxAutostartDisable()}`);
      else console.log(`Autostart: ${verifyAutostart() ? "on" : "off"}`);
      return;
    }
    if (options.once) {
      const result = run(node, [path.join(path.dirname(hudEntry), "ai-battery.js"), "--menu-bar", "--provider", options.provider], { env, stdio: "inherit" });
      process.exitCode = result.status ?? 1;
      return;
    }
    const status = control("status");
    if (options.action === "status") {
      console.log(`HUD: ${status.running ? `running (PID ${status.pid})` : "stopped"} · Linux panel`);
      if (status.running && !status.registered) console.log(cliText("Waiting for the desktop panel; reconnects automatically after unlock.", "데스크톱 패널 대기 중 · 잠금 해제 후 자동 연결됩니다."));
      console.log(`Autostart: ${verifyAutostart() ? "on" : "off"}`);
      return;
    }
    if (status.running) control("quit");
    for (let i = 0; status.running && control("status").running && i < 15; i += 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    if (status.running && control("status").running) throw new Error("Linux HUD is still stopping; retry shortly");
    if (options.action === "stop") { console.log("HUD: stopped"); return; }

    const probe = run(gjs, ["-m", native, "--probe"], { env, encoding: "utf8", timeout: 4000 });
    if (probe.error || probe.status !== 0) {
      throw new Error(cliText("Linux panel dependencies are missing. Install: sudo apt install gjs gir1.2-dbusmenu-glib-0.4", "Linux 패널 구성 요소가 없습니다. 설치: sudo apt install gjs gir1.2-dbusmenu-glib-0.4"));
    }
    const available = JSON.parse(probe.stdout);
    if (!available.sessionAvailable || (!available.hostAvailable && !env.DISPLAY && !env.WAYLAND_DISPLAY)) {
      throw new Error(cliText("Run the Linux HUD inside your graphical desktop session.", "Linux HUD는 그래픽 데스크톱 세션에서 실행하세요."));
    }
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const ready = path.join(root, `hud-snapshot-linux-ready-${process.pid}-${Date.now()}.json`);
    const args = ["-m", native, "--bus-name", bus, "--node", node, "--snapshot", path.join(directory, "panel-snapshot.js"),
      "--interval", String(options.interval), "--provider", options.provider, "--state-dir", root, "--ready", ready];
    if (options.foreground) {
      const result = run(gjs, args, { env, stdio: "inherit" });
      process.exitCode = result.status ?? 1;
      return;
    }
    const logFile = path.join(root, "linux-hud.log");
    const fd = fs.openSync(logFile, "a", 0o600);
    let child;
    try { child = launch(gjs, args, { env, detached: true, stdio: ["ignore", fd, fd] }); }
    finally { fs.closeSync(fd); }
    child.unref();
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !fs.existsSync(ready)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    if (!fs.existsSync(ready)) {
      if (control("status").running) control("quit");
      throw new Error(cliText(`Linux HUD did not become ready. Log: ${logFile}`, `Linux HUD를 시작하지 못했습니다. 로그: ${logFile}`));
    }
    const readyState = JSON.parse(fs.readFileSync(ready, "utf8"));
    fs.unlinkSync(ready);
    console.log(`HUD: ${readyState.registered ? status.running ? "restarted" : "started" : "waiting"} · Linux panel`);
    console.log(readyState.registered
      ? cliText("Click for details. Stop: ai-battery hud stop", "클릭하면 상세 정보가 표시됩니다. 종료: ai-battery hud stop")
      : cliText("The panel reconnects automatically. On Ubuntu, enable Ubuntu AppIndicators if needed.", "패널이 활성화되면 자동 연결됩니다. Ubuntu에서는 Ubuntu AppIndicators를 활성화하세요."));
  }

  return { runLinuxHud, linuxAutostartEnable, linuxAutostartDisable, linuxHudControl: control, desktopFile, busName: bus };
}
