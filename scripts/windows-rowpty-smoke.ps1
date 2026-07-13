param(
  [int]$TimeoutSeconds = 12,
  [string]$ReportPath = "",
  [switch]$KeepTemp
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$script:SmokeFailed = $false
$script:SmokeReport = [ordered]@{
  ok = $false
  overallPassed = $false
  startedAt = (Get-Date).ToUniversalTime().ToString("o")
  completedAt = $null
  finishedAt = $null
  failure = $null
  root = $null
  node = $null
  tempDir = $null
  rowptyExe = $null
  debugLog = $null
  install = $null
  processExitCode = $null
  checks = [ordered]@{}
  cases = @()
  debugEvents = @()
}

function Set-Check($Name, $Passed, $Details = $null) {
  $script:SmokeReport.checks[$Name] = [ordered]@{
    passed = [bool]$Passed
    details = $Details
  }
}

function Read-DebugEvents($DebugLogPath) {
  if (-not $DebugLogPath -or -not (Test-Path $DebugLogPath)) {
    return @()
  }
  $events = @()
  foreach ($line in Get-Content -Path $DebugLogPath) {
    try {
      $events += ($line | ConvertFrom-Json)
    } catch {
    }
  }
  return $events
}

function Import-DebugEvents($DebugLogPath) {
  $script:SmokeReport.debugEvents += @(Read-DebugEvents $DebugLogPath)
}

function New-CaseResult($Name, $DebugLogPath) {
  return [ordered]@{
    name = $Name
    ok = $false
    debugLog = $DebugLogPath
    runnerArgs = @()
    argumentLine = $null
    processExitCode = $null
    checks = [ordered]@{}
    debugEvents = @()
  }
}

function Set-CaseCheck($CaseResult, $Name, $Passed, $Details = $null) {
  $CaseResult.checks[$Name] = [ordered]@{
    passed = [bool]$Passed
    details = $Details
  }
}

function Write-SmokeReport {
  if (-not $ReportPath) {
    return
  }
  $finishedAt = (Get-Date).ToUniversalTime().ToString("o")
  $script:SmokeReport.overallPassed = [bool]$script:SmokeReport.ok
  $script:SmokeReport.completedAt = $finishedAt
  $script:SmokeReport.finishedAt = $finishedAt
  if ($script:SmokeReport.debugLog) {
    Import-DebugEvents $script:SmokeReport.debugLog
  }
  $parent = Split-Path -Parent $ReportPath
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $script:SmokeReport | ConvertTo-Json -Depth 8 | Set-Content -Path $ReportPath -Encoding UTF8
}

function Write-Step($Message) {
  Write-Host "[ai-battery smoke] $Message"
}

function Fail($Message) {
  $script:SmokeFailed = $true
  $script:SmokeReport.ok = $false
  $script:SmokeReport.failure = $Message
  Write-SmokeReport
  Write-Host "[ai-battery smoke] FAIL: $Message" -ForegroundColor Red
  if ($ReportPath) {
    Write-Host "[ai-battery smoke] Report: $ReportPath"
  }
  exit 1
}

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

function Join-WindowsArgs {
  param([object[]]$Values)
  return (($Values | ForEach-Object { Quote-WindowsArg $_ }) -join " ")
}

function ConvertTo-FileUrl($Path) {
  $resolved = (Resolve-Path $Path).ProviderPath
  return ([System.Uri]$resolved).AbsoluteUri
}

function Add-ConsoleReaderType {
  if ("AiBatteryConsoleSmoke" -as [type]) {
    return
  }

  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AiBatteryConsoleSmoke
{
    private const int STD_OUTPUT_HANDLE = -11;

    [StructLayout(LayoutKind.Sequential)]
    public struct COORD
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SMALL_RECT
    {
        public short Left;
        public short Top;
        public short Right;
        public short Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CONSOLE_SCREEN_BUFFER_INFO
    {
        public COORD dwSize;
        public COORD dwCursorPosition;
        public short wAttributes;
        public SMALL_RECT srWindow;
        public COORD dwMaximumWindowSize;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetConsoleScreenBufferInfo(IntPtr hConsoleOutput, out CONSOLE_SCREEN_BUFFER_INFO lpConsoleScreenBufferInfo);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ReadConsoleOutputCharacterW(IntPtr hConsoleOutput, StringBuilder lpCharacter, uint nLength, COORD dwReadCoord, out uint lpNumberOfCharsRead);

    public static string ReadAll()
    {
        IntPtr handle = GetStdHandle(STD_OUTPUT_HANDLE);
        CONSOLE_SCREEN_BUFFER_INFO info;
        if (!GetConsoleScreenBufferInfo(handle, out info))
        {
            return "";
        }

        int width = Math.Max(1, (int)info.dwSize.X);
        int height = Math.Max(1, (int)info.dwSize.Y);
        StringBuilder all = new StringBuilder(width * Math.Min(height, 2000));
        for (short y = 0; y < height; y++)
        {
            StringBuilder line = new StringBuilder(width);
            COORD origin = new COORD();
            origin.X = 0;
            origin.Y = y;
            uint read;
            if (ReadConsoleOutputCharacterW(handle, line, (uint)width, origin, out read))
            {
                all.Append(line.ToString());
                all.Append('\n');
            }
        }
        return all.ToString();
    }
}
"@
}

function Get-ConsoleText {
  return [AiBatteryConsoleSmoke]::ReadAll()
}

function Find-LastLineIndex($Text, $Marker) {
  $lines = ([string]$Text) -split "`n"
  for ($i = $lines.Length - 1; $i -ge 0; $i -= 1) {
    if ($lines[$i].Contains($Marker)) {
      return $i
    }
  }
  return -1
}

function Ensure-ConsoleScrollback {
  try {
    $targetHeight = [Math]::Max([Console]::BufferHeight, [Console]::WindowHeight + 200)
    if ([Console]::BufferHeight -lt $targetHeight) {
      [Console]::BufferHeight = $targetHeight
    }
    Set-Check "consoleScrollbackBuffer" $true "windowHeight=$([Console]::WindowHeight), bufferHeight=$([Console]::BufferHeight)"
  } catch {
    Set-Check "consoleScrollbackBuffer" $false $_.Exception.Message
  }
}

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $ReportPath) {
  $ReportPath = Join-Path $root "rowpty-smoke-report.json"
}
$script:SmokeReport.root = $root

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  Set-Check "nativeWindows" $false "platform=$([System.Environment]::OSVersion.Platform)"
  Fail "This smoke test must run in native Windows cmd/PowerShell/Windows Terminal."
}
Set-Check "nativeWindows" $true ([System.Environment]::OSVersion.VersionString)

if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
  Set-Check "interactiveConsole" $false "stdinRedirected=$([Console]::IsInputRedirected), stdoutRedirected=$([Console]::IsOutputRedirected)"
  Fail "Run this in an interactive terminal; stdin/stdout must not be redirected."
}
Set-Check "interactiveConsole" $true "stdin/stdout are real console handles"

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Set-Check "nodeOnPath" $false $null
  Fail "node was not found on PATH."
}
$node = $nodeCommand.Source
Set-Check "nodeOnPath" $true $node

