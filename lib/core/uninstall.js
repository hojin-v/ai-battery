import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ALIASES = ["ai-battery", "ai-battery-hud", "ai-battery-run", "ai-battery-run-win", "claudex-battery", "claudex-battery-hud", "claudex-battery-run"];
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

export function removeBatteryAliases({ packageRoot, packageJson, home = os.homedir() }) {
  const removed = [];
  for (const name of ALIASES) {
    const target = packageJson.bin?.[name];
    if (!target) continue;
    const alias = path.join(home, ".local", "bin", name);
    if (!lstat(alias)?.isSymbolicLink()) continue;
    const resolved = path.resolve(path.dirname(alias), fs.readlinkSync(alias));
    if (resolved !== path.resolve(packageRoot, target)) continue;
    fs.unlinkSync(alias);
    removed.push(alias);
  }
  return removed;
}

export function planPackageRemoval(packageRoot, { node = process.execPath } = {}) {
  const root = path.resolve(packageRoot);
  const packageJson = readJson(path.join(root, "package.json"));
  if (packageJson?.name !== "ai-battery" || !packageJson.bin || typeof packageJson.bin !== "object"
    || Object.entries(packageJson.bin).some(([name, target]) => !ALIASES.includes(name)
      || typeof target !== "string" || path.isAbsolute(target) || !inside(path.resolve(root, target), root))) {
    return { error: "Package identity or command ownership could not be verified" };
  }
  if (path.basename(path.dirname(root)) !== "node_modules" || /[\\/]_npx[\\/]/.test(root)) {
    return { skipped: true, reason: "Development checkout or temporary npx installation; no npm project was changed" };
  }
  const modules = path.dirname(root);
  const parent = path.dirname(modules);
  const localProject = readJson(path.join(parent, "package.json"));
  const declaredLocal = [localProject?.dependencies, localProject?.devDependencies, localProject?.optionalDependencies]
    .some(deps => Object.hasOwn(deps || {}, "ai-battery"));
  const global = !declaredLocal && !fs.existsSync(path.join(parent, "package.json"));
  const prefix = global && process.platform !== "win32" && path.basename(parent) === "lib" ? path.dirname(parent) : parent;
  const candidates = [
    path.join(modules, "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(node), "../lib/node_modules/npm/bin/npm-cli.js")
  ];
  const npm = candidates.find(file => lstat(file)?.isFile());
  if (!npm) return { error: "Could not locate npm for the installed package; package was left intact" };
  if (!global) {
    const project = readJson(path.join(prefix, "package.json"));
    if (![project?.dependencies, project?.devDependencies, project?.optionalDependencies].some(deps => Object.hasOwn(deps || {}, "ai-battery"))) {
      return { error: "The parent npm project does not declare ai-battery; refusing to change it" };
    }
  }
  return { node, npm, prefix, packageRoot: root, packageJson, global, args: ["uninstall", ...(global ? ["--global"] : []), "--prefix", prefix, "ai-battery", "--ignore-scripts", "--no-audit", "--no-fund"] };
}

export function removeInstalledPackage(plan, { home = os.homedir(), run = spawnSync } = {}) {
  if (plan.error || plan.skipped) return plan;
  const result = run(plan.node, [plan.npm, ...plan.args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
  if (result.status !== 0 || result.error || lstat(plan.packageRoot)) {
    return { error: result.error?.message || result.stderr?.trim() || "npm did not remove the installed package", prefix: plan.prefix };
  }
  return { removed: true, prefix: plan.prefix, global: plan.global, aliases: removeBatteryAliases({ ...plan, home }) };
}
