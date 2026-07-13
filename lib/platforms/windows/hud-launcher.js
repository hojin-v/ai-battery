import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createWindowsHudPlatform({
  buildStartProcessCommand,
  commandExists,
  macRunHud,
  powerShellCommandArgs,
  prefetchInitialJson,
  ps1Path,
  psSingleQuote,
  scriptDir,
  shellQuote,
  useWsl,
  waitForFile,
  winArgQuote,
  windowsHudMainPath,
  windowsHudSourceDir,
  wslEnvPrefix,
  wslPath
}) {
  const powershell = "powershell.exe";

function normalizeHudTextOption(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["black", "dark", "ink"].includes(normalized)) return "dark";
  if (["white", "light", "bright"].includes(normalized)) return "light";
  throw new Error("--text must be one of: black or white");
}

function hudTextForTaskbar(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["light", "white-taskbar", "light-taskbar", "lightbar"].includes(normalized)) return "dark";
  if (["dark", "black-taskbar", "dark-taskbar", "darkbar"].includes(normalized)) return "light";
  throw new Error("taskbar color must be one of: light or dark");
}

function normalizeHudBackdropOption(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "on", "solid", "backdrop"].includes(normalized)) return "on";
  if (["0", "false", "no", "off", "none", "transparent"].includes(normalized)) return "off";
  throw new Error("--backdrop must be one of: on, off");
}

