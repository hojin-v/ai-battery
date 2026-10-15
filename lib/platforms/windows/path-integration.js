import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createWindowsPathIntegration({
  pathDirPrecedesOriginal,
  samePath,
  uniquePaths,
  runPowerShell
}) {

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runWindowsPowerShell(script) {
  if (runPowerShell) return runPowerShell(script);
  return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function windowsUserPathParts() {
  const result = runWindowsPowerShell("[Environment]::GetEnvironmentVariable('Path', 'User')");
  if (result.status !== 0) throw new Error("Could not read Windows user PATH; leaving it unchanged");
  const text = result.stdout;
  // PowerShell adds one output line ending. Preserve every other PATH byte,
  // including whitespace, empty entries and trailing separators.
  const raw = String(text || "").replace(/\r?\n$/, "");
  return raw ? raw.split(";") : [];
}

function sameWindowsPath(left, right) {
  if (!String(left).trim() || !String(right).trim()) return false;
  return path.resolve(String(left).trim()).toLowerCase() === path.resolve(String(right).trim()).toLowerCase();
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
  const next = [shimDir, ...filtered];
  return {
    parts: next,
    changed: next.length !== parts.length || next.some((entry, index) => !sameWindowsPath(entry, parts[index] || ""))
  };
}

function ensureWindowsShimPath(shimDir, originalCommand) {
  const activeNow = pathDirPrecedesOriginal(shimDir, originalCommand);
  if (process.env.AI_BATTERY_SKIP_WINDOWS_PATH_WRITE === "1") {
    return {
      changed: false,
      rcPath: null,
      note: `Skipped Windows user PATH update for ${shimDir}`
    };
  }

  const parts = windowsUserPathParts();
  const nextPath = windowsUserPathWithShim(parts, shimDir);
  if (activeNow && !nextPath.changed) {
    return {
      changed: false,
      rcPath: null,
      note: `${shimDir} is already configured in the Windows user PATH. Open a new cmd/PowerShell if this terminal cached the old command.`
    };
  }

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
  if (result.status !== 0 || result.error) throw new Error("Could not remove the AI Battery entry from Windows user PATH; kept the recovery record");
  return ["Windows user PATH"];
}
  return {
    ensureWindowsShimPath,
    removeWindowsUserPathEntries,
    windowsUserPathWithShim
  };
}
