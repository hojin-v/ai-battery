// Native GJS process: the desktop owns the panel/menu, Node owns usage scans.
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { cliLanguage } from "../../core/cli-help.js";

const value = (name, fallback = "") => {
  const index = ARGV.indexOf(name);
  return index >= 0 ? ARGV[index + 1] : fallback;
};
const busName = value("--bus-name");
const controlPath = "/org/hnode/AiBattery/Hud";
const controlInterface = "org.hnode.AiBattery.Hud";
const env = Object.fromEntries(["LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"].map(name => [name, GLib.getenv(name)]));
const language = cliLanguage(env);
const t = (english, korean) => language === "ko" ? korean : english;
const encode = text => new TextEncoder().encode(text);

function callControl(action) {
  try {
    const result = Gio.DBus.session.call_sync(busName, controlPath, controlInterface,
      action === "status" ? "GetStatus" : action === "quit" ? "Quit" : "Refresh",
      null, null, Gio.DBusCallFlags.NO_AUTO_START, 2500, null);
    if (action === "status") {
      const status = JSON.parse(result.deepUnpack()[0]);
      if (status.app !== "ai-battery") throw new Error("Unrecognized Linux HUD service");
      print(JSON.stringify(status));
    } else print(JSON.stringify({ ok: true }));
  } catch (error) {
    if (action === "status" && /ServiceUnknown|NameHasNoOwner|not provided|Cannot autolaunch|session bus|Unable to autolaunch/i.test(error.message)) {
      print(JSON.stringify({ running: false }));
    } else throw error;
  }
}

let Dbusmenu;
let GdkPixbuf;
let GLibUnix;
async function main() {
  const control = value("--control");
  if (control) {
    callControl(control);
    return;
  }
  try {
    ({ default: Dbusmenu } = await import("gi://Dbusmenu?version=0.4"));
    ({ default: GdkPixbuf } = await import("gi://GdkPixbuf?version=2.0"));
    try { ({ default: GLibUnix } = await import("gi://GLibUnix?version=2.0")); } catch { /* Older GLib exports signal_add on GLib. */ }
    let hostAvailable = false;
    let sessionAvailable = true;
    try {
      hostAvailable = Gio.DBus.session.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "NameHasOwner",
        new GLib.Variant("(s)", ["org.kde.StatusNotifierWatcher"]), new GLib.VariantType("(b)"), Gio.DBusCallFlags.NONE, 2500, null).deepUnpack()[0];
    } catch { sessionAvailable = false; }
    if (ARGV.includes("--probe")) print(JSON.stringify({ hostAvailable, sessionAvailable }));
    else if (!sessionAvailable) throw new Error("No desktop session bus");
    else runPanel();
  } catch (error) {
    printerr(`ai-battery-hud: ${error.message}`);
    throw error;
  }
}

const notifierXml = `<node><interface name="org.kde.StatusNotifierItem">
  <property name="Category" type="s" access="read"/><property name="Id" type="s" access="read"/>
  <property name="Title" type="s" access="read"/><property name="Status" type="s" access="read"/>
  <property name="WindowId" type="i" access="read"/><property name="Menu" type="o" access="read"/>
  <property name="ItemIsMenu" type="b" access="read"/><property name="IconThemePath" type="s" access="read"/>
  <property name="IconName" type="s" access="read"/><property name="IconPixmap" type="a(iiay)" access="read"/>
  <property name="OverlayIconName" type="s" access="read"/><property name="OverlayIconPixmap" type="a(iiay)" access="read"/>
  <property name="AttentionIconName" type="s" access="read"/><property name="AttentionIconPixmap" type="a(iiay)" access="read"/>
  <property name="AttentionMovieName" type="s" access="read"/><property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
  <method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="ContextMenu"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="Scroll"><arg type="i" direction="in"/><arg type="s" direction="in"/></method>
  <method name="ProvideXdgActivationToken"><arg type="s" direction="in"/></method>
  <signal name="NewIcon"/><signal name="NewToolTip"/><signal name="NewTitle"/>
  <signal name="NewStatus"><arg type="s"/></signal>
</interface></node>`;
const controlXml = `<node><interface name="org.hnode.AiBattery.Hud">
  <method name="GetStatus"><arg type="s" direction="out"/></method>
  <method name="Refresh"/><method name="Quit"/><method name="Claim"/><method name="Release"/>
  <signal name="Changed"><arg type="s"/></signal>
</interface></node>`;

