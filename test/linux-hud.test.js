import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createLinuxHudPlatform, desktopExecArg, linuxHudBusName, linuxHudStateDir, parseLinuxHudArgs } from "../lib/platforms/linux/hud.js";
import { cleanupBatteryArtifacts } from "../lib/core/uninstall.js";
import { createGnomeHudIntegration, gnomeHudMetadata } from "../lib/platforms/linux/gnome.js";

const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const linux = { skip: process.platform !== "linux" };
const nativeAvailable = process.platform === "linux"
  && spawnSync("dbus-run-session", ["--version"], { stdio: "ignore" }).status === 0
  && spawnSync("gjs", ["-c", "imports.gi.versions.Dbusmenu='0.4'; void imports.gi.Dbusmenu; void imports.gi.GdkPixbuf;"], { stdio: "ignore" }).status === 0;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-linux-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "xdg-data"), AI_BATTERY_STATE_DIR: path.join(root, "state") };
  const hud = createLinuxHudPlatform({ home, env, scriptDir: path.join(source, "bin") });
  return { root, home, env, hud };
}

test("Linux HUD options accept desktop controls and reject Windows-specific options", () => {
  assert.deepEqual(parseLinuxHudArgs(["--interval", "2", "--provider", "codex", "start"]), {
    action: "start", autostart: "status", interval: 2, provider: "codex", foreground: false, once: false
  });
  assert.equal(parseLinuxHudArgs(["autostart", "on"]).autostart, "on");
  assert.equal(parseLinuxHudArgs(["--stop"]).action, "stop");
  for (const args of [["--interval"], ["--interval", "0"], ["--interval", "Infinity"], ["--provider", "invalid"],
    ["--dock-console"], ["--text", "white"], ["black"], ["start", "stop"], ["autostart", "invalid"]]) {
    assert.throws(() => parseLinuxHudArgs(args), /ai-battery hud --help/);
  }
});

test("Linux HUD bus names follow isolated state roots across package locations", () => {
  assert.equal(linuxHudStateDir({ XDG_STATE_HOME: "/private/state" }), path.join("/private/state", "ai-battery"));
  assert.equal(linuxHudStateDir({ AI_BATTERY_STATE_DIR: "portable" }), "portable");
  const left = linuxHudBusName("/private/state/ai-battery");
  assert.equal(left, linuxHudBusName("/private/state/./ai-battery"));
  assert.notEqual(left, linuxHudBusName("/another/state/ai-battery"));
  assert.match(left, /^org\.hnode\.AiBattery\.Hud\.state_[a-f0-9]{16}$/);
});

test("Linux autostart preserves foreign files and symlinks", linux, (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.hud.desktopFile), { recursive: true });
  fs.writeFileSync(f.hud.desktopFile, "[Desktop Entry]\nName=Another app\nExec=/bin/true\n");
  const before = fs.readFileSync(f.hud.desktopFile, "utf8");
  assert.throws(() => f.hud.linuxAutostartEnable(parseLinuxHudArgs([])), /ownership/);
  assert.throws(() => f.hud.linuxAutostartDisable(), /ownership/);
  assert.equal(fs.readFileSync(f.hud.desktopFile, "utf8"), before);
  fs.unlinkSync(f.hud.desktopFile);
  const target = path.join(f.root, "foreign.desktop");
  fs.writeFileSync(target, before);
  fs.symlinkSync(target, f.hud.desktopFile);
  assert.throws(() => f.hud.linuxAutostartEnable(parseLinuxHudArgs([])), /ownership/);
  assert.throws(() => f.hud.linuxAutostartDisable(), /ownership/);
  assert.equal(fs.readFileSync(target, "utf8"), before);
});