function optionValue(cliArgs, index, optionName) {
  const next = cliArgs[index + 1];
  if (!next || String(next).startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return next;
}

function normalizeDockPosition(value) {
  const normalized = String(value || "bottom").trim().toLowerCase();
  if (["bottom", "status", "statusline"].includes(normalized)) return "bottom";
  if (["tabs", "tab", "top"].includes(normalized)) return "tabs";
  throw new Error("--dock-position must be one of: bottom or tabs");
}

function windowsHudUsage() {
  return [
    "Taskbar color:",
    "  ai-battery hud light     light taskbar -> black text",
    "  ai-battery hud dark      dark taskbar -> white text",
    "",
    "Text color:",
    "  ai-battery hud black     black text",
    "  ai-battery hud white     white text",
    "",
    "Other:",
    "  ai-battery hud stop",
    "  ai-battery hud status",
    "  ai-battery hud --backdrop",
    "  ai-battery hud autostart on light",
    "",
    "Terminal docking (used by the Windows codex wrapper):",
    "  ai-battery hud --dock-console        dock onto the launching terminal window",
    "  ai-battery hud --dock-window HWND    dock onto a specific top-level window",
    "  ai-battery hud --dock-position MODE  bottom (default) or tabs"
  ].join("\n");
}

function describeWindowsHudOptions(filteredArgs) {
  const descriptions = [];
  for (let i = 0; i < filteredArgs.length; i += 1) {
    const option = String(filteredArgs[i]).toLowerCase();
    const value = filteredArgs[i + 1];
    if (option === "-text") {
      descriptions.push(value === "dark" ? "black text" : "white text");
      i += 1;
    } else if (option === "-backdrop") {
      descriptions.push(value === "on" ? "backdrop on" : "backdrop off");
      i += 1;
    } else if (option === "-transparent") {
      descriptions.push(value === "solid" ? "solid background" : "transparent background");
      i += 1;
    }
  }

  return [...new Set(descriptions)].join(", ");
}

function hasHudOption(filteredArgs, option) {
  const normalized = String(option).toLowerCase();
  return filteredArgs.some((arg) => String(arg).toLowerCase() === normalized);
}

const HUD_PASSTHROUGH_OPTIONS_WITH_VALUE = new Set([
  "-batterycommand",
  "-batterycommandbase64",
  "-initialjsonbase64",
  "-interval",
  "-mode",
  "-opacity",
  "-position",
  "-readypath",
  "-width"
]);

const HUD_PASSTHROUGH_SWITCHES = new Set([
  "-clickthrough",
  "-locked",
  "-movable",
  "-once",
  "-stopexisting",
  "-usewsl"
]);

function parseWindowsHudArgs(cliArgs) {
  const passthroughArgs = [];
  let textMode = null;
  let backdropMode = null;
  let transparentMode = null;
  let foreground = false;
  let once = false;
  let stop = false;
  let subcommand = null;
  let autostartAction = "status";
  let dockConsole = false;
  let dockDetach = false;
  let dockWindow = 0;
  let dockSession = 0;
  let dockOwnerPid = 0;
  let dockProvider = "";
  let dockMarkerPath = "";
  let dockTitleHint = "";
  let dockPosition = normalizeDockPosition(
    process.env.AI_BATTERY_WIN_DOCK_POSITION
      ?? process.env.CLAUDEX_BATTERY_WIN_DOCK_POSITION
      ?? "bottom"
  );

  const setTextMode = (value) => {
    textMode = normalizeHudTextOption(value);
  };
  const setBackdropMode = (value) => {
    backdropMode = normalizeHudBackdropOption(value);
    if (backdropMode === "on" && textMode === null) {
      textMode = "light";
    }
  };
  const optionalBackdropValue = (value) => {
    try {
      return normalizeHudBackdropOption(value);
    } catch {
      return null;
    }
  };

  for (let i = 0; i < cliArgs.length; i += 1) {
    const arg = cliArgs[i];
    const lowerArg = String(arg).toLowerCase();
    if (arg === "-Foreground" || arg === "--foreground") {
      foreground = true;
    } else if (arg === "-Movable" || arg === "--movable") {
      passthroughArgs.push("-Movable");
    } else if (arg === "-Once" || arg === "--once") {
      once = true;
      passthroughArgs.push("-Once");
    } else if (arg === "-Stop" || arg === "--stop" || arg === "stop") {
      stop = true;
      passthroughArgs.push("-StopExisting");
    } else if (arg === "start") {
      // Launching is the default action.
    } else if (arg === "status") {
      subcommand = "status";
    } else if (arg === "autostart") {
      subcommand = "autostart";
      const next = cliArgs[i + 1];
      if (next === "on" || next === "off" || next === "status") {
        autostartAction = next;
        i += 1;
      }
    } else if (lowerArg === "--black" || lowerArg === "black") {
      setTextMode("black");
    } else if (lowerArg === "--white" || lowerArg === "white") {
      setTextMode("white");
    } else if (lowerArg === "--light" || lowerArg === "light") {
      textMode = hudTextForTaskbar("light");
    } else if (lowerArg === "--dark" || lowerArg === "dark") {
      textMode = hudTextForTaskbar("dark");
    } else if (lowerArg === "--text" || lowerArg === "--hud-text") {
      setTextMode(optionValue(cliArgs, i, arg));
      i += 1;
    } else if (lowerArg.startsWith("--text=") || lowerArg.startsWith("--hud-text=")) {
      setTextMode(arg.slice(arg.indexOf("=") + 1));
    } else if (lowerArg === "--backdrop") {
      const next = cliArgs[i + 1];
      const backdropValue = next && !String(next).startsWith("-") ? optionalBackdropValue(next) : null;
      if (backdropValue) {
        setBackdropMode(backdropValue);
        i += 1;
      } else {
        setBackdropMode("on");
      }
    } else if (lowerArg.startsWith("--backdrop=")) {
      setBackdropMode(arg.slice(arg.indexOf("=") + 1));
    } else if (lowerArg === "-backdrop") {
      setBackdropMode(optionValue(cliArgs, i, arg));
      i += 1;
    } else if (lowerArg === "--no-backdrop") {
      setBackdropMode("off");
    } else if (lowerArg === "--dock-console") {
      dockConsole = true;
    } else if (lowerArg === "--dock-detach") {
      dockDetach = true;
    } else if (lowerArg === "--dock-tabs") {
      dockPosition = "tabs";
    } else if (lowerArg === "--dock-bottom") {
      dockPosition = "bottom";
    } else if (lowerArg === "--dock-position" || lowerArg === "-dockplacement") {
      dockPosition = normalizeDockPosition(optionValue(cliArgs, i, arg));
      i += 1;
    } else if (lowerArg.startsWith("--dock-position=")) {
      dockPosition = normalizeDockPosition(arg.slice(arg.indexOf("=") + 1));
    } else if (lowerArg === "--dock-window") {
      dockWindow = Number(optionValue(cliArgs, i, arg));
      i += 1;
    } else if (lowerArg.startsWith("--dock-window=")) {
      dockWindow = Number(arg.slice(arg.indexOf("=") + 1));
    } else if (lowerArg === "--dock-session") {
      dockSession = Number(optionValue(cliArgs, i, arg));
      i += 1;
    } else if (lowerArg.startsWith("--dock-session=")) {
      dockSession = Number(arg.slice(arg.indexOf("=") + 1));
    } else if (lowerArg === "--dock-owner-pid") {
      dockOwnerPid = Number(optionValue(cliArgs, i, arg));
      i += 1;
    } else if (lowerArg.startsWith("--dock-owner-pid=")) {
      dockOwnerPid = Number(arg.slice(arg.indexOf("=") + 1));
    } else if (lowerArg === "--dock-provider") {
      dockProvider = String(optionValue(cliArgs, i, arg)).trim().toLowerCase();
      if (!["codex", "claude"].includes(dockProvider)) throw new Error("--dock-provider must be codex or claude");
      i += 1;
    } else if (lowerArg.startsWith("--dock-provider=")) {
      dockProvider = String(arg.slice(arg.indexOf("=") + 1)).trim().toLowerCase();
      if (!["codex", "claude"].includes(dockProvider)) throw new Error("--dock-provider must be codex or claude");
    } else if (lowerArg === "--dock-marker") {
      dockMarkerPath = String(optionValue(cliArgs, i, arg)).trim();
      i += 1;
    } else if (lowerArg.startsWith("--dock-marker=")) {
      dockMarkerPath = String(arg.slice(arg.indexOf("=") + 1)).trim();
    } else if (lowerArg === "--dock-title-hint") {
      dockTitleHint = String(optionValue(cliArgs, i, arg)).trim();
      i += 1;
    } else if (lowerArg.startsWith("--dock-title-hint=")) {
      dockTitleHint = String(arg.slice(arg.indexOf("=") + 1)).trim();
    } else if (lowerArg === "--solid") {
      transparentMode = "solid";
    } else if (lowerArg === "--transparent") {
      transparentMode = "on";
    } else if (lowerArg === "-transparent") {
      transparentMode = optionValue(cliArgs, i, arg);
      i += 1;
    } else if (lowerArg === "-text") {
      setTextMode(optionValue(cliArgs, i, arg));
      i += 1;
    } else if (arg.startsWith("-")) {
      if (HUD_PASSTHROUGH_OPTIONS_WITH_VALUE.has(lowerArg)) {
        passthroughArgs.push(arg, optionValue(cliArgs, i, arg));
        i += 1;
      } else if (HUD_PASSTHROUGH_SWITCHES.has(lowerArg)) {
        passthroughArgs.push(arg);
      } else {
        throw new Error(`unknown HUD option: ${arg}`);
      }
    } else {
      throw new Error(`unknown HUD option: ${arg}`);
    }
  }

  const filteredArgs = [...passthroughArgs];
  if (backdropMode !== null) filteredArgs.push("-Backdrop", backdropMode);
  if (textMode !== null) filteredArgs.push("-Text", textMode);
  if (transparentMode !== null) filteredArgs.push("-Transparent", transparentMode);

  return {
    filteredArgs,
    foreground,
    once,
    stop,
    subcommand,
    autostartAction,
    dockConsole,
    dockDetach,
    dockPosition,
    dockSession: Number.isFinite(dockSession) && dockSession > 0 ? Math.trunc(dockSession) : 0,
    dockOwnerPid: Number.isFinite(dockOwnerPid) && dockOwnerPid > 0 ? Math.trunc(dockOwnerPid) : 0,
    dockProvider,
    dockMarkerPath,
    dockTitleHint,
    dockWindow: Number.isFinite(dockWindow) && dockWindow > 0 ? Math.trunc(dockWindow) : 0
  };
}

function runDesktopHud(cliArgs) {
  if (process.platform === "darwin") {
    macRunHud(cliArgs);
    return;
  }

  if (!useWsl && process.platform !== "win32") {
    console.error("ai-battery-hud: desktop HUD needs Windows (native or WSL) or macOS.");
    console.error("On Linux terminals use: ai-battery --watch");
    process.exit(1);
  }

  if (!commandExists(powershell)) {
    console.error("ai-battery-hud: powershell.exe is required for the Windows HUD.");
    process.exit(1);
  }

  runWindowsHud(cliArgs);
}

function runWindowsHud(cliArgs) {
const parsedArgs = (() => {
  try {
    return parseWindowsHudArgs(cliArgs);
  } catch (error) {
    console.error(`ai-battery-hud: ${error.message}`);
    console.error(windowsHudUsage());
    process.exit(1);
  }
})();
const {
  filteredArgs,
  foreground,
  once,
  stop,
  subcommand,
  autostartAction,
  dockConsole,
  dockDetach,
  dockPosition,
  dockSession,
  dockOwnerPid,
  dockProvider,
  dockMarkerPath,
  dockTitleHint,
  dockWindow
} = parsedArgs;

const hudScript = useWsl ? wslPath(windowsHudMainPath) : ps1Path;
const hudSourceDir = useWsl ? wslPath(windowsHudSourceDir) : windowsHudSourceDir;
const nodePath = process.execPath;
const batteryJs = path.join(scriptDir, "ai-battery.js");
const configuredCommand = process.env.AI_BATTERY_COMMAND || process.env.CLAUDEX_BATTERY_COMMAND;
const envPrefix = useWsl ? wslEnvPrefix() : "";
const batteryCommand = configuredCommand || (useWsl
  ? `${envPrefix ? `${envPrefix} ` : ""}HOME=${shellQuote(os.homedir())} ${shellQuote(nodePath)} ${shellQuote(batteryJs)} --json`
  : `& ${winArgQuote(nodePath)} ${winArgQuote(batteryJs)} --json`);
const batteryCommandBase64 = Buffer.from(batteryCommand, "utf8").toString("base64");

function writeDockLauncherMarker(stage) {
  if (!dockMarkerPath || !dockProvider || !dockOwnerPid) return;
  try {
    fs.mkdirSync(path.dirname(dockMarkerPath), { recursive: true });
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(dockMarkerPath, "utf8")); } catch { /* First attachment. */ }
    let previousHostAlive = false;
    try {
      if (Number(previous?.hostPid) > 0) {
        process.kill(Number(previous.hostPid), 0);
        previousHostAlive = true;
      }
    } catch { /* Stale host marker. */ }
    const targetChanged = Number(dockWindow) > 0
      && Number(previous?.hwnd) > 0
      && Number(dockWindow) !== Number(previous.hwnd);
    if (previousHostAlive && previous?.attachedAt && !targetChanged) {
      hudDebugLog(`preserving attached marker pid=${previous.hostPid} hwnd=${previous.hwnd}`);
      return;
    }
    const previousHwnd = Number(previous?.previousHwnd || previous?.hwnd) || 0;
    const tempPath = `${dockMarkerPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify({
      attemptedAt: new Date().toISOString(),
      ownerPid: dockOwnerPid,
      launcherPid: process.pid,
      stage,
      ...(previousHwnd ? { previousHwnd } : {}),
      ...(Number(previous?.columns) > 0 ? { columns: Number(previous.columns) } : {}),
      ...(previous?.windowCheckedAt ? { windowCheckedAt: previous.windowCheckedAt } : {})
    })}\n`, "utf8");
    fs.renameSync(tempPath, dockMarkerPath);
  } catch {
    // Provider attachment is best-effort and must not delay its statusline.
  }
}

