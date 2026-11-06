import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { gnomeHudUuid, legacyGnomeHudUuids } from "./gnome-uuid.js";

const uuid = ARGV[1] || gnomeHudUuid;
if (![gnomeHudUuid, ...legacyGnomeHudUuids].includes(uuid)) throw new Error("Unsupported AI Battery extension UUID");
const service = "org.gnome.Shell.Extensions";
const object = "/org/gnome/Shell";
function call(method, args = null, iface = service) {
  return Gio.DBus.session.call_sync("org.gnome.Shell", object, iface, method, args, null,
    Gio.DBusCallFlags.NO_AUTO_START, 2000, null).deepUnpack();
}

let info = { available: false };
try {
  const version = call("Get", new GLib.Variant("(ss)", [service, "ShellVersion"]), "org.freedesktop.DBus.Properties")[0].unpack();
  const allowed = call("Get", new GLib.Variant("(ss)", [service, "UserExtensionsEnabled"]), "org.freedesktop.DBus.Properties")[0].unpack();
  let state = null;
  try { state = call("GetExtensionInfo", new GLib.Variant("(s)", [uuid]))[0].state?.unpack() ?? null; } catch {}
  info = { available: true, version, allowed, state };
} catch { /* A different desktop or an isolated test bus keeps the standard tray menu. */ }

if (info.available && ["enable", "disable"].includes(ARGV[0])) {
  const enable = ARGV[0] === "enable";
  if (!enable) info.accepted = call("DisableExtension", new GLib.Variant("(s)", [uuid]))[0];
  const settings = new Gio.Settings({ schema_id: "org.gnome.shell" });
  // DisableExtension can leave the old UUID in disabled-extensions. Clean
  // both identities when applying the new one, including after a partial move.
  const identities = uuid === gnomeHudUuid ? [uuid, ...legacyGnomeHudUuids] : [uuid];
  for (const key of ["enabled-extensions", "disabled-extensions"]) {
    const previous = settings.get_strv(key);
    let next = previous.filter(value => !identities.includes(value));
    if (enable && key === "enabled-extensions") next.push(uuid);
    if (next.join("\0") !== previous.join("\0") && !settings.set_strv(key, next)) throw new Error(`Could not update ${key}`);
  }
  Gio.Settings.sync();
  if (enable) info.accepted = call("EnableExtension", new GLib.Variant("(s)", [uuid]))[0];
}
print(JSON.stringify(info));
