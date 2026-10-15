import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_FILES = /^(?:(?:codex-status|windows-processes|wsl-windows-processes|claude-rate-limit-hit)-scan-cache\.json|claude-statusline\.json|codex-account-usage\.json|windows-state-dir|hud-position\.json|hud-snapshot-[\w-]+\.json|(?:tui|hud)-dock-(?:request|host)(?:-\d+)?\.json|macos-menu-(?:bar|detail)\.svg|codex-menu-bar-transparent\.png)(?:\.\d+(?:\.\d+)?(?:\.[a-z0-9]+)?\.tmp)?$/;
const HUD_FILES = new Set(["main.ps1", "controls.ps1", "dock.ps1", "native.ps1", "rendering.ps1", "snapshot.ps1", "windowing.ps1", "ai-battery-hud.ps1"]);

function lstat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
}

export function isBatteryConfig(value) {
  return Boolean(value && !Array.isArray(value) && value.version === 1
    && ["providers", "codexWrapper", "codexStatusLineBackup", "claudeStatusLineBackup"].some(key => Object.hasOwn(value, key)));
}

function inside(file, root) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function cleanupBatteryArtifacts({ roots, home = os.homedir(), protectedRoots = [] }) {
  const result = { removed: [], retained: [], errors: [] };
  const protectedPaths = [home, path.parse(home).root, ...protectedRoots].map(file => {
    try { return fs.realpathSync(file); } catch { return path.resolve(file); }
  });
  const removeFile = file => {
    const stat = lstat(file);
    if (!stat) return;
    if (!stat.isFile() || stat.isSymbolicLink()) { result.retained.push(file); return; }
    fs.unlinkSync(file);
    result.removed.push(file);
  };
  const prune = directory => {
    if (!fs.readdirSync(directory).length) { fs.rmdirSync(directory); result.removed.push(directory); }
  };
  const visit = (directory, kind) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { result.retained.push(file); continue; }
      if (entry.isDirectory()) {
        const childKind = kind === "root" && ["bin", "hud", "runtimes", "claude-statusline-sessions", "claude-hud-sessions"].includes(entry.name)
          ? entry.name
          : kind === "runtimes" && /^(?:node-v\d+\.\d+\.\d+-win-(?:x64|arm64)|\.node-download-[\w-]+)$/.test(entry.name) ? "runtime" : null;
        if (childKind) { visit(file, childKind); prune(file); }
        else result.retained.push(file);
        continue;
      }
      let owned = kind === "root" && STATE_FILES.test(entry.name);
      if (kind === "root" && entry.name === "config.json") {
        const config = readJson(file);
        owned = isBatteryConfig(config) && !config.codexWrapper && !config.codexStatusLineBackup && !config.claudeStatusLineBackup && !Object.keys(config.integrationFiles || {}).length;
      }
      if (["claude-statusline-sessions", "claude-hud-sessions"].includes(kind)) {
        owned = /^[\w-]+\.json(?:\.\d+\.tmp)?$/.test(entry.name)
          && (entry.name.endsWith(".tmp") || readJson(file)?.provider === "claude" || kind === "claude-hud-sessions");
      }
      if (kind === "bin") owned = /^(?:rowpty\.exe|conpty\.dll|OpenConsole\.exe|rowpty\.src\.sha256)(?:\.old-[\w.-]+)?$/.test(entry.name);
      if (kind === "hud") owned = HUD_FILES.has(entry.name);
      if (kind === "runtimes") owned = /^\.node-\d+\.\d+\.\d+-(?:x64|arm64)\.lock$/.test(entry.name);
      if (kind === "runtime") owned = /^(?:node\.exe|extract\.ps1|SHASUMS256\.txt|node-v\d+\.\d+\.\d+-win-(?:x64|arm64)\.zip)$/.test(entry.name);
      if (owned) removeFile(file);
      else result.retained.push(file);
    }
  };
  for (const root of [...new Set(roots.filter(Boolean).map(file => path.resolve(file)))]) {
    try {
      const stat = lstat(root);
      if (!stat) continue;
      const resolved = fs.realpathSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || protectedPaths.some(file => inside(file, resolved) || (file !== path.resolve(home) && file !== path.parse(home).root && inside(resolved, file)))) {
        result.errors.push({ path: root, error: "Refusing to clean a shared, protected, or symlinked directory" });
        continue;
      }
      visit(root, "root");
      prune(root);
    } catch (error) { result.errors.push({ path: root, error: error.message }); }
  }
  return result;
}