if ((dockConsole || dockWindow) && !dockDetach) {
  writeDockLauncherMarker(dockWindow ? "launching-host" : "resolving-window");
}

const AUTOSTART_REG_PATH = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const AUTOSTART_REG_NAME = "AiBatteryHud";

function runPowerShell(command) {
  return spawnSync(powershell, ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    windowsHide: true
  });
}

function resolveDockConsoleWindow(ownerPid = 0, titleHint = "") {
  // Runs console-attached (no windowsHide) so GetConsoleWindow sees the real
  // console when launched from classic conhost. Under Windows Terminal the
  // console window is a hidden pseudo-window; the hosting terminal is found
  // deterministically by walking this process's parent chain until an
  // ancestor owns a visible top-level window (WindowsTerminal.exe, Code.exe,
  // wezterm-gui.exe, ...). The foreground window is only used to pick among
  // multiple windows of that ancestor.
  const targetOwnerPid = Number.isFinite(Number(ownerPid)) && Number(ownerPid) > 0
    ? Math.trunc(Number(ownerPid))
    : 0;
  const titleHintName = path.win32.basename(String(titleHint || "").replace(/\//g, "\\"));
  const titleHintBase64 = Buffer.from(titleHintName, "utf8").toString("base64");
  const resolveResultPath = path.join(
    os.tmpdir(),
    `ai-battery-dock-resolve-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
  );
  const resolveResultPathBase64 = Buffer.from(resolveResultPath, "utf8").toString("base64");
  const script = [
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Text;",
    "using System.Runtime.InteropServices;",
    "namespace AiBatteryDock {",
    "  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }",
    "  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
    "  public struct ProcessEntry {",
    "    public uint Size; public uint Usage; public uint ProcessId; public IntPtr DefaultHeapId;",
    "    public uint ModuleId; public uint Threads; public uint ParentProcessId; public int BasePriority;",
    "    public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExeFile;",
    "  }",
    "  public static class Native {",
    "    const uint SnapshotProcesses = 0x00000002;",
    "    [DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow();",
    "    [DllImport(\"kernel32.dll\")] public static extern bool FreeConsole();",
    "    [DllImport(\"kernel32.dll\")] public static extern bool AttachConsole(uint processId);",
    "    [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode)] public static extern uint GetConsoleTitle(StringBuilder title, uint size);",
    "    [DllImport(\"kernel32.dll\")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);",
    "    [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode)] static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);",
    "    [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode)] static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);",
    "    [DllImport(\"kernel32.dll\")] static extern bool CloseHandle(IntPtr handle);",
    "    [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);",
    "    [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hWnd);",
    "    [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
    "    [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);",
    "    [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder title, int size);",
    "    [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);",
    "    public static uint GetParentProcessId(uint processId) {",
    "      IntPtr snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);",
    "      if (snapshot == new IntPtr(-1)) return 0;",
    "      try {",
    "        ProcessEntry entry = new ProcessEntry(); entry.Size = (uint)Marshal.SizeOf(entry);",
    "        if (!Process32First(snapshot, ref entry)) return 0;",
    "        do { if (entry.ProcessId == processId) return entry.ParentProcessId; } while (Process32Next(snapshot, ref entry));",
    "        return 0;",
    "      } finally { CloseHandle(snapshot); }",
    "    }",
    "  }",
    "}",
    "'@",
    `$resolveResultPath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${resolveResultPathBase64}'))`,
    "function Complete-DockResolution([Int64]$Handle) {",
    "  try { [System.IO.File]::WriteAllText($resolveResultPath, [string]$Handle, [System.Text.UTF8Encoding]::new($false)) } catch { }",
    "  exit 0",
    "}",
    "# Capture the launching window before CIM/process discovery can yield long",
    "# enough for focus to move to another terminal window.",
    "$launchForeground = [AiBatteryDock.Native]::GetForegroundWindow()",
    `if (${targetOwnerPid} -gt 0) { [AiBatteryDock.Native]::FreeConsole() | Out-Null; [AiBatteryDock.Native]::AttachConsole([uint32]${targetOwnerPid}) | Out-Null }`,
    "$consoleTitleBuffer = [System.Text.StringBuilder]::new(1024)",
    "[AiBatteryDock.Native]::GetConsoleTitle($consoleTitleBuffer, 1024) | Out-Null",
    "$consoleTitle = $consoleTitleBuffer.ToString()",
    "$normalizedConsoleTitle = (($consoleTitle -replace '^[^\\p{L}\\p{N}~._-]+', '').Trim())",
    `$dockTitleHint = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${titleHintBase64}'))`,
    "$normalizedDockTitleHint = (($dockTitleHint -replace '^[^\\p{L}\\p{N}~._-]+', '').Trim())",
    "$terminals = @('windowsterminal','conhost','openconsole','cmd','powershell','pwsh','wezterm-gui','alacritty','code','hyper','tabby','conemu64','conemu')",
    "$terminalWindowHosts = @('windowsterminal','wezterm-gui','alacritty','code','hyper','tabby','conemu64','conemu')",
    "# Classic conhost: the console window is the terminal window itself. The",
    "# ConPTY pseudo-console window under Windows Terminal also reports",
    "# WS_VISIBLE on current builds but is zero-sized, so require a real rect.",
    "$console = [AiBatteryDock.Native]::GetConsoleWindow()",
    "if ($console -ne [IntPtr]::Zero -and [AiBatteryDock.Native]::IsWindowVisible($console)) {",
    "  $cr = New-Object AiBatteryDock.Rect",
    "  if ([AiBatteryDock.Native]::GetWindowRect($console, [ref]$cr) -and ($cr.Right - $cr.Left) -gt 200 -and ($cr.Bottom - $cr.Top) -gt 100) {",
    "    Complete-DockResolution ([Int64]$console)",
    "  }",
    "}",
    "# The normal path is an already-foreground terminal. Resolve it before the",
    "# comparatively expensive Win32_Process CIM scan.",
    "if ($launchForeground -ne [IntPtr]::Zero) {",
    "  $launchPid = [uint32]0",
    "  [AiBatteryDock.Native]::GetWindowThreadProcessId($launchForeground, [ref]$launchPid) | Out-Null",
    "  $launchName = ''",
    "  try { $launchName = (Get-Process -Id $launchPid -ErrorAction Stop).ProcessName.ToLowerInvariant() } catch { }",
    "  $launchTitleBuffer = [System.Text.StringBuilder]::new(1024)",
    "  [AiBatteryDock.Native]::GetWindowText($launchForeground, $launchTitleBuffer, 1024) | Out-Null",
    "  $normalizedLaunchTitle = (($launchTitleBuffer.ToString() -replace '^[^\\p{L}\\p{N}~._-]+', '').Trim())",
    "  $launchConsoleTitleMatch = $normalizedConsoleTitle -and $normalizedLaunchTitle -eq $normalizedConsoleTitle",
    "  $launchDockTitleMatch = $normalizedDockTitleHint -and ($normalizedLaunchTitle -eq $normalizedDockTitleHint -or $normalizedLaunchTitle.EndsWith(\" - $normalizedDockTitleHint\"))",
    "  $launchRect = New-Object AiBatteryDock.Rect",
    `  $launchIdentityMatches = if (${targetOwnerPid} -le 0) { $true } else { $launchConsoleTitleMatch -or $launchDockTitleMatch }`,
    "  if ($launchIdentityMatches -and $terminals -contains $launchName -and [AiBatteryDock.Native]::GetWindowRect($launchForeground, [ref]$launchRect) -and ($launchRect.Right - $launchRect.Left) -gt 200 -and ($launchRect.Bottom - $launchRect.Top) -gt 100) {",
    "    Complete-DockResolution ([Int64]$launchForeground)",
    "  }",
    "}",
    "# Collect only this provider's ancestor chain with Toolhelp. CIM startup",
    "# made Claude's first statusLine several seconds late on some systems.",
    "$ancestorPids = @{}",
    `$current = if (${targetOwnerPid} -gt 0) { [uint32]${targetOwnerPid} } else { [uint32]$PID }`,
    "for ($depth = 0; $depth -lt 10; $depth += 1) {",
    "  $current = [AiBatteryDock.Native]::GetParentProcessId($current)",
    "  if ($current -eq 0) { break }",
    "  $ancestorName = ''",
    "  try { $ancestorName = (Get-Process -Id $current -ErrorAction Stop).ProcessName.ToLowerInvariant() } catch { }",
    "  if ($ancestorName -eq 'explorer' -or $ancestorName -eq '') { continue }",
    "  $ancestorPids[$current] = $true",
    "  if ($terminalWindowHosts -contains $ancestorName) { break }",
    "}",
    "# A background Windows Terminal window can share its process with the",
    "# foreground window. Match the inherited console title first so Claude's",
    "# statusLine docks to its own window without stealing Codex's target.",
    "$candidateWindows = [System.Collections.Generic.List[Int64]]::new()",
    "$dockTitleMatches = [System.Collections.Generic.List[Int64]]::new()",
    "$consoleTitleMatches = [System.Collections.Generic.List[Int64]]::new()",
    "if ($ancestorPids.Count -gt 0) {",
    "  $enumCallback = [AiBatteryDock.EnumWindowsProc]{",
    "    param([IntPtr]$candidate, [IntPtr]$unused)",
    "    if ([AiBatteryDock.Native]::IsWindowVisible($candidate)) {",
    "      $candidatePid = [uint32]0",
    "      [AiBatteryDock.Native]::GetWindowThreadProcessId($candidate, [ref]$candidatePid) | Out-Null",
    "      if ($ancestorPids.ContainsKey($candidatePid)) {",
    "        $candidateRect = New-Object AiBatteryDock.Rect",
    "        if ([AiBatteryDock.Native]::GetWindowRect($candidate, [ref]$candidateRect) -and ($candidateRect.Right - $candidateRect.Left) -gt 200 -and ($candidateRect.Bottom - $candidateRect.Top) -gt 100) {",
    "          $candidateWindows.Add([Int64]$candidate)",
    "          $candidateTitleBuffer = [System.Text.StringBuilder]::new(1024)",
    "          [AiBatteryDock.Native]::GetWindowText($candidate, $candidateTitleBuffer, 1024) | Out-Null",
    "          $normalizedCandidateTitle = (($candidateTitleBuffer.ToString() -replace '^[^\\p{L}\\p{N}~._-]+', '').Trim())",
    "          $consoleTitleMatch = $normalizedConsoleTitle -and $normalizedCandidateTitle -eq $normalizedConsoleTitle",
    "          $dockTitleMatch = $normalizedDockTitleHint -and ($normalizedCandidateTitle -eq $normalizedDockTitleHint -or $normalizedCandidateTitle.EndsWith(\" - $normalizedDockTitleHint\"))",
    "          if ($normalizedCandidateTitle -and $dockTitleMatch) { $dockTitleMatches.Add([Int64]$candidate) }",
    "          if ($normalizedCandidateTitle -and $consoleTitleMatch) { $consoleTitleMatches.Add([Int64]$candidate) }",
    "        }",
    "      }",
    "    }",
    "    return $true",
    "  }",
    "  [AiBatteryDock.Native]::EnumWindows($enumCallback, [IntPtr]::Zero) | Out-Null",
    "}",
    "if ($env:AI_BATTERY_HUD_DEBUG_LOG) {",
    "  try { Add-Content -LiteralPath $env:AI_BATTERY_HUD_DEBUG_LOG -Value (\"resolver-debug console='$normalizedConsoleTitle' hint='$normalizedDockTitleHint' ancestors=$($ancestorPids.Keys -join ',') candidates=$($candidateWindows -join ',') consoleMatches=$($consoleTitleMatches -join ',') hintMatches=$($dockTitleMatches -join ',') foreground=$([Int64]$launchForeground)\") } catch { }",
    "}",
    "# The console title belongs to this exact provider console. Prefer it to",
    "# the workspace hint because Claude replaces the terminal title at startup.",
    "if ($consoleTitleMatches.Count -eq 1) { Complete-DockResolution ([Int64]$consoleTitleMatches[0]) }",
    "if ($consoleTitleMatches.Count -gt 1 -and $consoleTitleMatches.Contains([Int64]$launchForeground)) { Complete-DockResolution ([Int64]$launchForeground) }",
    "if ($dockTitleMatches.Count -eq 1) { Complete-DockResolution ([Int64]$dockTitleMatches[0]) }",
    "if ($dockTitleMatches.Count -gt 1 -and $dockTitleMatches.Contains([Int64]$launchForeground)) { Complete-DockResolution ([Int64]$launchForeground) }",
    "if ($candidateWindows.Count -eq 1) { Complete-DockResolution ([Int64]$candidateWindows[0]) }",
    `if (${targetOwnerPid} -gt 0 -and $candidateWindows.Count -gt 1 -and ($normalizedConsoleTitle -or $normalizedDockTitleHint)) { Complete-DockResolution 0 }`,
    "# A terminal process can own several windows (Windows Terminal windows are",
    "# one process), so prefer the foreground HWND captured at launcher entry.",
    "# Later foreground samples are fallbacks, not replacements for that identity.",
    "$seenWindows = @{}",
    "for ($try = 0; $try -lt 20; $try += 1) {",
    "  $fg = if ($try -eq 0) { $launchForeground } else { [AiBatteryDock.Native]::GetForegroundWindow() }",
    "  if ($fg -eq [IntPtr]::Zero -or $seenWindows.ContainsKey([Int64]$fg)) { Start-Sleep -Milliseconds 100; continue }",
    "  $seenWindows[[Int64]$fg] = $true",
    "  if ($fg -ne [IntPtr]::Zero) {",
    "    $fgPid = [uint32]0",
    "    [AiBatteryDock.Native]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null",
    "    $fgName = ''",
    "    try { $fgName = (Get-Process -Id $fgPid -ErrorAction Stop).ProcessName.ToLowerInvariant() } catch { }",
    "    $parentChainUnavailable = $ancestorPids.Count -eq 0",
    "    if ($ancestorPids.ContainsKey($fgPid) -or ($parentChainUnavailable -and $terminals -contains $fgName)) {",
    "      $r = New-Object AiBatteryDock.Rect",
    "      if ([AiBatteryDock.Native]::GetWindowRect($fg, [ref]$r) -and ($r.Right - $r.Left) -gt 200 -and ($r.Bottom - $r.Top) -gt 100) {",
    "        Complete-DockResolution ([Int64]$fg)",
    "      }",
    "    }",
    "  }",
    "  Start-Sleep -Milliseconds 100",
    "}",
    "Complete-DockResolution 0"
  ].join("\n");
  let result;
  let resolvedOutput = "";
  try {
    result = spawnSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8",
      windowsHide: false,
      timeout: 15000
    });
    try { resolvedOutput = fs.readFileSync(resolveResultPath, "utf8").trim(); } catch { /* Resolver did not complete. */ }
  } finally {
    try { fs.rmSync(resolveResultPath, { force: true }); } catch { /* Best-effort temp cleanup. */ }
  }
  if (process.env.AI_BATTERY_HUD_DEBUG_LOG) {
    try {
      fs.appendFileSync(
        process.env.AI_BATTERY_HUD_DEBUG_LOG,
        `${new Date().toISOString()} resolver status=${result.status} signal=${result.signal || ""} result=${JSON.stringify(resolvedOutput)} stdout=${JSON.stringify(String(result.stdout || "").trim())} stderr=${JSON.stringify(String(result.stderr || "").trim())}\n`
      );
    } catch {
      // Resolver diagnostics are optional.
    }
  }
  if (result.status !== 0) return 0;
  const handle = Number(resolvedOutput);
  return Number.isFinite(handle) && handle > 0 ? Math.trunc(handle) : 0;
}