test("Linux desktop startup preserves argv and environment without shell expansion", { skip: !nativeAvailable }, (t) => {
  const f = fixture(t);
  const bin = path.join(f.root, '사용자 path "quotes" $HOME `cmd` 50% \\');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(f.root, "launched.json");
  fs.writeFileSync(path.join(bin, "ai-battery-hud.js"), `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2),home:process.env.HOME,codex:process.env.CODEX_HOME,language:process.env.LANGUAGE}));`);
  f.env.CODEX_HOME = '/tmp/코덱스 home $literal "quote" 80%';
  f.env.LANGUAGE = "ko";
  const hud = createLinuxHudPlatform({ home: f.home, env: f.env, scriptDir: bin });
  const file = hud.linuxAutostartEnable(parseLinuxHudArgs(["--interval", "2", "--provider", "claude"]));
  const result = spawnSync("gio", ["launch", file], { env: f.env, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(log) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  assert.ok(fs.existsSync(log), "Desktop entry did not launch the expected executable");
  assert.deepEqual(JSON.parse(fs.readFileSync(log, "utf8")), {
    argv: ["start", "--interval", "2", "--provider", "claude"], home: f.home, codex: f.env.CODEX_HOME, language: "ko"
  });
  hud.linuxAutostartDisable();
  assert.equal(fs.existsSync(file), false);
  assert.throws(() => desktopExecArg("line\nbreak"));
});

test("Linux reset only removes owned panel artwork and logs", linux, (t) => {
  const f = fixture(t);
  const state = f.env.AI_BATTERY_STATE_DIR;
  const icon = path.join(state, "linux-hud", `icon-${"a".repeat(64)}.svg`);
  const note = path.join(state, "linux-hud", "notes.svg");
  const detail = path.join(state, "linux-hud", `detail-${"b".repeat(64)}.svg`);
  fs.mkdirSync(path.dirname(icon), { recursive: true });
  fs.writeFileSync(icon, "<svg/>");
  fs.writeFileSync(detail, "<svg/>");
  fs.writeFileSync(note, "user content");
  fs.writeFileSync(path.join(state, "linux-hud.log"), "owned log");
  const result = cleanupBatteryArtifacts({ roots: [state], home: f.home });
  assert.deepEqual(result.errors, []);
  assert.equal(fs.existsSync(icon), false);
  assert.equal(fs.existsSync(detail), false);
  assert.equal(fs.existsSync(path.join(state, "linux-hud.log")), false);
  assert.equal(fs.readFileSync(note, "utf8"), "user content");
});

function gnomeFixture(t, info = { available: true, version: "50.1", allowed: true, state: null }) {
  const f = fixture(t);
  const calls = [];
  const integration = createGnomeHudIntegration({ home: f.home, env: { ...f.env, XDG_DATA_HOME: path.join(f.root, "data") },
    run(_command, argv) {
      calls.push(argv.at(-1));
      return { status: 0, stdout: JSON.stringify({ ...info, accepted: info.state !== null }) };
    } });
  return { ...f, integration, calls, info };
}

test("GNOME menu integration installs once and removes only its own files", (t) => {
  const f = gnomeFixture(t);
  assert.equal(f.integration.prepare().pending, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.integration.target, "metadata.json"), "utf8")), gnomeHudMetadata);
  assert.match(fs.readFileSync(path.join(f.integration.target, "extension.js"), "utf8"), /AI Battery managed GNOME panel/);
  f.info.state = 1;
  assert.equal(f.integration.prepare().pending, false);
  const note = path.join(f.integration.target, "notes.txt");
  fs.writeFileSync(note, "user data");
  assert.equal(f.integration.remove().changed, true);
  assert.equal(fs.existsSync(path.join(f.integration.target, "extension.js")), false);
  assert.equal(fs.readFileSync(note, "utf8"), "user data");
  assert.equal(f.calls.at(-1), "disable");
});

test("GNOME menu integration preserves foreign files and symlink replacements", linux, (t) => {
  const f = gnomeFixture(t);
  fs.mkdirSync(f.integration.target, { recursive: true });
  const metadata = path.join(f.integration.target, "metadata.json");
  const code = path.join(f.integration.target, "extension.js");
  fs.writeFileSync(metadata, JSON.stringify({ uuid: gnomeHudMetadata.uuid }));
  fs.writeFileSync(code, "foreign code");
  assert.throws(() => f.integration.prepare(), /ownership/);
  assert.throws(() => f.integration.remove(), /ownership/);
  assert.equal(fs.readFileSync(code, "utf8"), "foreign code");
  fs.writeFileSync(metadata, JSON.stringify(gnomeHudMetadata));
  const foreign = path.join(f.root, "foreign.js");
  fs.writeFileSync(foreign, "keep this");
  fs.unlinkSync(code);
  fs.symlinkSync(foreign, code);
  assert.throws(() => f.integration.prepare(), /ownership/);
  assert.throws(() => f.integration.remove(), /ownership/);
  assert.equal(fs.readFileSync(foreign, "utf8"), "keep this");
  assert.ok(f.calls.every(action => action === "info"));
});

test("Other desktops retain their standard tray without installing a GNOME extension", (t) => {
  for (const info of [{ available: false }, { available: true, version: "44.0" }]) {
    const f = gnomeFixture(t, info);
    assert.deepEqual(f.integration.prepare(), { supported: false });
    assert.equal(fs.existsSync(f.integration.target), false);
    assert.deepEqual(f.calls, ["info"]);
  }
});