function runPanel() {
  const loop = new GLib.MainLoop(null, false);
  const rootDir = value("--state-dir");
  const iconDir = GLib.build_filenamev([rootDir, "linux-hud"]);
  GLib.mkdir_with_parents(iconDir, 0o700);
  const readyFile = value("--ready");
  const interval = Math.max(1, Number(value("--interval", "10")) || 10);
  const provider = value("--provider", "all");
  const pid = new Gio.Credentials().get_unix_pid();
  let snapshot = null;
  let lastError = null;
  let registered = false;
  let presenter = null;
  let presenterWatch = 0;
  let detailImage = "";
  let ready = false;
  let busy = false;
  let pending = false;
  let timer = 0;
  let subprocess = null;
  let fastUntil = 0;
  const placeholder = '<svg xmlns="http://www.w3.org/2000/svg" width="54" height="24"><text x="3" y="17" fill="#A1A1AA" font-family="sans-serif" font-size="12">AI --</text></svg>';
  const placeholderHash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, placeholder, -1);
  let image = GLib.build_filenamev([iconDir, `icon-${placeholderHash}.svg`]);
  GLib.file_set_contents(image, encode(placeholder));
  let notifier;
  let watcher;
  let owner;
  const icons = [];
  const root = Dbusmenu.Menuitem.new();
  const menu = Dbusmenu.Server.new("/Menu");
  menu.set_root(root);
  const rows = new Map();

  function menuItem(label, callback) {
    const item = Dbusmenu.Menuitem.new();
    item.property_set("label", label);
    item.property_set_bool("visible", true);
    item.property_set_bool("enabled", true);
    if (callback) item.connect("item-activated", callback);
    return item;
  }
  const refreshItem = menuItem(t("Refresh", "새로고침"), () => { fastUntil = GLib.get_monotonic_time() + 30e6; refresh(); });
  const quitItem = menuItem(t("Quit AI Battery", "AI Battery 종료"), quit);
  const errorItem = menuItem("");
  errorItem.property_set_bool("visible", false);
  errorItem.property_set_bool("enabled", false);
  const separator = Dbusmenu.Menuitem.new();
  separator.property_set("type", "separator");
  const loading = menuItem("AI Battery · loading");
  root.child_append(loading);
  root.child_append(errorItem);
  root.child_append(separator);
  root.child_append(refreshItem);
  root.child_append(quitItem);
  root.connect("about-to-show", () => { fastUntil = GLib.get_monotonic_time() + 30e6; refresh(); return false; });

  function maybeReady() {
    if (snapshot && !ready && readyFile) {
      GLib.file_set_contents(readyFile, encode(JSON.stringify({ pid, busName, registered })));
      ready = true;
    }
  }

  function updateMenu(data) {
    const labels = data.rows.length ? data.rows : [{ provider: "ai", label: "AI Battery", percent: null, meta: "waiting" }];
    const shapeChanged = labels.map(row => row.provider).join(",") !== [...rows.keys()].join(",");
    if (shapeChanged) {
      for (const item of root.get_children()) root.child_delete(item);
      rows.clear();
      for (const row of labels) {
        const item = menuItem(row.label, refresh);
        rows.set(row.provider, item);
        root.child_append(item);
      }
      root.child_append(errorItem);
      root.child_append(separator);
      root.child_append(refreshItem);
      root.child_append(quitItem);
    }
    let pixbuf;
    try { pixbuf = GdkPixbuf.Pixbuf.new_from_file(data.panelImage); } catch { /* Labels remain available. */ }
    labels.forEach((row, index) => {
      const item = rows.get(row.provider);
      const percent = typeof row.percent === "number" ? `${Math.round(row.percent)}%` : "--%";
      const filled = typeof row.percent === "number" ? Math.round(row.percent / 100 * 10) : 0;
      const meter = "▰".repeat(filled) + "▱".repeat(10 - filled);
      item.property_set("label", `${row.label}   ${meter} ${percent}   ${row.meta || ""}${row.activity ? `\n${row.activity}` : ""}${row.error ? `\n${row.error}` : ""}`.trim());
      if (pixbuf && pixbuf.width >= index * 56 + 20) {
        try {
          const brand = pixbuf.new_subpixbuf(index * 56, 2, 20, 20);
          const [, png] = brand.save_to_bufferv("png", [], []);
          item.property_set_variant("icon-data", new GLib.Variant("ay", png));
        } catch { /* Text and panel artwork do not depend on menu icons. */ }
      }
    });
  }

  function cachedImage(filePath, kind) {
    const file = Gio.File.new_for_path(filePath);
    const [, contents] = file.load_contents(null);
    const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, GLib.Bytes.new(contents));
    const icon = GLib.build_filenamev([iconDir, `${kind}-${hash}.svg`]);
    if (icon === image || icon === detailImage) return icon;
    GLib.file_set_contents(icon, contents);
    icons.push(icon);
    // Unique names avoid the panel host's icon cache; retain recent files while it loads.
    while (icons.length > 24) {
      const previous = icons.shift();
      if (previous !== image && previous !== detailImage && !icons.includes(previous)) {
        try { Gio.File.new_for_path(previous).delete(null); } catch { /* Already pruned. */ }
      }
    }
    return icon;
  }

  function updateImage(data) {
    const next = cachedImage(data.panelImage, "icon");
    detailImage = cachedImage(data.detailImage, "detail");
    if (next === image) return;
    image = next;
    notifier.emit_property_changed("IconName", new GLib.Variant("s", image));
    notifier.emit_signal("NewIcon", new GLib.Variant("()", []));
  }

  function schedule() {
    const state = snapshot?.state;
    const fast = GLib.get_monotonic_time() < fastUntil || state === "background-running";
    const seconds = lastError ? Math.min(5, interval) : fast ? Math.min(2, interval) : state === "foreground-running" ? Math.min(10, interval)
      : state === "background-ready" ? Math.max(10, Math.min(15, interval)) : Math.max(30, Math.min(60, interval * 3));
    timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(seconds * 1000), () => { timer = 0; refresh(); return GLib.SOURCE_REMOVE; });
  }

  function scanFailed(error) {
    lastError = error.message;
    errorItem.property_set("label", `${t("Usage unavailable; retrying", "사용량 조회 실패 · 다시 시도 중")}\n${lastError}`);
    errorItem.property_set_bool("visible", true);
    notifier.emit_signal("NewToolTip", new GLib.Variant("()", []));
    printerr(`ai-battery-hud: ${lastError}`);
    changed();
  }

  function refresh() {
    if (busy) { pending = true; return; }
    if (timer) { GLib.source_remove(timer); timer = 0; }
    busy = true;
    try {
      subprocess = Gio.Subprocess.new([value("--node"), value("--snapshot"), provider], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
      let timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 12, () => {
        timeout = 0; subprocess?.force_exit(); return GLib.SOURCE_REMOVE;
      });
      subprocess.communicate_utf8_async(null, null, (process, result) => {
        if (timeout) GLib.source_remove(timeout);
        try {
          const [, stdout, stderr] = process.communicate_utf8_finish(result);
          if (!process.get_successful()) throw new Error(stderr.trim() || "Usage scan failed");
          const data = JSON.parse(stdout);
          if (snapshot && snapshot.state !== data.state) fastUntil = GLib.get_monotonic_time() + 45e6;
          updateImage(data);
          updateMenu(data);
          snapshot = data;
          lastError = null;
          errorItem.property_set_bool("visible", false);
          notifier.emit_signal("NewToolTip", new GLib.Variant("()", []));
          maybeReady();
          changed();
        } catch (error) {
          scanFailed(error);
        } finally {
          subprocess = null;
          busy = false;
          if (pending) { pending = false; refresh(); } else schedule();
        }
      });
    } catch (error) {
      busy = false;
      scanFailed(error);
      schedule();
    }
  }

  function quit() {
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
  }
  const service = {
    get Category() { return "ApplicationStatus"; }, get Id() { return "ai-battery"; }, get Title() { return "AI Battery"; },
    get Status() { return presenter ? "Passive" : "Active"; }, get WindowId() { return 0; }, get Menu() { return "/Menu"; }, get ItemIsMenu() { return true; },
    get IconThemePath() { return iconDir; }, get IconName() { return image; }, get IconPixmap() { return []; },
    get OverlayIconName() { return ""; }, get OverlayIconPixmap() { return []; },
    get AttentionIconName() { return ""; }, get AttentionIconPixmap() { return []; }, get AttentionMovieName() { return ""; },
    get ToolTip() { return new GLib.Variant("(sa(iiay)ss)", ["", [], "AI Battery", lastError ? `${snapshot?.text || "AI Battery"}\n${lastError}` : snapshot?.text || "AI Battery"]); },
    Activate: refresh, SecondaryActivate: refresh, ContextMenu: refresh, Scroll() {}, ProvideXdgActivationToken() {}
  };
  function status() {
    return JSON.stringify({ app: "ai-battery", busName, running: true, pid, registered: registered || Boolean(presenter),
      presentation: presenter ? "gnome" : "status-notifier", language, text: snapshot?.text || "AI Battery",
      state: snapshot?.state || "loading", updatedAt: snapshot?.generatedAt || null, provider, interval,
      icon: image, detailImage, rows: snapshot?.rows || [], error: lastError });
  }
  function changed() {
    controlExport?.emit_signal("Changed", new GLib.Variant("(s)", [status()]));
  }
  function release() {
    if (presenterWatch) Gio.bus_unwatch_name(presenterWatch);
    presenterWatch = 0;
    presenter = null;
    notifier.emit_property_changed("Status", new GLib.Variant("s", "Active"));
    notifier.emit_signal("NewStatus", new GLib.Variant("(s)", ["Active"]));
    changed();
  }
  const controls = {
    GetStatus: status, Refresh: refresh, Quit: quit,
    ClaimAsync(_args, invocation) {
      if (presenterWatch) Gio.bus_unwatch_name(presenterWatch);
      presenter = invocation.get_sender();
      presenterWatch = Gio.bus_watch_name_on_connection(Gio.DBus.session, presenter, Gio.BusNameWatcherFlags.NONE, null, release);
      notifier.emit_property_changed("Status", new GLib.Variant("s", "Passive"));
      notifier.emit_signal("NewStatus", new GLib.Variant("(s)", ["Passive"]));
      invocation.return_value(new GLib.Variant("()", []));
      changed();
    },
    ReleaseAsync(_args, invocation) {
      if (presenter === invocation.get_sender()) release();
      invocation.return_value(new GLib.Variant("()", []));
    }
  };
  let controlExport;
  owner = Gio.bus_own_name(Gio.BusType.SESSION, busName, Gio.BusNameOwnerFlags.NONE,
    connection => {
      notifier = Gio.DBusExportedObject.wrapJSObject(notifierXml, service);
      notifier.export(connection, "/StatusNotifierItem");
      controlExport = Gio.DBusExportedObject.wrapJSObject(controlXml, controls);
      controlExport.export(connection, controlPath);
    },
    connection => {
      watcher = Gio.bus_watch_name_on_connection(connection, "org.kde.StatusNotifierWatcher", Gio.BusNameWatcherFlags.NONE,
        () => {
          connection.call("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher", "org.kde.StatusNotifierWatcher", "RegisterStatusNotifierItem",
            new GLib.Variant("(s)", [busName]), null, Gio.DBusCallFlags.NONE, 3000, null, (bus, result) => {
              try { bus.call_finish(result); registered = true; maybeReady(); }
              catch (error) { lastError = error.message; printerr(error.message); }
            });
        }, () => { registered = false; });
      refresh();
    }, () => { printerr("Linux HUD name unavailable or desktop session ended"); quit(); });
  const signalAdd = GLibUnix?.signal_add || GLib.unix_signal_add;
  signalAdd(GLib.PRIORITY_DEFAULT, 15, () => { quit(); return GLib.SOURCE_REMOVE; });
  signalAdd(GLib.PRIORITY_DEFAULT, 2, () => { quit(); return GLib.SOURCE_REMOVE; });
  loop.run();
  if (timer) GLib.source_remove(timer);
  subprocess?.force_exit();
  if (watcher) Gio.bus_unwatch_name(watcher);
  if (presenterWatch) Gio.bus_unwatch_name(presenterWatch);
  Gio.bus_unown_name(owner);
  notifier?.unexport();
  controlExport?.unexport();
}

await main();