function refreshWslHudScriptCopy() {
  if (!useWsl) return null;
  const result = runPowerShell([
    "$dir = Join-Path $env:LOCALAPPDATA 'ai-battery\hud'",
    "New-Item -ItemType Directory -Force -Path $dir | Out-Null",
    "$hud = Join-Path $dir 'ai-battery-hud.ps1'",
    `$srcDir = ${psSingleQuote(hudSourceDir)}`,
    "Copy-Item (Join-Path $srcDir '*.ps1') $dir -Force -ErrorAction Stop",
    "Copy-Item (Join-Path $srcDir 'main.ps1') $hud -Force -ErrorAction Stop",
    "Write-Output $hud"
  ].join("; "));
  if (result.status !== 0) return null;
  const output = (result.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
  return output || null;
}

function hudProcessStatus() {
  const query = [
    "$status = $null",
    "try {",
    "  $hud = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { " +
      "$_.ProcessId -ne $PID -and " +
      "$_.Name -match '^(powershell|pwsh)' -and " +
      "$_.CommandLine -like '*ai-battery-hud.ps1*' -and " +
      "$_.CommandLine -notlike '*Start-Process*' -and " +
      "$_.CommandLine -notlike '*-DockWindowHandle*' }",
    "  if ($hud) { $p = @($hud)[0]; $source = if ($p.CommandLine -like '*-UseWsl*') { 'WSL' } else { 'Windows' }; $status = 'running (' + $source + ', PID ' + $p.ProcessId + ')' }",
    "} catch { }",
    "if (-not $status) {",
    "  try { $m = [System.Threading.Mutex]::OpenExisting('Local\\AiBatteryHud'); $m.Dispose(); $status = 'running (Windows, mutex)' } catch { $status = 'stopped' }",
    "}",
    "$status"
  ].join("; ");
  const result = runPowerShell(query);
  return (result.stdout || "").trim() || "unknown";
}

function autostartStatus() {
  const result = runPowerShell([
    `$v = (Get-ItemProperty -Path '${AUTOSTART_REG_PATH}' -Name '${AUTOSTART_REG_NAME}' -ErrorAction SilentlyContinue).${AUTOSTART_REG_NAME}`,
    "$source = ''",
    "$auto = Join-Path $env:LOCALAPPDATA 'ai-battery\\autostart.ps1'",
    "if (Test-Path $auto) { "
      + "$text = Get-Content -Raw -Path $auto; "
      + "if ($text -like '*-UseWsl*' -or $text -like '*wsl.exe*') { $source = 'WSL' } "
      + "elseif ($text -like '*ai-battery-hud.ps1*') { $source = 'Windows' } "
      + "}",
    "if (-not $source -and $v -like '*-UseWsl*') { $source = 'WSL' }",
    "if (-not $source -and $v) { $source = 'Windows' }",
    "if ($v) { 'on'; $source; $v } else { 'off' }"
  ].join("; "));
  const lines = (result.stdout || "").trim().split(/\r?\n/);
  const enabled = lines[0] === "on";
  return {
    enabled,
    source: enabled ? (lines[1] || null) : null,
    command: enabled ? (lines.slice(2).join("\n") || null) : null
  };
}

function autostartStatusLabel(auto) {
  if (!auto.enabled) return "off";
  return `on${auto.source ? ` (${auto.source})` : ""}`;
}

function autostartEnable() {
  // autostart.ps1 refreshes the local copy of the HUD script when the source
  // is reachable (the WSL share is not mounted until the distro starts), then
  // launches the copy so sign-in start never depends on WSL being up. The HUD
  // must run as a separate PowerShell process whose command line contains
  // ai-battery-hud.ps1: stop/status and single-instance cleanup match it.
  const autostartExtraArgs = filteredArgs
    .filter((arg) => arg !== "-Once" && arg !== "-StopExisting")
    .map(psSingleQuote)
    .join(" ");
  const autostartScript = [
    "# Generated by: ai-battery hud autostart on",
    `$srcDir = ${psSingleQuote(hudSourceDir)}`,
    "$hudDir = Join-Path $PSScriptRoot 'hud'",
    "New-Item -ItemType Directory -Force -Path $hudDir | Out-Null",
    "$hud = Join-Path $hudDir 'ai-battery-hud.ps1'",
    "try { Copy-Item (Join-Path $srcDir '*.ps1') $hudDir -Force -ErrorAction Stop; Copy-Item (Join-Path $srcDir 'main.ps1') $hud -Force -ErrorAction Stop } catch { }",
    `$battery = ${psSingleQuote(batteryCommand)}`,
    "$batteryB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($battery))",
    "$invoke = '& ' + \"'\" + ($hud -replace \"'\", \"''\") + \"'\" + ' -BatteryCommandBase64 ' + $batteryB64"
      + (autostartExtraArgs ? ` + ${psSingleQuote(` ${autostartExtraArgs}`)}` : "")
      + (useWsl ? " + ' -UseWsl'" : ""),
    "$argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ('\"' + ($invoke -replace '\"', '\\\"') + '\"')) -join ' '",
    "Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList $argList",
    ""
  ].join("\r\n");
  const autostartB64 = Buffer.from(autostartScript, "utf8").toString("base64");

  const script = [
    "$dir = Join-Path $env:LOCALAPPDATA 'ai-battery'",
    "New-Item -ItemType Directory -Force -Path $dir | Out-Null",
    "$auto = Join-Path $dir 'autostart.ps1'",
    `[System.IO.File]::WriteAllText($auto, [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${autostartB64}')))`,
    "$hudDir = Join-Path $dir 'hud'",
    "New-Item -ItemType Directory -Force -Path $hudDir | Out-Null",
    `$srcDir = ${psSingleQuote(hudSourceDir)}`,
    "Copy-Item (Join-Path $srcDir '*.ps1') $hudDir -Force",
    "Copy-Item (Join-Path $srcDir 'main.ps1') (Join-Path $hudDir 'ai-battery-hud.ps1') -Force",
    `Set-ItemProperty -Path '${AUTOSTART_REG_PATH}' -Name '${AUTOSTART_REG_NAME}' -Value ('powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $auto + '"')`,
    "Write-Output $auto"
  ].join("; ");
  return runPowerShell(script);
}

function autostartDisable() {
  return runPowerShell([
    `$v = (Get-ItemProperty -Path '${AUTOSTART_REG_PATH}' -Name '${AUTOSTART_REG_NAME}' -ErrorAction SilentlyContinue).${AUTOSTART_REG_NAME}`,
    "$dir = Join-Path $env:LOCALAPPDATA 'ai-battery'",
    "$auto = Join-Path $dir 'autostart.ps1'",
    "$ownedFile = $false",
    "if (Test-Path -LiteralPath $auto) { $ownedFile = (Get-Content -Raw -LiteralPath $auto) -like '*Generated by: ai-battery hud autostart on*' }",
    "if ($v -and ($v -notlike '*ai-battery*autostart.ps1*')) { Write-Error 'AiBatteryHud registry value is not managed by AI Battery; left it untouched.'; exit 2 }",
    `Remove-ItemProperty -Path '${AUTOSTART_REG_PATH}' -Name '${AUTOSTART_REG_NAME}' -ErrorAction SilentlyContinue`,
    "if ($ownedFile) {",
    "  Remove-Item -LiteralPath $auto -Force -ErrorAction SilentlyContinue",
    "  $hudDir = Join-Path $dir 'hud'",
    "  if ((Split-Path -Parent $hudDir) -eq $dir -and (Test-Path -LiteralPath $hudDir)) { Remove-Item -LiteralPath $hudDir -Recurse -Force -ErrorAction SilentlyContinue }",
    "}"
  ].join("\n"));
}

if (subcommand === "status") {
  const auto = autostartStatus();
  console.log(`HUD: ${hudProcessStatus()}`);
  console.log(`Autostart: ${autostartStatusLabel(auto)}`);
  if (auto.command) console.log(`  ${auto.command}`);
  process.exit(0);
}

if (subcommand === "autostart") {
  if (autostartAction === "on") {
    const result = autostartEnable();
    const output = (result.stdout || "").trim();
    if (result.status !== 0 || !output) {
      console.error("ai-battery-hud: failed to register autostart.");
      if ((result.stderr || "").trim()) console.error((result.stderr || "").trim());
      process.exit(1);
    }
    console.log(`HUD autostart enabled: launches at Windows sign-in (${useWsl ? "WSL" : "Windows"}).`);
    console.log(`Launcher: ${output}`);
    console.log("Windows and WSL use the same Run entry; enabling from the other side replaces this launcher.");
    console.log("After updating ai-battery, run \"ai-battery hud autostart on\" again to refresh it.");
  } else if (autostartAction === "off") {
    autostartDisable();
    console.log("HUD autostart disabled.");
  } else {
    const auto = autostartStatus();
    console.log(`Autostart: ${autostartStatusLabel(auto)}`);
    if (auto.command) console.log(`  ${auto.command}`);
  }
  process.exit(0);
}

function hudDebugLog(message) {
  const target = process.env.AI_BATTERY_HUD_DEBUG_LOG;
  if (!target) return;
  try {
    fs.appendFileSync(target, `${new Date().toISOString()} hud.js ${message}\n`);
  } catch {
    // Debug logging must never break the launcher.
  }
}

// The dock target must resolve while this process is still attached to the
// launching console; the HUD itself starts detached and hidden.
let dockWindowHandle = dockWindow;
if (!dockWindowHandle && dockConsole) {
  if (useWsl || process.platform !== "win32") {
    console.error("ai-battery-hud: --dock-console requires native Windows.");
    process.exit(1);
  }
  dockWindowHandle = resolveDockConsoleWindow(dockOwnerPid, dockTitleHint);
  hudDebugLog(`dock-console resolved handle=${dockWindowHandle}`);
  if (!dockWindowHandle) {
    // A provider-launched statusline must never adopt an arbitrary terminal or
    // silently turn into the separate floating HUD. Claude retries on a later
    // statusLine update; a new Codex launch resolves its own terminal again.
    hudDebugLog("dock-console unresolved; waiting for a later provider attachment attempt");
    if (dockProvider) process.exit(0);
  }
}

function dockIpcRoot() {
  return process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "ai-battery")
    : path.join(os.tmpdir(), "ai-battery");
}

