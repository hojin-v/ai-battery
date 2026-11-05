import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gnomeHudMetadata } from "../lib/platforms/linux/gnome.js";
import { linuxHudBusName } from "../lib/platforms/linux/hud.js";

const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtime = process.env.AI_BATTERY_MENU_PACKAGE || source;
const root = path.resolve(process.argv[2] || path.join(source, ".cache/linux-gnome-menu"));
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(root, "runtime"), { recursive: true, mode: 0o700 });
fs.rmSync(path.join(root, "result.json"), { force: true });
const bundle = fs.mkdtempSync(path.join(root, "bundle-"));
fs.copyFileSync(path.join(runtime, "lib/platforms/linux/gnome-extension/extension.js"), path.join(bundle, "extension.js"));
fs.writeFileSync(path.join(bundle, "metadata.json"), JSON.stringify(gnomeHudMetadata));
const zip = path.join(bundle, "extension.zip");
const packed = spawnSync("zip", ["-q", zip, "metadata.json", "extension.js"], { cwd: bundle });
if (packed.status !== 0) throw new Error("Could not pack the GNOME HUD extension");
const home = path.join(root, "home");
const codex = path.join(root, "codex");
fs.mkdirSync(path.join(codex, "sessions"), { recursive: true });
const reset = Math.floor(Date.now() / 1000) + 3600;
fs.writeFileSync(path.join(codex, "sessions/test.jsonl"), JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg",
  payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 26, window_minutes: 300, resets_at: reset },
    secondary: { used_percent: 12, window_minutes: 10080, resets_at: reset + 86400 } } } }) + "\n");
const env = { ...process.env, HOME: home, CODEX_HOME: codex, LANGUAGE: "ko", GIO_USE_VFS: "local",
  XDG_RUNTIME_DIR: path.join(root, "runtime"), GTK_USE_PORTAL: "0",
  AI_BATTERY_STATE_DIR: path.join(root, "state"), AI_BATTERY_DATA_DIR: path.join(root, "data"),
  AI_BATTERY_SHARED_USAGE_STATE_DIR: path.join(root, "shared"), AI_BATTERY_NO_UPDATE_CHECK: "1",
  AI_BATTERY_MENU_ROOT: root, AI_BATTERY_MENU_SOURCE: runtime, AI_BATTERY_MENU_NODE: process.execPath,
  AI_BATTERY_MENU_BUS: linuxHudBusName(path.join(root, "state")) };
for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "GNOME_KEYRING_CONTROL", "GNOME_SETUP_DISPLAY", "SESSION_MANAGER", "DBUS_STARTER_ADDRESS", "DBUS_STARTER_BUS_TYPE"]) delete env[key];
const on = spawnSync(process.execPath, [path.join(runtime, "bin/ai-battery.js"), "on", "all"], { env, encoding: "utf8" });
if (on.status !== 0) throw new Error(on.stderr);
const capture = spawnSync(process.execPath, [path.join(runtime, "bin/ai-battery.js"), "capture-claude", "--no-header"], {
  env, input: JSON.stringify({ session_id: "menu-preview", rate_limits: {
    five_hour: { used_percentage: 24, resets_at: reset, window_minutes: 300 },
    seven_day: { used_percentage: 41, resets_at: reset + 86400, window_minutes: 10080 } } }), encoding: "utf8"
});
if (capture.status !== 0) throw new Error(capture.stderr);
const result = spawnSync("timeout", ["--kill-after=3", "40s", "dbus-run-session", "--", "gnome-shell-test-tool", "--headless", "--extension", zip,
  path.join(source, "scripts/linux-gnome-menu-smoke.js")], { env, encoding: "utf8", timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
fs.writeFileSync(path.join(root, "shell.log"), result.stdout + result.stderr);
fs.rmSync(bundle, { recursive: true, force: true });
if (result.status !== 0) { console.error(result.error || result.stderr.split("\n").slice(-30).join("\n")); process.exitCode = 1; }
else console.log(fs.readFileSync(path.join(root, "result.json"), "utf8"));
