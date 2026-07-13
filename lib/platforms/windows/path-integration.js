import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createWindowsPathIntegration({
  pathDirPrecedesOriginal,
  samePath,
  uniquePaths
}) {

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runWindowsPowerShell(script) {
  return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function windowsUserPathParts() {
  const result = runWindowsPowerShell("[Environment]::GetEnvironmentVariable('Path', 'User')");
  const text = result.status === 0 ? result.stdout : "";
  return String(text || "")
    .trim()
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sameWindowsPath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function staleWindowsAiBatteryTempPath(entry) {
  if (process.platform !== "win32") return false;
  if (!entry || fs.existsSync(entry)) return false;
  const relative = path.relative(os.tmpdir(), entry);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return /^ai-battery-[^\\/]+[\\/]/i.test(relative);
}

function windowsUserPathWithShim(parts, shimDir) {
  const filtered = parts.filter((entry) => (
    !sameWindowsPath(entry, shimDir)
    && !staleWindowsAiBatteryTempPath(entry)
  ));
  return {
    parts: [shimDir, ...filtered],
    changed: filtered.length !== parts.length || !sameWindowsPath(parts[0] || "", shimDir)
  };
}

function ensureWindowsShimPath(shimDir, originalCommand) {
  const activeNow = pathDirPrecedesOriginal(shimDir, originalCommand);
  if (activeNow) {
    return {
      changed: false,
      rcPath: null,
      note: `${shimDir} is already before the original codex on PATH. Plain "codex" can use AI Battery in new command lookups. Open a new cmd/PowerShell if this terminal cached the old command.`
    };
  }

  if (process.env.AI_BATTERY_SKIP_WINDOWS_PATH_WRITE === "1") {
    return {
      changed: false,
      rcPath: null,
      note: `Skipped Windows user PATH update for ${shimDir}`
    };
  }

  const parts = windowsUserPathParts();
  const nextPath = windowsUserPathWithShim(parts, shimDir);
  const next = nextPath.parts.join(";");
  const result = runWindowsPowerShell(`[Environment]::SetEnvironmentVariable('Path', ${psQuote(next)}, 'User')`);
  if (result.status !== 0) {
    return {
      changed: false,
      rcPath: null,
      note: `Could not update the Windows user PATH. Add ${shimDir} before the original codex manually.`
    };
  }
  return {
    changed: nextPath.changed,
    rcPath: "Windows user PATH",
    note: `${nextPath.changed ? "Added" : "Kept"} ${shimDir} at the front of the Windows user PATH. Open a new cmd/PowerShell for plain "codex" to use AI Battery.`
  };
}

function removeWindowsUserPathEntries(shimDirs) {
  if (process.env.AI_BATTERY_SKIP_WINDOWS_PATH_WRITE === "1") return [];

  const dirs = uniquePaths(shimDirs).filter(Boolean);
  if (!dirs.length) return [];

  const parts = windowsUserPathParts();
  const nextParts = parts.filter((entry) => !dirs.some((dir) => sameWindowsPath(entry, dir)));
  if (nextParts.length === parts.length) return [];

  const result = runWindowsPowerShell(`[Environment]::SetEnvironmentVariable('Path', ${psQuote(nextParts.join(";"))}, 'User')`);
  return result.status === 0 ? ["Windows user PATH"] : [];
}
  return {
    ensureWindowsShimPath,
    removeWindowsUserPathEntries,
    windowsUserPathWithShim
  };
}