function dockIpcPaths(root, hwnd) {
  const windowId = Math.trunc(Number(hwnd) || 0);
  return {
    hwnd: windowId,
    hostPath: path.join(root, `tui-dock-host-${windowId}.json`),
    requestPath: path.join(root, `tui-dock-request-${windowId}.json`)
  };
}

function sendRunningDockHostRequest(paths, request) {
  try {
    const host = JSON.parse(fs.readFileSync(paths.hostPath, "utf8"));
    if (!Number.isFinite(Number(host.pid)) || Number(host.pid) <= 0) return false;
    process.kill(Number(host.pid), 0);
    fs.writeFileSync(paths.requestPath, JSON.stringify({ ...request, at: new Date().toISOString() }), "utf8");
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!fs.existsSync(paths.requestPath)) {
        hudDebugLog(`running dock host request consumed pid=${host.pid} hwnd=${paths.hwnd}`);
        return true;
      }
      Atomics.wait(sleeper, 0, 0, 25);
    }
    fs.rmSync(paths.requestPath, { force: true });
  } catch {
    // A stale marker falls through to the normal mutex-protected launch.
  }
  return false;
}

function activeDockHostPaths(root) {
  try {
    return fs.readdirSync(root)
      .map((name) => /^tui-dock-host-(\d+)\.json$/i.exec(name))
      .filter(Boolean)
      .map((match) => dockIpcPaths(root, Number(match[1])));
  } catch {
    return [];
  }
}