$runner = (Resolve-Path (Join-Path $root "bin/ai-battery-run-win.js")).ProviderPath
$aiBatteryModule = (Resolve-Path (Join-Path $root "bin/ai-battery.js")).ProviderPath
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ai-battery-rowpty-smoke-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDir | Out-Null
$script:SmokeReport.node = $node
$script:SmokeReport.tempDir = $tempDir

try {
  Add-ConsoleReaderType
  Ensure-ConsoleScrollback

  $installScript = Join-Path $tempDir "install-rowpty.mjs"
  $moduleUrl = ConvertTo-FileUrl $aiBatteryModule

  Set-Content -Path $installScript -Encoding UTF8 -Value @"
import { installRowPtyHost } from "$moduleUrl";
const result = installRowPtyHost();
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
"@

  function Write-StatusScript($Path, $Marker) {
    Set-Content -Path $Path -Encoding UTF8 -Value "console.log(`"$Marker 99%`");"
  }

  function Write-NodeChildScript($Path, $Prefix) {
    Set-Content -Path $Path -Encoding UTF8 -Value @"
const prefix = "$Prefix";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
process.stdout.write(prefix + "_CHILD_START\n");
for (let i = 0; i < 6; i += 1) {
  process.stdout.write(prefix + "_LINE_" + i + "\n");
  await sleep(80);
}
process.stdout.write("\x1b[?1049h" + prefix + "_ALT_SCREEN\n\x1b[?1049l");
process.stdout.write("\x1b[3J" + prefix + "_AFTER_3J\n");
await sleep(700);
// Extra blank line: absolute rows pass through to the host viewport with the
// bundled ConPTY (real-terminal semantics), so the bottom-row prompt jump
// below would otherwise land on the delayed-output line and overwrite it.
process.stdout.write(prefix + "_DELAYED_OUTPUT\n\n");
process.stdout.write("\x1b[999;1H" + prefix + "_PROMPT_AREA> ");
await sleep(4500);
process.stdout.write(prefix + "_CHILD_END\n");
"@
  }

  function Write-CmdChildWrapper($Path, $NodePath, $ScriptPath) {
    $content = @(
      "@echo off",
      (Join-WindowsArgs -Values @($NodePath, $ScriptPath)),
      "exit /b %ERRORLEVEL%"
    ) -join "`r`n"
    Set-Content -Path $Path -Encoding ASCII -Value $content
  }

  function Write-PowerShellChildScript($Path, $Prefix) {
    $content = @'
$prefix = "__PREFIX__"
$esc = [char]27
[Console]::Out.Write($prefix + "_CHILD_START`n")
for ($i = 0; $i -lt 6; $i += 1) {
  [Console]::Out.Write($prefix + "_LINE_" + $i + "`n")
  Start-Sleep -Milliseconds 80
}
[Console]::Out.Write("$esc[?1049h" + $prefix + "_ALT_SCREEN`n" + "$esc[?1049l")
[Console]::Out.Write("$esc[3J" + $prefix + "_AFTER_3J`n")
Start-Sleep -Milliseconds 700
# Extra blank line: absolute rows pass through to the host viewport with the
# bundled ConPTY (real-terminal semantics), so the bottom-row prompt jump
# below would otherwise land on the delayed-output line and overwrite it.
[Console]::Out.Write($prefix + "_DELAYED_OUTPUT`n`n")
[Console]::Out.Write("$esc[999;1H" + $prefix + "_PROMPT_AREA> ")
Start-Sleep -Milliseconds 4500
[Console]::Out.Write($prefix + "_CHILD_END`n")
'@
    Set-Content -Path $Path -Encoding UTF8 -Value $content.Replace("__PREFIX__", $Prefix)
  }

  function Write-CodexHistoryChildScript($Path) {
    # Mirrors the VT pattern captured from the real Codex TUI (0.142.x):
    # synchronized updates plus top-anchored DECSTBM scroll regions that push
    # history lines into scrollback above a bottom-pinned viewport. The OS
    # in-box ConPTY re-renders this pattern as full viewport repaints, losing
    # or duplicating history lines; the bundled WT conpty.dll passes it through.
    Set-Content -Path $Path -Encoding UTF8 -Value @'
const esc = "\x1b";
const out = process.stdout;
const rows = out.rows || 24;
const VIEWPORT_H = 5;
const historyBottom = Math.max(2, rows - VIEWPORT_H);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (text) => out.write(text);
const HIST_TOTAL = 30;

function insertHistoryLine(text) {
  write(`${esc}[?2026h`);
  write(`${esc}[1;${historyBottom}r`);
  write(`${esc}[${historyBottom};1H`);
  write(`\r\n${text}${esc}[K`);
  write(`${esc}[r`);
  write(`${esc}[?2026l`);
}

function redrawViewport(label) {
  write(`${esc}[?2026h`);
  const top = rows - VIEWPORT_H + 1;
  write(`${esc}[${top};1H${esc}[K`);
  write(`${esc}[${top + 1};1H> composer${esc}[K`);
  write(`${esc}[${top + 2};1H${label}${esc}[K`);
  write(`${esc}[${top + 3};1H${esc}[K`);
  write(`${esc}[?2026l`);
}

write(`${esc}[?25l${esc}[?2026h${esc}[1;1H${esc}[J${esc}[1;${rows}r${esc}[1;1H`);
write(`${esc}M`.repeat(4));
write(`${esc}[r${esc}[1;5r${esc}[1;1H`);
write(`\r\nAI_BATTERY_CODEX_BANNER OpenAI Codex (smoke renderer)${esc}[K`);
write(`\r\nmodel: smoke${esc}[K`);
write(`${esc}[r`);
redrawViewport("AI_BATTERY_TRANSIENT_FRAME_0_MUST_NOT_REMAIN");
write(`${esc}[?2026l`);
await sleep(200);

for (let i = 0; i < HIST_TOTAL; i += 1) {
  insertHistoryLine(`AI_BATTERY_HIST_LINE_${String(i).padStart(3, "0")}`);
  if (i % 5 === 0) redrawViewport(`AI_BATTERY_TRANSIENT_FRAME_${i + 1}_MUST_NOT_REMAIN`);
  await sleep(60);
}

redrawViewport("AI_BATTERY_FINAL_RESPONSE_DONE");
write(`${esc}[?25h`);
await sleep(1800);
'@
  }

  function Count-TextOccurrences($Text, $Pattern) {
    return ([regex]::Matches([string]$Text, [regex]::Escape($Pattern))).Count
  }

  Write-Step "Compiling/installing rowpty host if needed..."
  $installOutput = & $node $installScript 2>&1
  if ($LASTEXITCODE -ne 0) {
    Set-Check "rowptyInstall" $false (($installOutput | Out-String).Trim())
    Fail ("rowpty install failed: " + (($installOutput | Out-String).Trim()))
  }

  $installJson = ($installOutput | Select-Object -Last 1 | ConvertFrom-Json)
  $script:SmokeReport.install = $installJson
  $rowptyExe = [string]$installJson.exePath
  if (-not (Test-Path $rowptyExe)) {
    Set-Check "rowptyInstall" $false "missing exePath=$rowptyExe"
    Fail "rowpty.exe was not installed at $rowptyExe"
  }
  $script:SmokeReport.rowptyExe = $rowptyExe
  Set-Check "rowptyInstall" $true "compiled=$($installJson.compiled), conpty=$($installJson.conpty)"
  Write-Step "Using rowpty: $rowptyExe"

  function Invoke-RowPtySmokeCase($Name, [string[]]$ChildArgs) {
    $upperName = $Name.ToUpperInvariant()
    $prefix = "AI_BATTERY_SMOKE_$upperName"
    $statusMarker = "${prefix}_STATUS"
    $delayedMarker = "${prefix}_DELAYED_OUTPUT"
    $promptMarker = "${prefix}_PROMPT_AREA"
    $endMarker = "${prefix}_CHILD_END"
    $scrollbackSentinel = "${prefix}_SCROLLBACK_" + [System.Guid]::NewGuid().ToString("N")
    $statusScript = Join-Path $tempDir "status-$Name.mjs"
    $debugLog = Join-Path $tempDir "debug-$Name.log"
    $caseResult = New-CaseResult $Name $debugLog
    $script:SmokeReport.cases += $caseResult

    Write-StatusScript $statusScript $statusMarker

    Write-Host $scrollbackSentinel
    for ($i = 0; $i -lt ([Console]::WindowHeight + 20); $i += 1) {
      Write-Host ("{0}_PREFILL_{1:D3}" -f $prefix, $i)
    }

    $beforeText = Get-ConsoleText
    if (-not $beforeText.Contains($scrollbackSentinel)) {
      Set-CaseCheck $caseResult "prefillScrollbackSentinel" $false $scrollbackSentinel
      Fail ("${Name}: console buffer did not retain the prefill sentinel, so scrollback cannot be validated.")
    }
    Set-CaseCheck $caseResult "prefillScrollbackSentinel" $true $scrollbackSentinel

    Write-Step "Launching ai-battery-run-win through $Name. Do not type until this case finishes..."
    $runnerArgs = @(
      $runner,
      "--interval", "0.5",
      "--bar-width", "4",
      "--provider", "all",
      "--"
    ) + $ChildArgs
    $argumentLine = Join-WindowsArgs -Values $runnerArgs
    $caseResult.runnerArgs = $runnerArgs
    $caseResult.argumentLine = $argumentLine

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $psi.Arguments = $argumentLine
    $psi.WorkingDirectory = $root
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $false
    $psi.RedirectStandardInput = $false
    $psi.RedirectStandardOutput = $false
    $psi.RedirectStandardError = $false
    $psi.EnvironmentVariables["AI_BATTERY_BIN"] = $statusScript
    $psi.EnvironmentVariables["AI_BATTERY_ROWPTY"] = $rowptyExe
    $psi.EnvironmentVariables["AI_BATTERY_ROWPTY_PRESERVE_SCROLLBACK"] = "1"
    $psi.EnvironmentVariables["AI_BATTERY_WIN_LAYOUT"] = "tui"
    $psi.EnvironmentVariables["AI_BATTERY_DEBUG_LOG"] = $debugLog

    $process = [System.Diagnostics.Process]::Start($psi)
    if (-not $process) {
      Fail ("${Name}: failed to start ai-battery-run-win.")
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $delayedSeenBeforeExit = $false
    $statusSeenBeforeExit = $false
    $promptSeenBeforeExit = $false
    $statusBelowPromptSeen = $false
    $promptLineIndex = -1
    $statusLineIndex = -1
    while ([DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 100
      $text = Get-ConsoleText
      if (-not $process.HasExited -and $text.Contains($delayedMarker)) {
        $delayedSeenBeforeExit = $true
      }
      if (-not $process.HasExited -and $text.Contains($statusMarker)) {
        $statusSeenBeforeExit = $true
      }
      if (-not $process.HasExited -and $text.Contains($promptMarker)) {
        $promptSeenBeforeExit = $true
        $candidatePromptLine = Find-LastLineIndex $text $promptMarker
        $candidateStatusLine = Find-LastLineIndex $text $statusMarker
        if ($candidatePromptLine -ge 0 -and $candidateStatusLine -gt $candidatePromptLine) {
          $promptLineIndex = $candidatePromptLine
          $statusLineIndex = $candidateStatusLine
          $statusBelowPromptSeen = $true
        }
      }
      if ($delayedSeenBeforeExit -and $statusSeenBeforeExit -and $promptSeenBeforeExit -and $statusBelowPromptSeen) {
        break
      }
      if ($process.HasExited -and -not $delayedSeenBeforeExit) {
        break
      }
    }

    if (-not $process.WaitForExit([Math]::Max(1000, $TimeoutSeconds * 1000))) {
      try { $process.Kill() } catch {}
      Set-CaseCheck $caseResult "processExited" $false "timeoutSeconds=$TimeoutSeconds"
      Fail ("${Name}: ai-battery-run-win did not exit within $TimeoutSeconds seconds.")
    }
    Set-CaseCheck $caseResult "processExited" $true "exitCode=$($process.ExitCode)"

    $afterText = Get-ConsoleText
    $debugText = if (Test-Path $debugLog) { Get-Content -Path $debugLog -Raw } else { "" }
    $caseResult.processExitCode = $process.ExitCode
    $caseResult.debugEvents = @(Read-DebugEvents $debugLog)
    Import-DebugEvents $debugLog

    if ($process.ExitCode -ne 0) {
      Set-CaseCheck $caseResult "processExitCode" $false $process.ExitCode
      Fail ("${Name}: ai-battery-run-win exited with code $($process.ExitCode).")
    }
    Set-CaseCheck $caseResult "processExitCode" $true $process.ExitCode
    if (-not $debugText.Contains('"event":"rowpty:start"')) {
      Set-CaseCheck $caseResult "rowptyStarted" $false $debugLog
      Fail ("${Name}: debug log does not show rowpty:start; rowpty path was not exercised.")
    }
    Set-CaseCheck $caseResult "rowptyStarted" $true $debugLog
    if ($debugText.Contains('"event":"overlay:start"') -or $debugText.Contains('"event":"conpty:start"')) {
      Set-CaseCheck $caseResult "noFallback" $false $debugLog
      Fail ("${Name}: runner fell back to overlay/node-pty instead of rowpty.")
    }
    Set-CaseCheck $caseResult "noFallback" $true $debugLog
    if (-not $delayedSeenBeforeExit) {
      Set-CaseCheck $caseResult "delayedOutputVisibleBeforeExit" $false $delayedMarker
      Fail ("${Name}: delayed child output was not visible while the child was still running.")
    }
    Set-CaseCheck $caseResult "delayedOutputVisibleBeforeExit" $true $delayedMarker
    if (-not $statusSeenBeforeExit) {
      Set-CaseCheck $caseResult "statusVisibleBeforeExit" $false $statusMarker
      Fail ("${Name}: status row output was not visible while rowpty was running.")
    }
    Set-CaseCheck $caseResult "statusVisibleBeforeExit" $true $statusMarker
    if (-not $promptSeenBeforeExit) {
      Set-CaseCheck $caseResult "promptVisibleBeforeExit" $false $promptMarker
      Fail ("${Name}: prompt marker was not visible while rowpty was running.")
    }
    Set-CaseCheck $caseResult "promptVisibleBeforeExit" $true $promptMarker
    if (-not $statusBelowPromptSeen) {
      Set-CaseCheck $caseResult "statusBelowPrompt" $false "promptLine=$promptLineIndex, statusLine=$statusLineIndex"
      Fail ("${Name}: status row did not remain below the prompt marker.")
    }
    Set-CaseCheck $caseResult "statusBelowPrompt" $true "promptLine=$promptLineIndex, statusLine=$statusLineIndex"
    if (-not $afterText.Contains($endMarker)) {
      Set-CaseCheck $caseResult "childEndMarker" $false $endMarker
      Fail ("${Name}: child end marker is missing from the console buffer.")
    }
    Set-CaseCheck $caseResult "childEndMarker" $true $endMarker
    if (-not $afterText.Contains($scrollbackSentinel)) {
      Set-CaseCheck $caseResult "scrollbackPreservedAfter3J" $false $scrollbackSentinel
      Fail ("${Name}: scrollback sentinel disappeared after the child emitted CSI 3J.")
    }
    Set-CaseCheck $caseResult "scrollbackPreservedAfter3J" $true $scrollbackSentinel
    $caseResult.ok = $true
  }

  function Invoke-CodexHistorySmokeCase([string[]]$ChildArgs) {
    $name = "codex-history"
    $statusMarker = "AI_BATTERY_CODEX_HISTORY_STATUS"
    $finalMarker = "AI_BATTERY_FINAL_RESPONSE_DONE"
    $debugLog = Join-Path $tempDir "debug-$name.log"
    $statusScript = Join-Path $tempDir "status-$name.mjs"
    $caseResult = New-CaseResult $name $debugLog
    $script:SmokeReport.cases += $caseResult

    Write-StatusScript $statusScript $statusMarker

    Write-Step "Launching Codex-like history renderer. Do not type until this case finishes..."
    $runnerArgs = @(
      $runner,
      "--interval", "0.5",
      "--bar-width", "4",
      "--provider", "all",
      "--"
    ) + $ChildArgs
    $argumentLine = Join-WindowsArgs -Values $runnerArgs
    $caseResult.runnerArgs = $runnerArgs
    $caseResult.argumentLine = $argumentLine

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $psi.Arguments = $argumentLine
    $psi.WorkingDirectory = $root
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $false
    $psi.RedirectStandardInput = $false
    $psi.RedirectStandardOutput = $false
    $psi.RedirectStandardError = $false
    $psi.EnvironmentVariables["AI_BATTERY_BIN"] = $statusScript
    $psi.EnvironmentVariables["AI_BATTERY_ROWPTY"] = $rowptyExe
    $psi.EnvironmentVariables["AI_BATTERY_ROWPTY_PRESERVE_SCROLLBACK"] = "1"
    $psi.EnvironmentVariables["AI_BATTERY_WIN_LAYOUT"] = "tui"
    $psi.EnvironmentVariables["AI_BATTERY_DEBUG_LOG"] = $debugLog

    $process = [System.Diagnostics.Process]::Start($psi)
    if (-not $process) {
      Fail "${name}: failed to start ai-battery-run-win."
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $finalSeenBeforeExit = $false
    $statusSeenBeforeExit = $false
    while ([DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 100
      $text = Get-ConsoleText
      if (-not $process.HasExited -and $text.Contains($finalMarker)) {
        $finalSeenBeforeExit = $true
      }
      if (-not $process.HasExited -and $text.Contains($statusMarker)) {
        $statusSeenBeforeExit = $true
      }
      if ($finalSeenBeforeExit -and $statusSeenBeforeExit) {
        break
      }
      if ($process.HasExited -and -not $finalSeenBeforeExit) {
        break
      }
    }

    if (-not $process.WaitForExit([Math]::Max(1000, $TimeoutSeconds * 1000))) {
      try { $process.Kill() } catch {}
      Set-CaseCheck $caseResult "processExited" $false "timeoutSeconds=$TimeoutSeconds"
      Fail "${name}: ai-battery-run-win did not exit within $TimeoutSeconds seconds."
    }
    Set-CaseCheck $caseResult "processExited" $true "exitCode=$($process.ExitCode)"

    $afterText = Get-ConsoleText
    $debugText = if (Test-Path $debugLog) { Get-Content -Path $debugLog -Raw } else { "" }
    $caseResult.processExitCode = $process.ExitCode
    $caseResult.debugEvents = @(Read-DebugEvents $debugLog)
    Import-DebugEvents $debugLog

    if ($process.ExitCode -ne 0) {
      Set-CaseCheck $caseResult "processExitCode" $false $process.ExitCode
      Fail "${name}: ai-battery-run-win exited with code $($process.ExitCode)."
    }
    Set-CaseCheck $caseResult "processExitCode" $true $process.ExitCode
    if (-not $debugText.Contains('"event":"rowpty:start"')) {
      Set-CaseCheck $caseResult "rowptyStarted" $false $debugLog
      Fail "${name}: debug log does not show rowpty:start; rowpty path was not exercised."
    }
    Set-CaseCheck $caseResult "rowptyStarted" $true $debugLog
    if ($debugText.Contains('"event":"overlay:start"') -or $debugText.Contains('"event":"conpty:start"')) {
      Set-CaseCheck $caseResult "noFallback" $false $debugLog
      Fail "${name}: runner fell back to overlay/node-pty instead of rowpty."
    }
    Set-CaseCheck $caseResult "noFallback" $true $debugLog
    if (-not $finalSeenBeforeExit -and -not $afterText.Contains($finalMarker)) {
      Set-CaseCheck $caseResult "finalHistoryVisible" $false $finalMarker
      Fail "${name}: final response marker was not visible in the console buffer."
    }
    Set-CaseCheck $caseResult "finalHistoryVisible" $true $finalMarker
    if (-not $statusSeenBeforeExit) {
      Set-CaseCheck $caseResult "statusVisibleBeforeExit" $false $statusMarker
      Fail "${name}: status row was not visible while the Codex-like renderer was running."
    }
    Set-CaseCheck $caseResult "statusVisibleBeforeExit" $true $statusMarker

    $transientCount = ([regex]::Matches($afterText, "AI_BATTERY_TRANSIENT_FRAME_\d+_MUST_NOT_REMAIN")).Count
    $bannerCount = Count-TextOccurrences $afterText "AI_BATTERY_CODEX_BANNER"
    $statusCount = Count-TextOccurrences $afterText $statusMarker
    Set-CaseCheck $caseResult "noTransientFramesInConsoleBuffer" ($transientCount -eq 0) "count=$transientCount"
    if ($transientCount -ne 0) {
      Fail "${name}: transient Codex frame text remained in the console buffer (count=$transientCount)."
    }
    Set-CaseCheck $caseResult "bannerRenderedExactlyOnce" ($bannerCount -eq 1) "count=$bannerCount"
    if ($bannerCount -ne 1) {
      Fail "${name}: the Codex banner appeared $bannerCount times in the console buffer (ghost frames)."
    }

    $histMatches = [regex]::Matches($afterText, "AI_BATTERY_HIST_LINE_(\d{3})")
    $histNumbers = @($histMatches | ForEach-Object { [int]$_.Groups[1].Value })
    $histUnique = @($histNumbers | Sort-Object -Unique)
    $histInOrder = $true
    for ($i = 1; $i -lt $histNumbers.Count; $i += 1) {
      if ($histNumbers[$i] -lt $histNumbers[$i - 1]) { $histInOrder = $false; break }
    }
    Set-CaseCheck $caseResult "historyLinesPreserved" ($histUnique.Count -eq 30) "unique=$($histUnique.Count)/30"
    if ($histUnique.Count -ne 30) {
      Fail "${name}: only $($histUnique.Count)/30 scroll-region history lines survived in the console buffer."
    }
    Set-CaseCheck $caseResult "historyLinesNotDuplicated" ($histNumbers.Count -eq $histUnique.Count) "total=$($histNumbers.Count), unique=$($histUnique.Count)"
    if ($histNumbers.Count -ne $histUnique.Count) {
      Fail "${name}: history lines were duplicated in the console buffer (ghost frames)."
    }
    Set-CaseCheck $caseResult "historyLinesInOrder" $histInOrder "inOrder=$histInOrder"
    if (-not $histInOrder) {
      Fail "${name}: history lines appeared out of order in the console buffer."
    }
    Set-CaseCheck $caseResult "statusDoesNotLeakAfterExit" ($statusCount -eq 0) "count=$statusCount"
    if ($statusCount -ne 0) {
      Fail "${name}: status row text leaked into the console buffer after exit (count=$statusCount)."
    }

    $caseResult.ok = $true
  }

  $cmdChildScript = Join-Path $tempDir "child-cmd.mjs"
  $cmdChildWrapper = Join-Path $tempDir "child-cmd.cmd"
  $powershellChildScript = Join-Path $tempDir "child-powershell.ps1"
  $codexHistoryChildScript = Join-Path $tempDir "child-codex-history.mjs"
  Write-NodeChildScript $cmdChildScript "AI_BATTERY_SMOKE_CMD"
  Write-CmdChildWrapper $cmdChildWrapper $node $cmdChildScript
  Write-PowerShellChildScript $powershellChildScript "AI_BATTERY_SMOKE_POWERSHELL"
  Write-CodexHistoryChildScript $codexHistoryChildScript

  Invoke-RowPtySmokeCase "cmd" @($cmdChildWrapper)
  Invoke-RowPtySmokeCase "powershell" @("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $powershellChildScript)
  Invoke-CodexHistorySmokeCase @($node, $codexHistoryChildScript)

  $script:SmokeReport.ok = $true
  Write-SmokeReport
  Write-Host "[ai-battery smoke] PASS: rowpty output, status paint, scrollback preservation, and Codex-like history rendering look healthy." -ForegroundColor Green
  if ($ReportPath) {
    Write-Host "[ai-battery smoke] Report: $ReportPath"
  }
} catch {
  $script:SmokeFailed = $true
  $script:SmokeReport.ok = $false
  $script:SmokeReport.failure = $_.Exception.Message
  Write-SmokeReport
  Write-Host "[ai-battery smoke] FAIL: $($_.Exception.Message)" -ForegroundColor Red
  if ($ReportPath) {
    Write-Host "[ai-battery smoke] Report: $ReportPath"
  }
  exit 1
} finally {
  if (-not $KeepTemp -and -not $script:SmokeFailed -and (Test-Path $tempDir)) {
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
  } elseif ($KeepTemp -or $script:SmokeFailed) {
    Write-Step "Kept temp directory: $tempDir"
  }
}
