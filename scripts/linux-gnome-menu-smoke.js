// Run inside the isolated shell created by linux-gnome-menu-check.mjs.
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Shell from "gi://Shell";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as Scripting from "resource:///org/gnome/shell/ui/scripting.js";

const iface = "org.hnode.AiBattery.Hud";
const object = "/org/hnode/AiBattery/Hud";
export function init() { Main.layoutManager._startInOverview = false; }
function expect(condition, message) { if (!condition) throw new Error(message); }
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await Scripting.sleep(100); }
  throw new Error("Timed out waiting for GNOME HUD");
}
function call(name, method) {
  return new Promise((resolve, reject) => Gio.DBus.session.call(name, object, iface, method, null, null,
    Gio.DBusCallFlags.NONE, 3000, null, (bus, result) => {
      try { resolve(bus.call_finish(result).deepUnpack()); } catch (error) { reject(error); }
    }));
}
async function command(args) {
  const child = Gio.Subprocess.new(args, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
  const [, stdout, stderr] = await new Promise((resolve, reject) => child.communicate_utf8_async(null, null,
    (process, result) => { try { resolve(process.communicate_utf8_finish(result)); } catch (error) { reject(error); } }));
  expect(child.get_successful(), stderr);
  return stdout;
}

export async function run() {
  const root = GLib.getenv("AI_BATTERY_MENU_ROOT");
  const source = GLib.getenv("AI_BATTERY_MENU_SOURCE");
  const node = GLib.getenv("AI_BATTERY_MENU_NODE");
  const name = GLib.getenv("AI_BATTERY_MENU_BUS");
  const uuid = GLib.getenv("AI_BATTERY_MENU_UUID");
  Main.overview.hide();
  const backend = Gio.Subprocess.new(["gjs", "-m", `${source}/lib/platforms/linux/panel.js`, "--bus-name", name,
    "--node", node, "--snapshot", `${source}/lib/platforms/linux/panel-snapshot.js`, "--state-dir", `${root}/state`, "--provider", "all"],
  Gio.SubprocessFlags.NONE);
  let extension;
  await until(() => {
    extension = Main.extensionManager.lookup(uuid)?.stateObj;
    return extension?._panels?.size === 1;
  });
  // GNOME can retain the disabled old UUID after its directory was migrated.
  // Exercise the real controller against Shell and dconf, not a command stub.
  const settings = new Gio.Settings({ schema_id: "org.gnome.shell" });
  const disabled = settings.get_strv("disabled-extensions").filter(value => value !== "ai-battery@hnode.dev");
  settings.set_strv("disabled-extensions", [...disabled, "ai-battery@hnode.dev"]);
  Gio.Settings.sync();
  await command(["gjs", "-m", `${source}/lib/platforms/linux/gnome-control.js`, "enable", uuid]);
  await until(() => !settings.get_strv("disabled-extensions").includes("ai-battery@hnode.dev"));
  expect(settings.get_strv("disabled-extensions").join("\0") === disabled.join("\0"), "Migration must preserve unrelated disabled extensions");
  let panel = extension._panels.get(name);
  await until(() => panel.data.presentation === "gnome");
  expect(panel.detail.width === 392, "Detail artwork must retain the macOS width");
  expect(panel.detail.height >= 88, "Both providers must appear in one image");
  expect(panel.data.rows.length === 2, "Expected both providers");
  expect(panel.refresh.label.text === "새로고침", "Menu must follow the service locale");
  expect(!panel.error.visible, "A healthy menu must not show an error row");
  panel.button.menu.open();
  await Scripting.sleep(700);
  expect(panel.button.menu.isOpen && panel.detail.mapped, "The detail image must be visible inside the open menu");
  expect(panel.button.menu.box.get_theme_node().get_border_width(0) === 0, "The popup must not have a bright border");
  expect(panel.button.menu.actor.get_theme_node().get_length("-arrow-border-width") === 0, "The box pointer must not draw a border");
  const stream = Gio.File.new_for_path(`${root}/menu.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
  await new Shell.Screenshot().screenshot(false, stream);
  stream.close(null);
  const [mx, my] = panel.button.menu.actor.get_transformed_position();
  const [mw, mh] = panel.button.menu.actor.get_transformed_size();
  const [bx, by] = panel.button.get_transformed_position();
  const [bw] = panel.button.get_transformed_size();
  const x = Math.max(0, Math.floor(Math.min(mx, bx) - 8));
  const y = Math.max(0, Math.floor(Math.min(my, by)));
  const width = Math.min(global.screen_width - x, Math.ceil(Math.max(mx + mw, bx + bw) - x + 8));
  const height = Math.min(global.screen_height - y, Math.ceil(my + mh - y + 8));
  const preview = Gio.File.new_for_path(`${root}/detail-menu.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
  await new Shell.Screenshot().screenshot_area(x, y, width, height, preview);
  preview.close(null);
  const detailPath = panel.data.detailImage;
  panel.button.menu.close();

  await command([node, `${source}/bin/ai-battery.js`, "off", "codex"]);
  await call(name, "Refresh");
  await until(() => panel.data.rows.length === 1);
  expect(panel.data.rows[0].provider === "claude", "Menu must follow provider visibility");
  expect(panel.detail.height === 52, "Detail view must resize when a provider is hidden");

  Main.extensionManager.disableExtension(uuid);
  await until(() => !Main.panel.statusArea[`ai-battery-${name.split("state_")[1]}`]);
  await Scripting.sleep(200);
  const [released] = await call(name, "GetStatus");
  expect(JSON.parse(released).presentation === "status-notifier", "Disabling the extension must restore the standard tray");
  Main.extensionManager.enableExtension(uuid);
  await until(() => Main.extensionManager.lookup(uuid)?.stateObj?._panels?.size === 1);
  extension = Main.extensionManager.lookup(uuid).stateObj;
  panel = extension._panels.get(name);
  await until(() => panel.data.presentation === "gnome");
  await call(name, "Quit");
  await until(() => extension._panels.size === 0);
  const result = { result: "passed", checks: ["Shared macOS detail SVG at full size", "Open GNOME menu renders artwork",
    "Korean menu actions", "Provider visibility and image resizing", "Legacy UUID settings cleanup", "Standard tray fallback on disable", "Enable/reconnect and service shutdown"],
  screenshot: `${root}/detail-menu.png`, fullScreenshot: `${root}/menu.png`, detailImage: detailPath };
  GLib.file_set_contents(`${root}/result.json`, new TextEncoder().encode(JSON.stringify(result, null, 2)));
  print(JSON.stringify(result));
  backend.wait(null);
}