function retireLegacyDockHost(root) {
  const hostPath = path.join(root, "tui-dock-host.json");
  try {
    const host = JSON.parse(fs.readFileSync(hostPath, "utf8"));
    if (Number.isFinite(Number(host.pid)) && Number(host.pid) > 0) {
      try { process.kill(Number(host.pid)); } catch { /* Already stopped. */ }
    }
  } catch {
    // No legacy host is active.
  }
  try { fs.rmSync(hostPath, { force: true }); } catch { /* Best-effort migration. */ }
  try { fs.rmSync(path.join(root, "tui-dock-request.json"), { force: true }); } catch { /* Best-effort migration. */ }
}

function trySendRunningDockHostRequest(request) {
  if (process.platform !== "win32") return false;
  const root = dockIpcRoot();
  if (Number(request.hwnd) > 0) {
    return sendRunningDockHostRequest(dockIpcPaths(root, request.hwnd), request);
  }
  let consumed = false;
  for (const paths of activeDockHostPaths(root)) {
    consumed = sendRunningDockHostRequest(paths, request) || consumed;
  }
  return consumed;
}

function tryAdoptRunningDockHost(hwnd, placement, session, ownerPid, provider, markerPath) {
  if (!hwnd) return false;
  return trySendRunningDockHostRequest({ hwnd, placement, session, ownerPid, provider, markerPath });
}

