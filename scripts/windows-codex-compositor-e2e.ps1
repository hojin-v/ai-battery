param(
  [string]$ReportPath = "",
  [int]$TimeoutSeconds = 90,
  [string]$CodexPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Quote-WindowsArg($Value) {
  $text = [string]$Value
  if ($text.Length -gt 0 -and $text -notmatch '[\s"]' -and -not $text.StartsWith("\\")) {
    return $text
  }
  $result = '"'
  $backslashes = 0
  foreach ($ch in $text.ToCharArray()) {
    if ($ch -eq [char]92) {
      $backslashes += 1
    } elseif ($ch -eq '"') {
      $result += ('\' * (($backslashes * 2) + 1)) + '"'
      $backslashes = 0
    } else {
      if ($backslashes -gt 0) {
        $result += ('\' * $backslashes)
        $backslashes = 0
      }
      $result += $ch
    }
  }
  if ($backslashes -gt 0) {
    $result += ('\' * ($backslashes * 2))
  }
  return $result + '"'
}

function Join-WindowsArgs([object[]]$Values) {
  return (($Values | ForEach-Object { Quote-WindowsArg $_ }) -join " ")
}

function Add-E2EConsoleType {
  if ("AiBatteryCodexE2EConsole" -as [type]) { return }
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AiBatteryCodexE2EConsole
{
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const ushort KEY_EVENT = 0x0001;
    private const uint LEFT_CTRL_PRESSED = 0x0008;

    [StructLayout(LayoutKind.Sequential)]
    public struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct CONSOLE_SCREEN_BUFFER_INFO
    {
        public COORD dwSize;
        public COORD dwCursorPosition;
        public short wAttributes;
        public SMALL_RECT srWindow;
        public COORD dwMaximumWindowSize;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct KEY_EVENT_RECORD
    {
        [MarshalAs(UnmanagedType.Bool)] public bool bKeyDown;
        public ushort wRepeatCount;
        public ushort wVirtualKeyCode;
        public ushort wVirtualScanCode;
        public char UnicodeChar;
        public uint dwControlKeyState;
    }

    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    public struct INPUT_RECORD
    {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
    }

    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetConsoleScreenBufferInfo(IntPtr output, out CONSOLE_SCREEN_BUFFER_INFO info);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ReadConsoleOutputCharacterW(IntPtr output, StringBuilder text, uint length, COORD origin, out uint read);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool WriteConsoleInputW(IntPtr input, INPUT_RECORD[] records, uint length, out uint written);

    public static string ReadVisibleWindow()
    {
        IntPtr output = GetStdHandle(STD_OUTPUT_HANDLE);
        CONSOLE_SCREEN_BUFFER_INFO info;
        if (!GetConsoleScreenBufferInfo(output, out info)) return "";
        int width = Math.Max(1, info.srWindow.Right - info.srWindow.Left + 1);
        StringBuilder all = new StringBuilder(width * Math.Max(1, info.srWindow.Bottom - info.srWindow.Top + 1));
        for (short y = info.srWindow.Top; y <= info.srWindow.Bottom; y++)
        {
            COORD origin = new COORD();
            origin.X = info.srWindow.Left;
            origin.Y = y;
            StringBuilder line = new StringBuilder(width + 1);
            uint read;
            if (ReadConsoleOutputCharacterW(output, line, (uint)width, origin, out read))
            {
                line.Length = (int)read;
                all.Append(line.ToString());
                all.Append('\n');
            }
        }
        return all.ToString();
    }

    public static int GetVisibleWindowHeight()
    {
        CONSOLE_SCREEN_BUFFER_INFO info;
        if (!GetConsoleScreenBufferInfo(GetStdHandle(STD_OUTPUT_HANDLE), out info)) return 0;
        return Math.Max(0, info.srWindow.Bottom - info.srWindow.Top + 1);
    }

    public static bool SendCtrlC()
    {
        INPUT_RECORD down = new INPUT_RECORD();
        down.EventType = KEY_EVENT;
        down.KeyEvent.bKeyDown = true;
        down.KeyEvent.wRepeatCount = 1;
        down.KeyEvent.wVirtualKeyCode = 0x43;
        down.KeyEvent.UnicodeChar = (char)3;
        down.KeyEvent.dwControlKeyState = LEFT_CTRL_PRESSED;
        INPUT_RECORD up = down;
        up.KeyEvent.bKeyDown = false;
        uint written;
        return WriteConsoleInputW(GetStdHandle(STD_INPUT_HANDLE), new INPUT_RECORD[] { down, up }, 2, out written) && written == 2;
    }

    public static bool SendEnter()
    {
        INPUT_RECORD down = new INPUT_RECORD();
        down.EventType = KEY_EVENT;
        down.KeyEvent.bKeyDown = true;
        down.KeyEvent.wRepeatCount = 1;
        down.KeyEvent.wVirtualKeyCode = 13;
        down.KeyEvent.UnicodeChar = (char)13;
        INPUT_RECORD up = down;
        up.KeyEvent.bKeyDown = false;
        uint written;
        return WriteConsoleInputW(GetStdHandle(STD_INPUT_HANDLE), new INPUT_RECORD[] { down, up }, 2, out written) && written == 2;
    }
}
"@
}

function Find-OriginalCodex {
  if ($CodexPath -and (Test-Path $CodexPath)) { return (Resolve-Path $CodexPath).ProviderPath }
  $candidates = @(
    (Join-Path $env:APPDATA "npm\codex.cmd"),
    (Join-Path $env:LOCALAPPDATA "Programs\codex\codex.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return (Resolve-Path $candidate).ProviderPath }
  }
  throw "Original Codex command was not found. Pass -CodexPath."
}

function Save-Report($Report) {
  $parent = Split-Path -Parent $ReportPath
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $Report | ConvertTo-Json -Depth 8 | Set-Content -Path $ReportPath -Encoding UTF8
}

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $ReportPath) { $ReportPath = Join-Path $root "codex-compositor-e2e-report.json" }
$report = [ordered]@{
  ok = $false
  startedAt = (Get-Date).ToUniversalTime().ToString("o")
  completedAt = $null
  root = $root
  node = $null
  codex = $null
  debugLog = $null
  screenPath = $null
  checks = [ordered]@{}
  samples = 0
  maxBannerCopies = 0
  maxStatusCopies = 0
  maxReadyCopies = 0
  failure = $null
}

try {
  if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
    throw "Run this E2E in a native interactive Windows console."
  }
  Add-E2EConsoleType
  $nodeCommand = Get-Command node -ErrorAction Stop
  $node = $nodeCommand.Source
  $codex = Find-OriginalCodex
  $runner = (Resolve-Path (Join-Path $root "bin\ai-battery-run-win.js")).ProviderPath
  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ai-battery-codex-e2e-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tempDir | Out-Null
  $statusScript = Join-Path $tempDir "status.mjs"
  $debugLog = Join-Path $tempDir "debug.log"
  $screenPath = Join-Path $tempDir "ready-screen.txt"
  Set-Content -Path $statusScript -Encoding UTF8 -Value 'console.log("AI_BATTERY_CODEX_E2E_STATUS Codex 88% | Claude 77%");'

  $report.node = $node
  $report.codex = $codex
  $report.debugLog = $debugLog
  $report.screenPath = $screenPath

  $prompt = 'Do not use tools. Treat & | %PATH% !AI_BATTERY! as literal prompt text, not shell syntax. Write 50 short numbered lines. On the final line concatenate CODEX, _COMPOSITOR_, and READY with no spaces.'
  $runnerArgs = @(
    $runner,
    "--layout", "composite",
    "--interval", "0.5",
    "--provider", "all",
    "--",
    $codex,
    "-C", $tempDir,
    $prompt
  )
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = Join-WindowsArgs $runnerArgs
  $psi.WorkingDirectory = $tempDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $false
  $psi.RedirectStandardInput = $false
  $psi.RedirectStandardOutput = $false
  $psi.RedirectStandardError = $false
  $psi.EnvironmentVariables["AI_BATTERY_BIN"] = $statusScript
  $psi.EnvironmentVariables["AI_BATTERY_DEBUG_LOG"] = $debugLog
  $psi.EnvironmentVariables["AI_BATTERY_ROWPTY_CONPTY"] = "auto"

  Write-Host "[codex compositor e2e] Launching real Codex. Do not type until it finishes..."
  $process = [Diagnostics.Process]::Start($psi)
  if (-not $process) { throw "Failed to start the compositor runner." }

  $readyMarker = "CODEX_COMPOSITOR_READY"
  $statusMarker = "AI_BATTERY_CODEX_E2E_STATUS"
  $bestScreen = ""
  $readySeen = $false
  $statusSeen = $false
  $resizeAttempted = $false
  $resizeApplied = $false
  $trustAccepted = $false
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline -and -not $process.HasExited) {
    Start-Sleep -Milliseconds 100
    $screen = [AiBatteryCodexE2EConsole]::ReadVisibleWindow()
    $bestScreen = $screen
    $report.samples += 1
    $bannerCopies = ([regex]::Matches($screen, [regex]::Escape("OpenAI Codex"))).Count
    $statusCopies = ([regex]::Matches($screen, [regex]::Escape($statusMarker))).Count
    $readyCopies = ([regex]::Matches($screen, [regex]::Escape($readyMarker))).Count
    $report.maxBannerCopies = [Math]::Max($report.maxBannerCopies, $bannerCopies)
    $report.maxStatusCopies = [Math]::Max($report.maxStatusCopies, $statusCopies)
    $report.maxReadyCopies = [Math]::Max($report.maxReadyCopies, $readyCopies)
    if ($statusCopies -gt 0) { $statusSeen = $true }
    if (-not $trustAccepted -and $screen.Contains("Do you trust the contents of this directory?")) {
      [AiBatteryCodexE2EConsole]::SendEnter() | Out-Null
      $trustAccepted = $true
    }
    if ($readyCopies -gt 0) {
      $readySeen = $true
      break
    }
    if (-not $resizeAttempted -and $report.samples -ge 20) {
      $resizeAttempted = $true
      $originalHeight = 0
      try {
        $originalHeight = [Console]::WindowHeight
        if ($originalHeight -gt 12) {
          $visibleHeightBefore = [AiBatteryCodexE2EConsole]::GetVisibleWindowHeight()
          [Console]::WindowHeight = $originalHeight - 1
          Start-Sleep -Milliseconds 800
          $visibleHeightAfter = [AiBatteryCodexE2EConsole]::GetVisibleWindowHeight()
          $resizeApplied = ($visibleHeightAfter -gt 0 -and $visibleHeightAfter -ne $visibleHeightBefore)
        }
      } catch {
      } finally {
        if ($originalHeight -gt 0) {
          try { [Console]::WindowHeight = $originalHeight } catch {}
        }
      }
    }
  }

  if ($bestScreen) { Set-Content -Path $screenPath -Value $bestScreen -Encoding UTF8 }
  $report.checks["statusVisible"] = [ordered]@{ passed = $statusSeen; details = $statusMarker }
  $report.checks["trustPromptHandled"] = [ordered]@{ passed = $trustAccepted; details = "temporary E2E workspace" }
  $report.checks["responseVisible"] = [ordered]@{ passed = $readySeen; details = $readyMarker }
  $report.checks["singleStatusRow"] = [ordered]@{ passed = ($report.maxStatusCopies -le 1); details = $report.maxStatusCopies }
  $report.checks["singleResponseCopy"] = [ordered]@{ passed = ($report.maxReadyCopies -le 1); details = $report.maxReadyCopies }
  $report.checks["noBannerGhosts"] = [ordered]@{ passed = ($report.maxBannerCopies -le 1); details = $report.maxBannerCopies }

  [AiBatteryCodexE2EConsole]::SendCtrlC() | Out-Null
  Start-Sleep -Milliseconds 400
  if (-not $process.HasExited) { [AiBatteryCodexE2EConsole]::SendCtrlC() | Out-Null }
  if (-not $process.WaitForExit(5000)) {
    & taskkill.exe /PID $process.Id /T /F | Out-Null
    $process.WaitForExit()
  }

  $debugText = if (Test-Path $debugLog) { Get-Content -Path $debugLog -Raw } else { "" }
  $compositorStarted = $debugText.Contains('"event":"compositor:start"')
  $resizeObserved = $debugText.Contains('"event":"compositor:resize"')
  $fallbackAbsent = -not ($debugText.Contains('"event":"rowpty:start"') -or $debugText.Contains('"event":"overlay:start"') -or $debugText.Contains('"event":"conpty:start"'))
  $npmShimBypassed = $debugText.Contains('node_modules\\@openai\\codex\\bin\\codex.js') -and -not $debugText.Contains('"command":{"file":"cmd.exe"')
  $report.checks["compositorStarted"] = [ordered]@{ passed = $compositorStarted; details = $debugLog }
  $report.checks["resizeObserved"] = [ordered]@{
    passed = $resizeObserved
    skipped = (-not $resizeApplied -and -not $resizeObserved)
    details = "attempted=$resizeAttempted, applied=$resizeApplied, observed=$resizeObserved"
  }
  $report.checks["noFallback"] = [ordered]@{ passed = $fallbackAbsent; details = $debugLog }
  $report.checks["noCmdArgReparse"] = [ordered]@{ passed = $npmShimBypassed; details = "npm shim resolved to direct JS entrypoint" }

  $failed = @($report.checks.GetEnumerator() | Where-Object {
    $check = $_.Value
    (-not [bool]$check["passed"]) -and
      (-not ($check.Contains("skipped") -and [bool]$check["skipped"]))
  })
  if ($failed.Count -gt 0) {
    throw ("Failed checks: " + (($failed | ForEach-Object { $_.Key }) -join ", "))
  }
  $report.ok = $true
  Write-Host "[codex compositor e2e] PASS: real Codex response and status row rendered once with no ghost frames." -ForegroundColor Green
} catch {
  $report.failure = $_.Exception.Message
  Write-Host "[codex compositor e2e] FAIL: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  $report.completedAt = (Get-Date).ToUniversalTime().ToString("o")
  Save-Report $report
  Write-Host "[codex compositor e2e] Report: $ReportPath"
}

exit $(if ($report.ok) { 0 } else { 1 })
