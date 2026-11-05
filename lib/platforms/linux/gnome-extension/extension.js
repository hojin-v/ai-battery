// AI Battery managed GNOME panel. Usage collection stays in the separate service.
import Clutter from "gi://Clutter";
import Cogl from "gi://Cogl";
import GdkPixbuf from "gi://GdkPixbuf";
import Gio from "gi://Gio";
import St from "gi://St";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

const prefix = "org.hnode.AiBattery.Hud.state_";
const iface = "org.hnode.AiBattery.Hud";
const object = "/org/hnode/AiBattery/Hud";

function call(name, method, cancellable = null) {
  return new Promise((resolve, reject) => {
    Gio.DBus.session.call(name, object, iface, method, null, null, Gio.DBusCallFlags.NO_AUTO_START, 3000, cancellable,
      (bus, result) => { try { resolve(bus.call_finish(result).deepUnpack()); } catch (error) { reject(error); } });
  });
}

function artwork(actor, file, description) {
  const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
  if (actor._artwork === `${file}:${scale}`) return;
  let pixbuf = GdkPixbuf.Pixbuf.new_from_file(file);
  const width = pixbuf.width;
  const height = pixbuf.height;
  if (scale !== 1) pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(file, width * scale, height * scale, false);
  const content = St.ImageContent.new_with_preferred_size(width, height);
  const format = pixbuf.has_alpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888;
  if (content.set_bytes) {
    content.set_bytes(global.stage.context.get_backend().get_cogl_context(), pixbuf.read_pixel_bytes(), format,
      pixbuf.width, pixbuf.height, pixbuf.rowstride);
  } else {
    content.set_data(pixbuf.get_pixels(), format, pixbuf.width, pixbuf.height, pixbuf.rowstride);
  }
  actor.set_content(content);
  actor.set_size(width, height);
  actor.accessible_name = description;
  actor._artwork = `${file}:${scale}`;
}

export default class AiBattery extends Extension {
  enable() {
    this._panels = new Map();
    this._pending = new Set();
    this._cancellable = new Gio.Cancellable();
    this._changed = Gio.DBus.session.signal_subscribe(null, iface, "Changed", object, null, Gio.DBusSignalFlags.NONE,
      (_bus, _sender, _path, _iface, _signal, parameters) => {
        try {
          const data = JSON.parse(parameters.deepUnpack()[0]);
          if (data.app === "ai-battery" && data.busName?.startsWith(prefix)) this._add(data.busName);
        } catch (error) { console.error(error); }
      });
    this._names = Gio.DBus.session.signal_subscribe("org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged",
      "/org/freedesktop/DBus", null, Gio.DBusSignalFlags.NONE, (_bus, _sender, _path, _iface, _signal, parameters) => {
        const [name, , owner] = parameters.deepUnpack();
        if (!name.startsWith(prefix)) return;
        if (owner) this._add(name);
        else this._remove(name);
      });
    Gio.DBus.session.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "ListNames", null, null,
      Gio.DBusCallFlags.NONE, 3000, this._cancellable, (bus, result) => {
        try {
          for (const name of bus.call_finish(result).deepUnpack()[0]) if (name.startsWith(prefix)) this._add(name);
        } catch (error) { if (this._cancellable && !this._cancellable.is_cancelled()) console.error(error); }
      });
    this._scale = St.ThemeContext.get_for_stage(global.stage).connect("notify::scale-factor", () => {
      for (const panel of this._panels.values()) this._update(panel, panel.data);
    });
  }

  async _add(name) {
    if (!this._panels || this._panels.has(name) || this._pending.has(name)) return;
    this._pending.add(name);
    try {
      const [json] = await call(name, "GetStatus", this._cancellable);
      if (!this._panels) return;
      const data = JSON.parse(json);
      if (data.app !== "ai-battery" || !data.detailImage) return;
      const button = new PanelMenu.Button(1, "AI Battery");
      const icon = new St.Widget({ content_gravity: Clutter.ContentGravity.RESIZE_FILL, y_align: Clutter.ActorAlign.CENTER });
      button.add_child(icon);
      button.menu.box.set_style("background-color: #26262a; color: #f5f5f7; border-radius: 10px; padding: 6px 0;");
      const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
      item.set_style("padding: 0;");
      const detail = new St.Widget({ content_gravity: Clutter.ContentGravity.RESIZE_FILL });
      item.add_child(detail);
      button.menu.addMenuItem(item);
      const error = new PopupMenu.PopupMenuItem("", { reactive: false, can_focus: false });
      error.set_style("font-size: 11px; color: #a1a1aa;");
      button.menu.addMenuItem(error);
      button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      const refresh = button.menu.addAction("Refresh", () => call(name, "Refresh").catch(console.error));
      const quit = button.menu.addAction("Quit AI Battery", () => call(name, "Quit").catch(console.error));
      for (const action of [refresh, quit]) action.set_style("font-size: 13px; color: #f5f5f7; padding: 4px 12px; margin: 0; min-height: 0;");
      button.menu.connect("open-state-changed", (_menu, open) => {
        if (open) call(name, "Refresh", this._cancellable).catch(() => {});
      });
      const panel = { name, button, icon, detail, error, refresh, quit, data };
      panel.signal = Gio.DBus.session.signal_subscribe(name, iface, "Changed", object, null, Gio.DBusSignalFlags.NONE,
        (_bus, _sender, _path, _iface, _signal, parameters) => {
          try { this._update(panel, JSON.parse(parameters.deepUnpack()[0])); } catch (error) { console.error(error); }
        });
      this._panels.set(name, panel);
      this._update(panel, data);
      Main.panel.addToStatusArea(`ai-battery-${name.slice(prefix.length)}`, button, 0, "right");
      await call(name, "Claim", this._cancellable);
    } catch (error) {
      this._remove(name);
      if (this._cancellable && !this._cancellable.is_cancelled()) console.error(error);
    } finally { this._pending?.delete(name); }
  }

  _update(panel, data) {
    panel.data = data;
    artwork(panel.icon, data.icon, data.text || "AI Battery");
    artwork(panel.detail, data.detailImage, data.text || "AI Battery usage");
    panel.error.label.text = data.error ? `${data.language === "ko" ? "사용량 조회 실패 · 다시 시도 중" : "Usage unavailable; retrying"}\n${data.error}` : "";
    panel.error.visible = Boolean(data.error);
    panel.refresh.label.text = data.language === "ko" ? "새로고침" : "Refresh";
    panel.quit.label.text = data.language === "ko" ? "AI Battery 종료" : "Quit AI Battery";
  }

  _remove(name) {
    const panel = this._panels?.get(name);
    if (!panel) return;
    Gio.DBus.session.signal_unsubscribe(panel.signal);
    panel.button.destroy();
    this._panels.delete(name);
    call(name, "Release").catch(() => {});
  }

  disable() {
    this._cancellable.cancel();
    Gio.DBus.session.signal_unsubscribe(this._names);
    Gio.DBus.session.signal_unsubscribe(this._changed);
    St.ThemeContext.get_for_stage(global.stage).disconnect(this._scale);
    for (const name of this._panels.keys()) this._remove(name);
    this._panels = null;
    this._pending = null;
    this._cancellable = null;
  }
}