if (stop) {
  trySendRunningDockHostRequest({ stop: true });
}

if (dockDetach) {
  if (dockSession) {
    trySendRunningDockHostRequest({
      detach: true,
      session: dockSession,
      ownerPid: dockOwnerPid,
      provider: dockProvider
    });
  }
  return;
}
const dockFallbackFloating = dockConsole && !dockWindowHandle;
if (dockFallbackFloating && dockMarkerPath) {
  // Provider statusline attachment must be acknowledged by the dock host. A
  // floating fallback would look successful to the caller but cannot keep a
  // terminal window's session alive.
  hudDebugLog("dock-console unresolved; provider attachment will retry");
  return;
}

if (dockWindowHandle) retireLegacyDockHost(dockIpcRoot());

if (dockWindowHandle && tryAdoptRunningDockHost(
  dockWindowHandle,
  dockPosition,
  dockSession,
  dockOwnerPid,
  dockProvider,
  dockMarkerPath
)) {
  return;
}

const launchHudScript = stop ? hudScript : (refreshWslHudScriptCopy() || hudScript);
const wasRunning = (!foreground && !once && !stop && !dockWindowHandle)
  ? hudProcessStatus().startsWith("running ")
  : false;
const initialJson = (stop || dockWindowHandle) ? null : prefetchInitialJson(batteryCommand, useWsl, batteryJs);
const readyPath = (!useWsl && process.platform === "win32" && !foreground && !once && !stop && !dockWindowHandle)
  ? path.join(os.tmpdir(), `ai-battery-hud-ready-${process.pid}-${Date.now()}.json`)
  : null;