// A private session bus exercises the real GJS service without touching the user's panel.
async function linuxSessionScenario() {
  const assert = (await import("node:assert/strict")).default;
  const fs = (await import("node:fs")).default;
  const path = (await import("node:path")).default;
  const { spawn, spawnSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const source = process.env.AI_BATTERY_TEST_SOURCE;
  const root = process.env.AI_BATTERY_TEST_ROOT;
  const { createLinuxHudPlatform } = await import(pathToFileURL(path.join(source, "lib/platforms/linux/hud.js")));
  const cli = path.join(source, "bin/ai-battery.js");
  const env = { ...process.env, HOME: path.join(root, "home"), CODEX_HOME: path.join(root, "codex"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "xdg-data"), GIO_USE_VFS: "local",
    AI_BATTERY_STATE_DIR: path.join(root, "state"), AI_BATTERY_DATA_DIR: path.join(root, "data"),
    AI_BATTERY_SHARED_USAGE_STATE_DIR: path.join(root, "shared"), DISPLAY: ":test", LANGUAGE: "ko", AI_BATTERY_NO_UPDATE_CHECK: "1" };
  fs.mkdirSync(path.join(env.CODEX_HOME, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(env.CODEX_HOME, "sessions", "test.jsonl"), JSON.stringify({
    timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "token_count", rate_limits: { limit_id: "codex",
      primary: { used_percent: 26, window_minutes: 300, resets_at: 4102444800 } } }
  }) + "\n");
  const mode = path.join(root, "worker-mode");
  fs.writeFileSync(mode, "ok");
  const nodeWrapper = path.join(root, "node-wrapper");
  fs.writeFileSync(nodeWrapper, `#!/usr/bin/env node\nconst fs=require('node:fs');if(fs.readFileSync(${JSON.stringify(mode)},'utf8')==='error'){console.error('fixture usage failure');process.exit(1)}const r=require('node:child_process').spawnSync(${JSON.stringify(process.execPath)},process.argv.slice(2),{stdio:'inherit',env:process.env});process.exit(r.status??1);`, { mode: 0o755 });
  const hud = createLinuxHudPlatform({ env, home: env.HOME, scriptDir: path.dirname(cli), node: nodeWrapper });
  const wait = async predicate => {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.fail("Timed out waiting for Linux panel state");
  };
  const watcherPath = path.join(root, "watcher.js");
  const watcherReady = path.join(root, "watcher-ready");
  fs.writeFileSync(watcherPath, `import Gio from 'gi://Gio';import GLib from 'gi://GLib';
    const xml='<node><interface name="org.kde.StatusNotifierWatcher"><method name="RegisterStatusNotifierItem"><arg type="s" direction="in"/></method></interface></node>';
    let exported;const owner=Gio.bus_own_name(Gio.BusType.SESSION,'org.kde.StatusNotifierWatcher',Gio.BusNameOwnerFlags.NONE,c=>{exported=Gio.DBusExportedObject.wrapJSObject(xml,{RegisterStatusNotifierItem(){}});exported.export(c,'/StatusNotifierWatcher');},()=>{GLib.file_set_contents(ARGV[0],new TextEncoder().encode('ready'));},()=>{});
    new GLib.MainLoop(null,false).run();`);
  let watcher;
  let presenter;
  const startWatcher = async () => {
    fs.rmSync(watcherReady, { force: true });
    watcher = spawn("gjs", ["-m", watcherPath, watcherReady], { env, stdio: "ignore" });
    await wait(() => fs.existsSync(watcherReady));
  };
  const stopWatcher = async () => {
    if (!watcher) return;
    const ended = new Promise(resolve => watcher.once("exit", resolve));
    watcher.kill("SIGTERM");
    await ended;
    watcher = null;
  };
  const probePath = path.join(root, "probe.js");
  fs.writeFileSync(probePath, `import Gio from 'gi://Gio';import GLib from 'gi://GLib';
    function unpack(v){if(v instanceof GLib.Variant)return unpack(v.deepUnpack());if(Array.isArray(v))return v.map(unpack);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,unpack(x)]));return v;}
    const properties=unpack(Gio.DBus.session.call_sync(ARGV[0],'/StatusNotifierItem','org.freedesktop.DBus.Properties','GetAll',new GLib.Variant('(s)',['org.kde.StatusNotifierItem']),null,Gio.DBusCallFlags.NONE,3000,null))[0];
    const layout=unpack(Gio.DBus.session.call_sync(ARGV[0],'/Menu','com.canonical.dbusmenu','GetLayout',new GLib.Variant('(iias)',[0,-1,['label','visible']]),null,Gio.DBusCallFlags.NONE,3000,null));
    print(JSON.stringify({properties,labels:layout[1][2].map(row=>row[1].label).filter(Boolean)}));`);
  const probe = () => {
    const result = spawnSync("gjs", ["-m", probePath, hud.busName], { env, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const status = () => hud.linuxHudControl("status");
  const capture = [];
  console.log = text => capture.push(text);
  try {
    hud.runLinuxHud(["--interval", "1"]);
    assert.ok(capture.some(line => line.includes("HUD: waiting")));
    assert.equal(status().registered, false);
    await startWatcher();
    await wait(() => status().registered);
    const initial = status();
    assert.equal(initial.rows.find(row => row.provider === "codex").percent, 74);
    const view = probe();
    assert.equal(view.properties.ItemIsMenu, true);
    assert.equal(view.properties.Menu, "/Menu");
    assert.ok(view.labels.some(label => /Codex.*74%/.test(label)));
    assert.ok(view.labels.includes("새로고침"));
    assert.ok(view.labels.includes("AI Battery 종료"));
    const artwork = fs.readFileSync(initial.icon, "utf8");
    assert.match(artwork, /#315CFF/);
    assert.match(artwork, /#D97706/);
    assert.equal(fs.readFileSync(initial.detailImage, "utf8"), fs.readFileSync(path.join(env.AI_BATTERY_STATE_DIR, "macos-menu-detail.svg"), "utf8"));
    assert.match(fs.readFileSync(initial.detailImage, "utf8"), /width="392"/);
    const presenterPath = path.join(root, "presenter.js");
    const presenterReady = path.join(root, "presenter-ready");
    fs.writeFileSync(presenterPath, `import Gio from 'gi://Gio';import GLib from 'gi://GLib';
      Gio.DBus.session.call_sync(ARGV[0],'/org/hnode/AiBattery/Hud','org.hnode.AiBattery.Hud','Claim',null,null,Gio.DBusCallFlags.NONE,3000,null);
      GLib.file_set_contents(ARGV[1],new TextEncoder().encode('ready'));new GLib.MainLoop(null,false).run();`);
    presenter = spawn("gjs", ["-m", presenterPath, hud.busName, presenterReady], { env, stdio: "ignore" });
    await wait(() => fs.existsSync(presenterReady));
    assert.equal(status().presentation, "gnome");
    assert.equal(probe().properties.Status, "Passive");
    const presenterEnded = new Promise(resolve => presenter.once("exit", resolve));
    presenter.kill("SIGTERM");
    await presenterEnded;
    presenter = null;
    await wait(() => status().presentation === "status-notifier");
    assert.equal(probe().properties.Status, "Active");

    fs.writeFileSync(mode, "error");
    hud.linuxHudControl("refresh");
    await wait(() => status().error?.includes("fixture usage failure"));
    assert.equal(status().icon, initial.icon);
    assert.ok(probe().labels.some(label => label.includes("사용량 조회 실패")));
    fs.writeFileSync(mode, "ok");
    hud.linuxHudControl("refresh");
    await wait(() => !status().error);

    const off = spawnSync(process.execPath, [cli, "off", "codex"], { env, encoding: "utf8" });
    assert.equal(off.status, 0, off.stderr);
    hud.linuxHudControl("refresh");
    await wait(() => status().rows.every(row => row.provider !== "codex"));
    assert.ok(!probe().labels.some(label => label.startsWith("Codex")));

    await stopWatcher();
    await wait(() => !status().registered);
    await startWatcher();
    await wait(() => status().registered);
    hud.runLinuxHud(["start", "--provider", "claude"]);
    assert.notEqual(status().pid, initial.pid);
    assert.equal(status().provider, "claude");
    assert.throws(() => hud.runLinuxHud(["--dock-console"]));
    assert.equal(status().running, true);
    hud.runLinuxHud(["stop"]);
    assert.equal(status().running, false);
    hud.runLinuxHud(["autostart", "on"]);
    hud.runLinuxHud(["start"]);
    const reset = spawnSync(process.execPath, [cli, "reset", "hud", "--json"], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(status().running, false);
    assert.equal(fs.existsSync(hud.desktopFile), false);
    process.stdout.write("Linux panel registration, menu, data refresh, stale recovery, visibility, unlock reconnect, restart and stop passed.\n");
  } finally {
    presenter?.kill("SIGTERM");
    try { if (status().running) hud.linuxHudControl("quit"); } catch {}
    await stopWatcher();
  }
}

test("native Linux HUD registers, refreshes and reconnects on an isolated desktop bus", { skip: !nativeAvailable }, (t) => {
  const f = fixture(t);
  const result = spawnSync("dbus-run-session", ["--", process.execPath, "--input-type=module"], {
    env: { ...process.env, AI_BATTERY_TEST_SOURCE: source, AI_BATTERY_TEST_ROOT: f.root },
    input: `await (${linuxSessionScenario.toString()})();`, encoding: "utf8", timeout: 35000
  });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Linux panel registration/);
});
