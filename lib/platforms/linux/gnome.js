import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
export const gnomeHudUuid = "ai-battery@hnode.dev";
export const gnomeHudMetadata = {
  uuid: gnomeHudUuid, name: "AI Battery", description: "Codex and Claude usage with the macOS detail menu",
  "shell-version": ["45", "46", "47", "48", "49", "50"], version: 1,
  url: "https://github.com/hojin-v/ai-battery", "ai-battery-managed": true
};

export function createGnomeHudIntegration({ home = os.homedir(), env = process.env, run = spawnSync } = {}) {
  const target = path.join(env.XDG_DATA_HOME || path.join(home, ".local/share"), "gnome-shell/extensions", gnomeHudUuid);
  const source = path.join(directory, "gnome-extension/extension.js");
  const gjs = env.AI_BATTERY_GJS || (fs.existsSync("/usr/bin/gjs") ? "/usr/bin/gjs" : "gjs");
  function control(action) {
    const result = run(gjs, ["-m", path.join(directory, "gnome-control.js"), action], { env, encoding: "utf8", timeout: 8000 });
    if (result.status !== 0 || result.error) throw new Error(result.error?.message || result.stderr?.trim() || "GNOME HUD integration failed");
    return JSON.parse(result.stdout);
  }
  function owned() {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat) return false;
    let metadata;
    try {
      const file = path.join(target, "metadata.json");
      const metaStat = fs.lstatSync(file);
      const codeStat = fs.lstatSync(path.join(target, "extension.js"));
      if (!stat.isDirectory() || stat.isSymbolicLink() || !metaStat.isFile() || metaStat.isSymbolicLink()
        || !codeStat.isFile() || codeStat.isSymbolicLink()) throw new Error("Unowned extension");
      metadata = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch { /* Report one ownership error without modifying the directory. */ }
    if (metadata?.uuid !== gnomeHudUuid || metadata["ai-battery-managed"] !== true) {
      throw new Error(`GNOME HUD extension ownership could not be verified; left untouched: ${target}`);
    }
    return true;
  }
  function prepare() {
    const info = control("info");
    if (!info.available || !gnomeHudMetadata["shell-version"].includes(String(info.version).split(".")[0])) return { supported: false };
    const exists = owned();
    const code = fs.readFileSync(source, "utf8");
    const changed = !exists || fs.readFileSync(path.join(target, "extension.js"), "utf8") !== code;
    if (changed) {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(target, "extension.js"), code, { mode: 0o600 });
      fs.writeFileSync(path.join(target, "metadata.json"), `${JSON.stringify(gnomeHudMetadata, null, 2)}\n`, { mode: 0o600 });
    }
    const enabled = control("enable");
    return { supported: true, pending: !enabled.accepted || changed, blocked: !info.allowed, path: target };
  }
  function remove() {
    if (!owned()) return { changed: false };
    // Validate all managed files before touching desktop settings or removing a file.
    control("disable");
    for (const name of ["extension.js", "metadata.json"]) fs.unlinkSync(path.join(target, name));
    if (!fs.readdirSync(target).length) fs.rmdirSync(target);
    return { changed: true, path: target };
  }
  return { prepare, remove, target };
}
