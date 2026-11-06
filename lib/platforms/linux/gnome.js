import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gnomeHudUuid, legacyGnomeHudUuids } from "./gnome-uuid.js";

export { gnomeHudUuid } from "./gnome-uuid.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
export const gnomeHudMetadata = {
  uuid: gnomeHudUuid, name: "AI Battery", description: "Codex and Claude usage with the macOS detail menu",
  "shell-version": ["45", "46", "47", "48", "49", "50"], version: 1,
  url: "https://github.com/hojin-v/ai-battery", "ai-battery-managed": true
};

export function createGnomeHudIntegration({ home = os.homedir(), env = process.env, run = spawnSync } = {}) {
  const extensions = path.join(env.XDG_DATA_HOME || path.join(home, ".local/share"), "gnome-shell/extensions");
  const target = path.join(extensions, gnomeHudUuid);
  const source = path.join(directory, "gnome-extension/extension.js");
  const gjs = env.AI_BATTERY_GJS || (fs.existsSync("/usr/bin/gjs") ? "/usr/bin/gjs" : "gjs");
  function control(action, uuid = gnomeHudUuid) {
    const result = run(gjs, ["-m", path.join(directory, "gnome-control.js"), action, uuid], { env, encoding: "utf8", timeout: 8000 });
    if (result.status !== 0 || result.error) throw new Error(result.error?.message || result.stderr?.trim() || "GNOME HUD integration failed");
    return JSON.parse(result.stdout);
  }
  function owned(directory = target, uuid = gnomeHudUuid) {
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stat) return false;
    // Removal may leave unrelated notes in the directory. Their presence is
    // not an installed extension and must not block a later prepare/reset.
    if (stat.isDirectory() && !stat.isSymbolicLink()
      && !fs.lstatSync(path.join(directory, "metadata.json"), { throwIfNoEntry: false })
      && !fs.lstatSync(path.join(directory, "extension.js"), { throwIfNoEntry: false })) return false;
    let metadata;
    try {
      const file = path.join(directory, "metadata.json");
      const metaStat = fs.lstatSync(file);
      const codeStat = fs.lstatSync(path.join(directory, "extension.js"));
      if (!stat.isDirectory() || stat.isSymbolicLink() || !metaStat.isFile() || metaStat.isSymbolicLink()
        || !codeStat.isFile() || codeStat.isSymbolicLink()) throw new Error("Unowned extension");
      metadata = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch { /* Report one ownership error without modifying the directory. */ }
    if (metadata?.uuid !== uuid || metadata["ai-battery-managed"] !== true) {
      throw new Error(`GNOME HUD extension ownership could not be verified; left untouched: ${directory}`);
    }
    return true;
  }
  function legacyInstallations() {
    return legacyGnomeHudUuids.map(uuid => ({ uuid, directory: path.join(extensions, uuid) }))
      .filter(item => owned(item.directory, item.uuid));
  }
  function removeOwned(directory, uuid) {
    control("disable", uuid);
    for (const name of ["extension.js", "metadata.json"]) fs.unlinkSync(path.join(directory, name));
    if (!fs.readdirSync(directory).length) fs.rmdirSync(directory);
  }
  function prepare() {
    const info = control("info");
    if (!info.available || !gnomeHudMetadata["shell-version"].includes(String(info.version).split(".")[0])) return { supported: false };
    const exists = owned();
    // Validate both identities before modifying files or desktop settings.
    const legacy = legacyInstallations();
    const code = fs.readFileSync(source, "utf8");
    const metadata = `${JSON.stringify(gnomeHudMetadata, null, 2)}\n`;
    const changed = !exists || fs.readFileSync(path.join(target, "extension.js"), "utf8") !== code
      || fs.readFileSync(path.join(target, "metadata.json"), "utf8") !== metadata;
    if (changed) {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(target, "extension.js"), code, { mode: 0o600 });
      fs.writeFileSync(path.join(target, "metadata.json"), metadata, { mode: 0o600 });
    }
    for (const item of legacy) removeOwned(item.directory, item.uuid);
    const enabled = control("enable");
    return { supported: true, pending: !enabled.accepted || changed, blocked: !info.allowed, path: target,
      migrated: legacy.map(item => item.uuid) };
  }
  function remove() {
    const exists = owned();
    const legacy = legacyInstallations();
    if (!exists && !legacy.length) return { changed: false };
    if (exists) removeOwned(target, gnomeHudUuid);
    for (const item of legacy) removeOwned(item.directory, item.uuid);
    return { changed: true, path: exists ? target : legacy[0].directory };
  }
  return { prepare, remove, target };
}