const effectiveFilteredArgs = [...filteredArgs];
if (dockFallbackFloating) {
  if (!hasHudOption(effectiveFilteredArgs, "-Backdrop")) effectiveFilteredArgs.push("-Backdrop", "on");
  if (!hasHudOption(effectiveFilteredArgs, "-Transparent")) effectiveFilteredArgs.push("-Transparent", "solid");
  if (!hasHudOption(effectiveFilteredArgs, "-Position")) effectiveFilteredArgs.push("-Position", "taskbar");
}

const hudScriptArgs = [
  "-BatteryCommandBase64",
  batteryCommandBase64,
  ...effectiveFilteredArgs
];

if (dockWindowHandle) {
  hudScriptArgs.push("-DockWindowHandle", String(dockWindowHandle));
  hudScriptArgs.push("-DockPlacement", dockPosition);
  hudScriptArgs.push("-DockSession", String(dockSession));
  hudScriptArgs.push("-DockOwnerPid", String(dockOwnerPid));
  if (dockProvider) hudScriptArgs.push("-DockProvider", dockProvider);
  if (dockMarkerPath) hudScriptArgs.push("-DockMarkerPath", dockMarkerPath);
}

if (readyPath) {
  hudScriptArgs.push("-ReadyPath", readyPath);
}

if (initialJson) {
  hudScriptArgs.push("-InitialJsonBase64", Buffer.from(initialJson, "utf8").toString("base64"));
}

if (useWsl) {
  hudScriptArgs.push("-UseWsl");
}

const psArgs = powerShellCommandArgs(launchHudScript, hudScriptArgs);

if (foreground || once || stop) {
  const result = spawnSync(powershell, psArgs, { stdio: "inherit", windowsHide: true });
  if (stop && (result.status ?? 0) === 0) {
    console.log("AI Battery HUD stopped.");
  }
  process.exit(result.status ?? 0);
}

if (useWsl) {
  const start = spawnSync(powershell, [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    buildStartProcessCommand("powershell.exe", psArgs)
  ], {
    stdio: "ignore",
    windowsHide: true
  });
  if (start.status !== 0) process.exit(start.status ?? 1);
  } else {
    const start = spawnSync(powershell, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      buildStartProcessCommand("powershell.exe", psArgs)
    ], {
        stdio: "ignore",
      windowsHide: true
    });
    if (start.status !== 0) process.exit(start.status ?? 1);
  }

if (dockWindowHandle) {
  hudDebugLog("hud launch dispatched (docked)");
}
if (readyPath && !waitForFile(readyPath)) {
  console.log("AI Battery HUD start requested, but no visible window was confirmed. Run: ai-battery hud --foreground");
} else {
  const detail = describeWindowsHudOptions(effectiveFilteredArgs);
  const action = wasRunning ? (detail ? "updated" : "restarted") : "started";
  console.log(`AI Battery HUD ${action}${detail ? `: ${detail}` : ""}.`);
  if (!wasRunning) {
    console.log("Drag to move. Right-click to exit.");
  }
}
if (readyPath) fs.rmSync(readyPath, { force: true });
}
  return {
    describeWindowsHudOptions,
    parseWindowsHudArgs,
    runDesktopHud,
    windowsHudUsage
  };
}
