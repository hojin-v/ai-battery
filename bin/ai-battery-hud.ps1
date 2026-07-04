param(
  [int]$Interval = 5,
  [string]$Position = $(if ($env:AI_BATTERY_HUD_POSITION) { $env:AI_BATTERY_HUD_POSITION } elseif ($env:CLAUDEX_BATTERY_HUD_POSITION) { $env:CLAUDEX_BATTERY_HUD_POSITION } else { "saved" }),
  [ValidateSet("tray", "statusline", "floating")]
  [string]$Mode = $(if ($env:AI_BATTERY_HUD_MODE) { $env:AI_BATTERY_HUD_MODE } elseif ($env:CLAUDEX_BATTERY_HUD_MODE) { $env:CLAUDEX_BATTERY_HUD_MODE } else { "floating" }),
  [string]$BatteryCommand = $(if ($env:AI_BATTERY_COMMAND) { $env:AI_BATTERY_COMMAND } elseif ($env:CLAUDEX_BATTERY_COMMAND) { $env:CLAUDEX_BATTERY_COMMAND } else { "ai-battery --json" }),
  [string]$InitialJsonBase64 = "",
  [int]$Width = 282,
  [double]$Opacity = $(if ($env:AI_BATTERY_HUD_OPACITY) { [double]$env:AI_BATTERY_HUD_OPACITY } elseif ($env:CLAUDEX_BATTERY_HUD_OPACITY) { [double]$env:CLAUDEX_BATTERY_HUD_OPACITY } else { 1.0 }),
  [switch]$Locked,
  [switch]$Movable,
  [switch]$ClickThrough,
  [switch]$StopExisting,
  [switch]$UseWsl,
  [switch]$Once,
  [string]$ReadyPath = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

function Stop-ExistingHudProcesses {
  $currentPid = $PID
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.ProcessId -ne $currentPid -and
      $_.Name -match '^(powershell|pwsh)(\.exe)?$' -and
      $_.CommandLine -and
      $_.CommandLine -like "*ai-battery-hud.ps1*" -and
      $_.CommandLine -notlike "*Start-Process*"
    } |
    ForEach-Object {
      try {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
        Wait-Process -Id $_.ProcessId -Timeout 3 -ErrorAction SilentlyContinue
      } catch {
        # The process may already have exited.
      }
    }
}

if ($StopExisting) {
  Stop-ExistingHudProcesses
  if (-not $Once) {
    exit 0
  }
} elseif (-not $Once) {
  Stop-ExistingHudProcesses
}

$script:singleInstanceMutex = $null
if (-not $Once) {
  # A replaced instance we just stopped can hold the mutex handle for a
  # moment after Stop-Process returns; retry briefly before treating the
  # mutex owner as a genuinely running HUD.
  $createdNew = $false
  for ($mutexAttempt = 0; $mutexAttempt -lt 20; $mutexAttempt += 1) {
    $script:singleInstanceMutex = [System.Threading.Mutex]::new($true, "Local\AiBatteryHud", [ref]$createdNew)
    if ($createdNew) { break }
    $script:singleInstanceMutex.Dispose()
    $script:singleInstanceMutex = $null
    Start-Sleep -Milliseconds 150
  }
  if (-not $createdNew) {
    exit 0
  }
}

function Release-SingleInstance {
  if ($script:singleInstanceMutex) {
    try {
      $script:singleInstanceMutex.ReleaseMutex()
    } catch {
      # Already released.
    }
    $script:singleInstanceMutex.Dispose()
    $script:singleInstanceMutex = $null
  }
}

function Get-HudStatePath {
  $root = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "ai-battery"
  } else {
    Join-Path $env:TEMP "ai-battery"
  }
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  return Join-Path $root "hud-position.json"
}

function Get-HudSourceId {
  if ($UseWsl) { return "wsl" }
  return "windows"
}

function Get-HudSnapshotPath {
  $root = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "ai-battery"
  } else {
    Join-Path $env:TEMP "ai-battery"
  }
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  return Join-Path $root "hud-snapshot-$(Get-HudSourceId).json"
}

function Get-LegacyHudStatePath {
  $root = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "claudex-battery"
  } else {
    Join-Path $env:TEMP "claudex-battery"
  }
  return Join-Path $root "hud-position.json"
}

$script:hudAnchorX = "left"
$script:hudAnchorY = "top"
$script:codexRowVisible = $true
$script:claudeRowVisible = $true

function Signal-HudReady {
  if ([string]::IsNullOrWhiteSpace($ReadyPath)) { return }
  try {
    $dir = Split-Path -Parent $ReadyPath
    if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    @{
      Ready = $true
      Pid = $PID
      At = [datetime]::UtcNow.ToString("o")
      Mode = $Mode
    } | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 -Path $ReadyPath
  } catch {
    # Readiness is diagnostic only.
  }
}

function Read-HudPlacement {
  foreach ($path in @((Get-HudStatePath), (Get-LegacyHudStatePath))) {
    try {
      if (-not (Test-Path $path)) { continue }
      $state = Get-Content $path -Raw | ConvertFrom-Json
      if ($null -ne $state.X -and $null -ne $state.Y) {
        return $state
      }
    } catch {
      # Try the next state path.
    }
  }
  return $null
}

function Read-HudPosition {
  $state = Read-HudPlacement
  if (-not $state) { return $null }
  return [System.Drawing.Point]::new([int]$state.X, [int]$state.Y)
}

function Write-HudPosition($Point) {
  try {
    $width = $null
    $height = $null
    if ($form -and -not $form.IsDisposed) {
      $width = [int]$form.Width
      $height = [int]$form.Height
    }
    @{
      X = [int]$Point.X
      Y = [int]$Point.Y
      Width = $width
      Height = $height
    } | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 -Path (Get-HudStatePath)
  } catch {
    # Position persistence is helpful but not required for the HUD to run.
  }
}

function Get-SnapshotAgeSeconds($Snapshot) {
  if (-not $Snapshot -or -not $Snapshot.generatedAt) { return $null }
  try {
    return [math]::Max(0, [int](([datetime]::UtcNow - ([datetime]$Snapshot.generatedAt).ToUniversalTime()).TotalSeconds))
  } catch {
    return $null
  }
}

function Read-HudSnapshot {
  try {
    $path = Get-HudSnapshotPath
    if (-not (Test-Path $path)) { return $null }
    $snapshot = Get-Content $path -Raw | ConvertFrom-Json
    $age = Get-SnapshotAgeSeconds $snapshot
    $maxAge = if ($env:AI_BATTERY_HUD_CACHE_SECONDS) { [int]$env:AI_BATTERY_HUD_CACHE_SECONDS } else { 900 }
    if ($null -ne $age -and $age -le $maxAge) { return $snapshot }
  } catch {
    # Cached data is optional.
  }
  return $null
}

function Read-InitialHudSnapshot {
  if ([string]::IsNullOrWhiteSpace($InitialJsonBase64)) { return $null }
  try {
    $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($InitialJsonBase64))
    if ([string]::IsNullOrWhiteSpace($json)) { return $null }
    return $json | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Write-HudSnapshot($Snapshot) {
  try {
    if (-not $Snapshot) { return }
    $Snapshot | Add-Member -NotePropertyName "hudSource" -NotePropertyValue (Get-HudSourceId) -Force
    $Snapshot | ConvertTo-Json -Depth 20 -Compress | Set-Content -Encoding UTF8 -Path (Get-HudSnapshotPath)
  } catch {
    # The HUD can still run without a warm-start cache.
  }
}

$script:initialHudSnapshot = Read-InitialHudSnapshot

$nativeCode = @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct AiBatteryRect {
  public int Left;
  public int Top;
  public int Right;
  public int Bottom;
}
[StructLayout(LayoutKind.Sequential)]
public struct AiBatteryMonitorInfo {
  public int CbSize;
  public AiBatteryRect Monitor;
  public AiBatteryRect Work;
  public int Flags;
}
public static class AiBatteryNative {
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TRANSPARENT = 0x20;
  public const int WS_EX_TOOLWINDOW = 0x80;
  public const int WS_EX_NOACTIVATE = 0x08000000;
  public const UInt32 MONITOR_DEFAULTTONEAREST = 2;
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public const UInt32 SWP_NOSIZE = 0x0001;
  public const UInt32 SWP_NOMOVE = 0x0002;
  public const UInt32 SWP_NOACTIVATE = 0x0010;
  public const UInt32 SWP_SHOWWINDOW = 0x0040;
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")]
  public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, UInt32 uFlags);
  [DllImport("user32.dll", CharSet=CharSet.Auto)]
  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll", CharSet=CharSet.Auto)]
  public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out AiBatteryRect rect);
  [DllImport("user32.dll")]
  public static extern IntPtr MonitorFromWindow(IntPtr hWnd, UInt32 dwFlags);
  [DllImport("user32.dll")]
  public static extern bool GetMonitorInfo(IntPtr hMonitor, ref AiBatteryMonitorInfo lpmi);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr hIcon);
}
"@
Add-Type -TypeDefinition $nativeCode

function Invoke-AiBatteryJson {
  if ($UseWsl) {
    $output = & wsl.exe bash -lc "$BatteryCommand 2>/dev/null"
  } else {
    $output = Invoke-Expression "$BatteryCommand 2>`$null"
  }
  $text = ($output -join "`n").Trim()
  if (-not $text) { throw "ai-battery produced no output" }
  return $text | ConvertFrom-Json
}

function Get-DurationText([Nullable[int]]$Seconds) {
  if ($null -eq $Seconds) { return "?" }
  if ($Seconds -le 0) { return "now" }
  $minutes = [math]::Floor($Seconds / 60)
  if ($minutes -lt 60) { return "${minutes}m" }
  $hours = [math]::Floor($minutes / 60)
  $restMinutes = $minutes % 60
  if ($hours -lt 48) {
    if ($restMinutes -gt 0) { return "${hours}h${restMinutes}m" }
    return "${hours}h"
  }
  $days = [math]::Floor($hours / 24)
  $restHours = $hours % 24
  if ($restHours -gt 0) { return "${days}d${restHours}h" }
  return "${days}d"
}

function Get-ResetClock($Limit) {
  if (-not $Limit -or -not $Limit.resetsAt) { return "--:--" }
  if ($Limit.resetPassed) { return "--:--" }
  try {
    return ([datetime]$Limit.resetsAt).ToLocalTime().ToString("HH:mm")
  } catch {
    return "--:--"
  }
}

function Get-WindowText($Minutes) {
  if ($Minutes -eq 300) { return "5h" }
  if ($Minutes -eq 10080) { return "7d" }
  if (-not $Minutes) { return "?" }
  if (($Minutes % 1440) -eq 0) { return "$($Minutes / 1440)d" }
  if (($Minutes % 60) -eq 0) { return "$($Minutes / 60)h" }
  return "${Minutes}m"
}

function Get-Bar([Nullable[int]]$Percent, [int]$Width = 10) {
  $unknown = [string][char]0x2500
  $fullBlock = [string][char]0x2588
  $emptyBlock = [string][char]0x2591
  if ($null -eq $Percent) { return $unknown * $Width }
  # Whole cells only, matching bar() in ai-battery.js: partial blocks read as
  # a hole in the bar and render inconsistently across fonts.
  $clamped = [math]::Max(0, [math]::Min(100, $Percent))
  $full = [int][math]::Round(($clamped / 100.0) * $Width)
  if ($clamped -gt 0 -and $full -eq 0) { $full = 1 }
  return ($fullBlock * $full) + ($emptyBlock * ($Width - $full))
}

function Get-BatteryIcon([Nullable[int]]$Percent) {
  return ""
}

function Get-PercentColor([Nullable[int]]$Percent) {
  if ($null -eq $Percent) { return [System.Drawing.Color]::FromArgb(150, 150, 150) }
  if ($Percent -le 20) { return [System.Drawing.Color]::FromArgb(255, 92, 92) }
  if ($Percent -le 40) { return [System.Drawing.Color]::FromArgb(255, 158, 67) }
  return [System.Drawing.Color]::FromArgb(80, 220, 120)
}

function Get-ActivityColor($Result) {
  if ($Result -and $Result.running) { return [System.Drawing.Color]::FromArgb(235, 235, 235) }
  return [System.Drawing.Color]::FromArgb(145, 145, 145)
}

function Get-DividerColor {
  return [System.Drawing.Color]::FromArgb(132, 132, 132)
}

function Format-Parts($Result, [string]$Name) {
  $isRunning = [bool]($Result -and $Result.running)
  $textColor = Get-ActivityColor $Result
  $displayName = $Name.PadRight(6)
  $resetText = ""
  $resetValue = ""
  $weekText = ""
  $weekValue = ""
  $extraText = ""

  if (-not $Result -or -not $Result.ok) {
    return @{
      Prefix = "$displayName "
      Icon = Get-BatteryIcon $null
      Percent = $null
      PercentText = ""
      ResetText = ""
      ResetValue = ""
      WeekText = ""
      WeekValue = ""
      ExtraText = "?"
      Suffix = " ?"
      Running = $isRunning
      TextColor = $textColor
      IconColor = Get-PercentColor $null
    }
  }

  if ($null -eq $Result.percentRemaining) {
    $resetValue = "5h --:--"
    $weekValue = "7d ---%"
    $divider = [string][char]0x2502
    return @{
      Prefix = "$displayName "
      Icon = Get-BatteryIcon $null
      Percent = $null
      PercentText = "--"
      ResetText = $resetValue
      ResetValue = $resetValue
      WeekText = $weekValue
      WeekValue = $weekValue
      ExtraText = ""
      Suffix = " $divider $resetValue $divider $weekValue"
      Running = $isRunning
      TextColor = $textColor
      IconColor = Get-PercentColor $null
    }
  }

  $divider = [string][char]0x2502
  if ($Result.primary) {
    $resetWindow = Get-WindowText $Result.primary.windowMinutes
    $resetValue = "$resetWindow $(Get-ResetClock $Result.primary)".PadRight(8)
    $resetText = $resetValue
  }
  if ($Result.secondary) {
    $weekWindow = Get-WindowText $Result.secondary.windowMinutes
    # Space plus a thin space (U+2009): a single space reads slightly tighter
    # here than the "5h <time>" gap because the digits hug their left edge,
    # while a full double space looks padded. The label keeps a fixed width,
    # so the HUD does not resize when the digit count changes.
    $weekValue = "$weekWindow $([char]0x2009)$([int]$Result.secondary.remainingPercent)%"
    $weekText = $weekValue
  }
  $percentText = "$($Result.percentRemaining)"
  $suffix = ""
  if ($resetText) {
    $suffix += " $divider " + $resetText
  }
  if ($weekText) {
    $suffix += " $divider " + $weekText
  }
  return @{
    Prefix = "$displayName "
    Icon = Get-BatteryIcon $Result.percentRemaining
    Percent = $Result.percentRemaining
    PercentText = $percentText
    ResetText = $resetText
    ResetValue = $resetValue
    WeekText = $weekText
    WeekValue = $weekValue
    ExtraText = ""
    Suffix = $suffix
    Running = $isRunning
    TextColor = $textColor
    IconColor = Get-PercentColor $Result.percentRemaining
  }
}

function Get-Provider($Snapshot, [string]$Name) {
  return @($Snapshot.results | Where-Object { $_.provider -eq $Name })[0]
}

function Copy-MissingProperty($Target, $Source, [string]$Name) {
  if (-not $Target -or -not $Source) { return }
  if ($null -eq $Target.$Name -and $null -ne $Source.$Name) {
    $Target | Add-Member -NotePropertyName $Name -NotePropertyValue $Source.$Name -Force
  }
}

function Merge-HudSnapshot($Snapshot, $CachedSnapshot) {
  if (-not $Snapshot -or -not $Snapshot.results) { return $CachedSnapshot }
  $Snapshot.results = @($Snapshot.results)
  $nowUtc = [datetime]::UtcNow

  for ($i = 0; $i -lt $Snapshot.results.Count; $i += 1) {
    $current = $Snapshot.results[$i]
    if (-not $current -or -not $current.provider) { continue }

    $usable = [bool]$current.ok -and $null -ne $current.percentRemaining
    if ($usable) {
      $current | Add-Member -NotePropertyName "hudCachedAt" -NotePropertyValue $nowUtc.ToString("o") -Force
    }

    $cached = $null
    if ($CachedSnapshot) { $cached = Get-Provider $CachedSnapshot $current.provider }
    if (-not $cached -or -not $cached.ok -or $null -eq $cached.percentRemaining) { continue }

    if ($usable) {
      Copy-MissingProperty $current $cached "secondary"
      continue
    }

    # A transient read failure or a fallback row would flash "?"; keep the
    # last good reading instead, as long as it is reasonably recent.
    $cachedAt = $cached.hudCachedAt
    if (-not $cachedAt) { $cachedAt = $CachedSnapshot.generatedAt }
    $ageSeconds = $null
    try {
      $ageSeconds = ($nowUtc - ([datetime]$cachedAt).ToUniversalTime()).TotalSeconds
    } catch {
      $ageSeconds = $null
    }
    if ($null -eq $ageSeconds -or $ageSeconds -lt -60 -or $ageSeconds -gt 1800) { continue }

    $replacement = $cached | Select-Object *
    if ($null -ne $current.running) {
      $replacement | Add-Member -NotePropertyName "running" -NotePropertyValue $current.running -Force
    }
    $Snapshot.results[$i] = $replacement
  }

  return $Snapshot
}

function ConvertTo-HudTexts($Snapshot) {
  $codex = Get-Provider $Snapshot "codex"
  $claude = Get-Provider $Snapshot "claude"
  $codexVisible = $null -ne $codex
  $claudeVisible = $null -ne $claude
  return @{
    Codex = $(if ($codexVisible) { Format-Parts $codex "Codex" } else { $null })
    Claude = $(if ($claudeVisible) { Format-Parts $claude "Claude" } else { $null })
    CodexResult = $codex
    ClaudeResult = $claude
    CodexVisible = $codexVisible
    ClaudeVisible = $claudeVisible
  }
}

function Get-Texts {
  $cachedSnapshot = Read-HudSnapshot
  if ($script:initialHudSnapshot) {
    $snapshot = Merge-HudSnapshot $script:initialHudSnapshot $cachedSnapshot
    $script:initialHudSnapshot = $null
  } else {
    try {
      $snapshot = Merge-HudSnapshot (Invoke-AiBatteryJson) $cachedSnapshot
    } catch {
      if ($cachedSnapshot) {
        $snapshot = $cachedSnapshot
      } else {
        throw
      }
    }
  }
  Write-HudSnapshot $snapshot
  return ConvertTo-HudTexts $snapshot
}

$script:latestSnapshot = $null
$script:fetchPowerShell = $null
$script:fetchHandle = $null
$script:lastFetchStartUtc = [datetime]::MinValue
$script:weeklyRetryCount = 0

function Start-SnapshotFetch {
  if ($script:fetchPowerShell) { return }
  $ps = [powershell]::Create()
  $null = $ps.AddScript({
    param($Command, $UseWslShell)
    try {
      if ($UseWslShell) {
        $output = & wsl.exe bash -lc "$Command 2>/dev/null"
      } else {
        $output = Invoke-Expression "$Command 2>`$null"
      }
      ($output -join "`n").Trim()
    } catch {
      ""
    }
  }).AddArgument($BatteryCommand).AddArgument([bool]$UseWsl)
  $script:fetchHandle = $ps.BeginInvoke()
  $script:fetchPowerShell = $ps
  $script:lastFetchStartUtc = [datetime]::UtcNow
}

function Stop-SnapshotFetch {
  if (-not $script:fetchPowerShell) { return }
  try { $script:fetchPowerShell.Stop() } catch { }
  try { $script:fetchPowerShell.Dispose() } catch { }
  $script:fetchPowerShell = $null
  $script:fetchHandle = $null
}

function Complete-SnapshotFetch {
  if (-not $script:fetchPowerShell -or -not $script:fetchHandle.IsCompleted) { return $null }
  $text = ""
  try {
    $text = (($script:fetchPowerShell.EndInvoke($script:fetchHandle)) -join "`n").Trim()
  } catch {
    $text = ""
  }
  try { $script:fetchPowerShell.Dispose() } catch { }
  $script:fetchPowerShell = $null
  $script:fetchHandle = $null
  if (-not $text) { return $null }
  try {
    return $text | ConvertFrom-Json
  } catch {
    return $null
  }
}

if ($Once) {
  $texts = Get-Texts
  if ($texts.CodexVisible) { Write-Output "$($texts.Codex.Prefix)[battery]$($texts.Codex.Suffix)" }
  if ($texts.ClaudeVisible) { Write-Output "$($texts.Claude.Prefix)[battery]$($texts.Claude.Suffix)" }
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

function Get-LineText($Parts) {
  return "$($Parts.Prefix)[battery]$($Parts.Suffix)"
}

function Limit-Text([string]$Text, [int]$MaxLength) {
  if ($Text.Length -le $MaxLength) { return $Text }
  return $Text.Substring(0, [math]::Max(0, $MaxLength - 3)) + "..."
}

function Select-TrayPercent($Texts) {
  $items = @()
  foreach ($result in @($Texts.CodexResult, $Texts.ClaudeResult)) {
    if ($result -and $result.ok -and $null -ne $result.percentRemaining) {
      $items += [PSCustomObject]@{
        Percent = [int]$result.percentRemaining
        Running = [bool]$result.running
      }
    }
  }

  $runningItems = @($items | Where-Object { $_.Running })
  if ($runningItems.Count -gt 0) {
    return [Nullable[int]](@($runningItems | Sort-Object Percent)[0].Percent)
  }
  if ($items.Count -gt 0) {
    return [Nullable[int]](@($items | Sort-Object Percent)[0].Percent)
  }
  return $null
}

function New-ProviderTrayIcon([string]$ProviderLabel, [Nullable[int]]$Percent, [bool]$Running) {
  $bitmap = [System.Drawing.Bitmap]::new(32, 32)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $outlineColor = [System.Drawing.Color]::FromArgb(232, 232, 232)
  $mutedColor = [System.Drawing.Color]::FromArgb(145, 145, 145)
  $activeOutlineColor = if ($Running) { $outlineColor } else { $mutedColor }
  $fillColor = if ($Running) { Get-PercentColor $Percent } else { $mutedColor }
  $textColor = if ($Running) { [System.Drawing.Color]::FromArgb(245, 245, 245) } else { $mutedColor }
  $outlinePen = [System.Drawing.Pen]::new($(if ($null -eq $Percent) { $mutedColor } else { $activeOutlineColor }), 1.6)
  $fillBrush = [System.Drawing.SolidBrush]::new($fillColor)
  $terminalBrush = [System.Drawing.SolidBrush]::new($(if ($null -eq $Percent) { $mutedColor } else { $activeOutlineColor }))
  $textBrush = [System.Drawing.SolidBrush]::new($textColor)
  $labelFont = [System.Drawing.Font]::new("Segoe UI", 7, [System.Drawing.FontStyle]::Bold)
  $percentText = if ($null -eq $Percent) { "--" } else { [string][int]$Percent }
  $percentFontSize = if ($percentText.Length -ge 3) { 8.2 } else { 9.2 }
  $percentFont = [System.Drawing.Font]::new("Segoe UI", $percentFontSize, [System.Drawing.FontStyle]::Bold)
  $centerFormat = [System.Drawing.StringFormat]::new()
  $centerFormat.Alignment = [System.Drawing.StringAlignment]::Center
  $centerFormat.LineAlignment = [System.Drawing.StringAlignment]::Center

  try {
    $graphics.DrawString($ProviderLabel, $labelFont, $textBrush, [System.Drawing.RectangleF]::new(0, -1, 32, 10), $centerFormat)
    $graphics.DrawRectangle($outlinePen, 3, 11, 23, 16)
    $graphics.FillRectangle($terminalBrush, 27, 16, 3, 6)

    if ($null -eq $Percent) {
      $dashPen = [System.Drawing.Pen]::new($mutedColor, 2)
      try {
        $graphics.DrawLine($dashPen, 8, 19, 21, 19)
      } finally {
        $dashPen.Dispose()
      }
    } else {
      $clamped = [math]::Max(0, [math]::Min(100, $Percent))
      $fillWidth = [math]::Floor(($clamped / 100.0) * 19)
      if ($clamped -gt 0 -and $fillWidth -lt 2) { $fillWidth = 2 }
      $graphics.FillRectangle($fillBrush, 5, 13, $fillWidth, 12)
    }
    $graphics.DrawString($percentText, $percentFont, $textBrush, [System.Drawing.RectangleF]::new(4, 11, 22, 16), $centerFormat)
  } finally {
    $outlinePen.Dispose()
    $fillBrush.Dispose()
    $terminalBrush.Dispose()
    $textBrush.Dispose()
    $labelFont.Dispose()
    $percentFont.Dispose()
    $centerFormat.Dispose()
    $graphics.Dispose()
  }

  $handle = $bitmap.GetHicon()
  $sourceIcon = [System.Drawing.Icon]::FromHandle($handle)
  $icon = $sourceIcon.Clone()
  $sourceIcon.Dispose()
  [AiBatteryNative]::DestroyIcon($handle) | Out-Null
  $bitmap.Dispose()
  return $icon
}

function New-SingleBatteryTrayIcon([Nullable[int]]$Percent) {
  $bitmap = [System.Drawing.Bitmap]::new(32, 32)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $outlineColor = [System.Drawing.Color]::FromArgb(232, 232, 232)
  $mutedColor = [System.Drawing.Color]::FromArgb(145, 145, 145)
  $fillColor = Get-PercentColor $Percent
  $outlinePen = [System.Drawing.Pen]::new($(if ($null -eq $Percent) { $mutedColor } else { $outlineColor }), 2)
  $fillBrush = [System.Drawing.SolidBrush]::new($fillColor)
  $terminalBrush = [System.Drawing.SolidBrush]::new($(if ($null -eq $Percent) { $mutedColor } else { $outlineColor }))

  try {
    $graphics.DrawRectangle($outlinePen, 4, 9, 21, 14)
    $graphics.FillRectangle($terminalBrush, 26, 13, 3, 6)

    if ($null -eq $Percent) {
      $dashPen = [System.Drawing.Pen]::new($mutedColor, 2)
      try {
        $graphics.DrawLine($dashPen, 8, 16, 21, 16)
      } finally {
        $dashPen.Dispose()
      }
    } else {
      $clamped = [math]::Max(0, [math]::Min(100, $Percent))
      $fillWidth = [math]::Floor(($clamped / 100.0) * 17)
      if ($clamped -gt 0 -and $fillWidth -lt 2) { $fillWidth = 2 }
      $graphics.FillRectangle($fillBrush, 7, 12, $fillWidth, 8)
    }
  } finally {
    $outlinePen.Dispose()
    $fillBrush.Dispose()
    $terminalBrush.Dispose()
    $graphics.Dispose()
  }

  $handle = $bitmap.GetHicon()
  $sourceIcon = [System.Drawing.Icon]::FromHandle($handle)
  $icon = $sourceIcon.Clone()
  $sourceIcon.Dispose()
  [AiBatteryNative]::DestroyIcon($handle) | Out-Null
  $bitmap.Dispose()
  return $icon
}

function New-BatteryImage([Nullable[int]]$Percent, [bool]$Running = $true, [int]$Width = 34, [int]$Height = 16) {
  $bitmap = [System.Drawing.Bitmap]::new($Width, $Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $outlineColor = [System.Drawing.Color]::FromArgb(232, 232, 232)
  $mutedColor = [System.Drawing.Color]::FromArgb(145, 145, 145)
  $activeOutlineColor = if ($Running) { $outlineColor } else { $mutedColor }
  # The fill always keeps its charge color (matching the terminal bar);
  # running state is signalled by the outline and text colors instead.
  $fillColor = Get-PercentColor $Percent
  $outlinePen = [System.Drawing.Pen]::new($(if ($null -eq $Percent) { $mutedColor } else { $activeOutlineColor }), 1.6)
  $fillBrush = [System.Drawing.SolidBrush]::new($fillColor)
  # A solid dark interior keeps the desktop from bleeding through the empty
  # part of the battery, so the percent text stays readable on any wallpaper.
  $interiorBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(46, 46, 46))
  $terminalBrush = [System.Drawing.SolidBrush]::new($(if ($null -eq $Percent) { $mutedColor } else { $activeOutlineColor }))
  $textBrush = [System.Drawing.SolidBrush]::new($(if ($Running) { [System.Drawing.Color]::FromArgb(250, 250, 250) } else { [System.Drawing.Color]::FromArgb(210, 210, 210) }))
  $textHaloBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(200, 15, 15, 15))
  $fontSize = if ($null -eq $Percent) { 7.8 } elseif ($Percent -ge 100) { 7.2 } else { 8.2 }
  $batteryFont = [System.Drawing.Font]::new("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold)
  $centerFormat = [System.Drawing.StringFormat]::new()
  $centerFormat.Alignment = [System.Drawing.StringAlignment]::Center
  $centerFormat.LineAlignment = [System.Drawing.StringAlignment]::Center

  try {
    $bodyX = 1
    $bodyY = 3
    $bodyW = $Width - 6
    $bodyH = $Height - 6
    $capW = 3
    $capH = [math]::Max(4, [math]::Floor($bodyH / 2))
    $capY = $bodyY + [math]::Floor(($bodyH - $capH) / 2)

    $graphics.FillRectangle($interiorBrush, $bodyX + 1, $bodyY + 1, $bodyW - 1, $bodyH - 1)
    $graphics.DrawRectangle($outlinePen, $bodyX, $bodyY, $bodyW, $bodyH)
    $graphics.FillRectangle($terminalBrush, $bodyX + $bodyW + 1, $capY, $capW, $capH)

    if ($null -ne $Percent) {
      # The "--" text alone marks the unknown state; a dash line under it
      # just collides with the halo.
      $clamped = [math]::Max(0, [math]::Min(100, $Percent))
      $innerW = $bodyW - 5
      $fillW = [math]::Floor(($clamped / 100.0) * $innerW)
      if ($clamped -gt 0 -and $fillW -lt 2) { $fillW = 2 }
      $graphics.FillRectangle($fillBrush, $bodyX + 3, $bodyY + 3, $fillW, $bodyH - 5)
    }
    $batteryText = if ($null -eq $Percent) { "--" } else { [string][int]$Percent }
    $textRect = [System.Drawing.RectangleF]::new($bodyX + 2, $bodyY, $bodyW - 3, $bodyH + 1)
    # A one-pixel dark halo keeps the number legible over the green/orange/red
    # fill as well as over the dark empty region.
    foreach ($shift in @(@(-1, 0), @(1, 0), @(0, -1), @(0, 1))) {
      $haloRect = [System.Drawing.RectangleF]::new($textRect.X + $shift[0], $textRect.Y + $shift[1], $textRect.Width, $textRect.Height)
      $graphics.DrawString($batteryText, $batteryFont, $textHaloBrush, $haloRect, $centerFormat)
    }
    $graphics.DrawString($batteryText, $batteryFont, $textBrush, $textRect, $centerFormat)
  } finally {
    $outlinePen.Dispose()
    $fillBrush.Dispose()
    $interiorBrush.Dispose()
    $terminalBrush.Dispose()
    $textBrush.Dispose()
    $textHaloBrush.Dispose()
    $batteryFont.Dispose()
    $centerFormat.Dispose()
    $graphics.Dispose()
  }

  return $bitmap
}

function New-StatusMenuLabel($Font, [int]$Width, $Align = [System.Drawing.ContentAlignment]::MiddleLeft) {
  $label = New-Object System.Windows.Forms.Label
  $label.AutoSize = $false
  $label.Width = $Width
  $label.Height = 20
  $label.Font = $Font
  $label.TextAlign = $Align
  $label.Margin = [System.Windows.Forms.Padding]::new(0)
  $label.BackColor = [System.Drawing.SystemColors]::Menu
  return $label
}

function New-StatusMenuRow($Font) {
  $panel = New-Object System.Windows.Forms.FlowLayoutPanel
  $panel.Width = 252
  $panel.Height = 22
  $panel.FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
  $panel.WrapContents = $false
  $panel.Margin = [System.Windows.Forms.Padding]::new(0)
  $panel.Padding = [System.Windows.Forms.Padding]::new(4, 1, 4, 1)
  $panel.BackColor = [System.Drawing.SystemColors]::Menu

  $name = New-StatusMenuLabel $Font 44
  $icon = New-Object System.Windows.Forms.PictureBox
  $icon.Width = 36
  $icon.Height = 20
  $icon.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::CenterImage
  $icon.Margin = [System.Windows.Forms.Padding]::new(0)
  $icon.BackColor = [System.Drawing.SystemColors]::Menu
  $percent = New-StatusMenuLabel $Font 0 ([System.Drawing.ContentAlignment]::MiddleRight)
  $reset = New-StatusMenuLabel $Font 58
  $week = New-StatusMenuLabel $Font 50
  $extra = New-StatusMenuLabel $Font 58

  foreach ($control in @($name, $icon, $percent, $reset, $week, $extra)) {
    $panel.Controls.Add($control) | Out-Null
  }

  $rowHost = New-Object System.Windows.Forms.ToolStripControlHost($panel)
  $rowHost.AutoSize = $false
  $rowHost.Width = $panel.Width
  $rowHost.Height = $panel.Height

  return @{
    Host = $rowHost
    Panel = $panel
    Name = $name
    Icon = $icon
    Percent = $percent
    Reset = $reset
    Week = $week
    Extra = $extra
  }
}

function Set-StatusMenuRow($Row, $Parts) {
  $textColor = $Parts.TextColor
  $Row.Name.Text = $Parts.Prefix.TrimEnd()
  $Row.Percent.Text = $Parts.PercentText
  $Row.Reset.Text = $Parts.ResetText
  $Row.Week.Text = $Parts.WeekText
  $Row.Extra.Text = $Parts.ExtraText

  foreach ($label in @($Row.Name, $Row.Percent, $Row.Reset, $Row.Week, $Row.Extra)) {
    $label.ForeColor = $textColor
  }

  $oldImage = $Row.Icon.Image
  $Row.Icon.Image = New-BatteryImage $Parts.Percent $Parts.Running
  if ($oldImage) { $oldImage.Dispose() }
}

function Dispose-StatusMenuRow($Row) {
  if ($Row.Icon.Image) {
    $Row.Icon.Image.Dispose()
    $Row.Icon.Image = $null
  }
}

if ($Mode -eq "tray") {
  $context = [System.Windows.Forms.ApplicationContext]::new()
  $trayFont = [System.Drawing.Font]::new("Segoe UI", 9, [System.Drawing.FontStyle]::Regular)
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $menu.Font = $trayFont
  $codexRow = New-StatusMenuRow $trayFont
  $claudeRow = New-StatusMenuRow $trayFont
  $menu.Items.Add($codexRow.Host) | Out-Null
  $menu.Items.Add($claudeRow.Host) | Out-Null
  $menu.Items.Add("-") | Out-Null
  $refreshItem = $menu.Items.Add("Refresh")
  $exitItem = $menu.Items.Add("Exit")

  $notifyIcon = New-Object System.Windows.Forms.NotifyIcon
  $notifyIcon.ContextMenuStrip = $menu
  $notifyIcon.Visible = $true
  $notifyIcon.Text = "AI Battery"
  $script:currentTrayIcon = $null
  $script:lastBalloonText = "AI Battery"

  function Set-SingleNotifyIcon($Texts) {
    $trayPercent = Select-TrayPercent $Texts
    $newIcon = New-SingleBatteryTrayIcon $trayPercent
    $oldIcon = $script:currentTrayIcon
    $notifyIcon.Icon = $newIcon
    $script:currentTrayIcon = $newIcon
    if ($oldIcon) { $oldIcon.Dispose() }

    $shortParts = @()
    if ($Texts.CodexVisible) {
      $shortParts += $(if ($null -ne $Texts.CodexResult.percentRemaining) { "Codex $($Texts.CodexResult.percentRemaining)%" } else { "Codex --%" })
    }
    if ($Texts.ClaudeVisible) {
      $shortParts += $(if ($null -ne $Texts.ClaudeResult.percentRemaining) { "Claude $($Texts.ClaudeResult.percentRemaining)%" } else { "Claude --%" })
    }
    $notifyIcon.Text = Limit-Text "AI Battery: $($shortParts -join ', ')" 63
  }

  function Update-Tray {
    try {
      $texts = Get-Texts
      $codexRow.Host.Visible = $texts.CodexVisible
      $claudeRow.Host.Visible = $texts.ClaudeVisible
      $codexLine = if ($texts.CodexVisible) { Get-LineText $texts.Codex } else { "" }
      $claudeLine = if ($texts.ClaudeVisible) { Get-LineText $texts.Claude } else { "" }
      if ($texts.CodexVisible) { Set-StatusMenuRow $codexRow $texts.Codex }
      if ($texts.ClaudeVisible) { Set-StatusMenuRow $claudeRow $texts.Claude }

      Set-SingleNotifyIcon $texts
      $script:lastBalloonText = (@($codexLine, $claudeLine) | Where-Object { $_ }) -join "`n"
    } catch {
      Set-StatusMenuRow $codexRow @{
        Prefix = "Codex  "
        Percent = $null
        PercentText = "?"
        ResetText = ""
        WeekText = ""
        ExtraText = "unavailable"
        TextColor = [System.Drawing.Color]::FromArgb(255, 92, 92)
      }
      Set-StatusMenuRow $claudeRow @{
        Prefix = "Claude "
        Percent = $null
        PercentText = "?"
        ResetText = ""
        WeekText = ""
        ExtraText = ""
        TextColor = [System.Drawing.Color]::FromArgb(145, 145, 145)
      }
      $newIcon = New-SingleBatteryTrayIcon $null
      $oldIcon = $script:currentTrayIcon
      $notifyIcon.Icon = $newIcon
      $script:currentTrayIcon = $newIcon
      if ($oldIcon) { $oldIcon.Dispose() }
      $notifyIcon.Text = "AI Battery unavailable"
      $script:lastBalloonText = "AI Battery unavailable"
    }
  }

  $refreshItem.add_Click({ Update-Tray })
  $exitItem.add_Click({
    $notifyIcon.Visible = $false
    Dispose-StatusMenuRow $codexRow
    Dispose-StatusMenuRow $claudeRow
    if ($notifyIcon.Icon) { $notifyIcon.Icon.Dispose() }
    $notifyIcon.Dispose()
    $trayFont.Dispose()
    Release-SingleInstance
    $context.ExitThread()
  })
  $openMenu = {
    param($sender, $event)
    if ($event.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      Update-Tray
      $menu.Show([System.Windows.Forms.Cursor]::Position)
    }
  }
  $notifyIcon.add_MouseClick($openMenu)

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = [math]::Max(1, $Interval) * 1000
  $timer.add_Tick({ Update-Tray })
  Update-Tray
  $timer.Start()
  Signal-HudReady
  [System.Windows.Forms.Application]::Run($context)
  Release-SingleInstance
  exit 0
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "AI Battery"
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Width = $Width
$form.Height = if ($Mode -eq "floating") { 44 } elseif ($Mode -eq "statusline") { 44 } else { 54 }
$script:hudTwoRowHeight = $form.Height
$script:hudOneRowHeight = [math]::Max(20, $form.Height - 18)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$transparentBackColor = [System.Drawing.Color]::FromArgb(18, 18, 18)
$form.BackColor = $transparentBackColor
$form.TransparencyKey = $transparentBackColor
$form.Opacity = [math]::Max(0.2, [math]::Min(1.0, $Opacity))

$font = [System.Drawing.Font]::new("Segoe UI", $(if ($Mode -eq "statusline") { 8.5 } else { 9 }), [System.Drawing.FontStyle]::Regular)
$symbolFont = [System.Drawing.Font]::new("Cascadia Mono", $(if ($Mode -eq "statusline") { 11.5 } else { 12 }), [System.Drawing.FontStyle]::Regular)

$panel = New-Object System.Windows.Forms.TableLayoutPanel
$panel.Dock = [System.Windows.Forms.DockStyle]::Fill
$panel.RowCount = 2
$panel.ColumnCount = 1
$panel.GrowStyle = [System.Windows.Forms.TableLayoutPanelGrowStyle]::FixedSize
$panel.Padding = if ($Mode -eq "floating" -or $Mode -eq "statusline") {
  [System.Windows.Forms.Padding]::new(6, 4, 2, 3)
} else {
  [System.Windows.Forms.Padding]::new(10, 7, 10, 6)
}
$panel.BackColor = $form.BackColor
$panel.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Percent, 50)) | Out-Null
$panel.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Percent, 50)) | Out-Null
$panel.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 100)) | Out-Null

function New-HudRow {
  $row = New-Object System.Windows.Forms.FlowLayoutPanel
  $row.Dock = [System.Windows.Forms.DockStyle]::Fill
  $row.FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
  $row.WrapContents = $false
  $row.Margin = [System.Windows.Forms.Padding]::new(0)
  $row.Padding = [System.Windows.Forms.Padding]::new(0)
  $row.BackColor = $form.BackColor
  return $row
}

function New-HudLabel([int]$RightMargin = 0) {
  $label = New-Object System.Windows.Forms.Label
  $label.AutoSize = $false
  $label.Width = 0
  $label.Height = 18
  $label.Font = $font
  $label.UseCompatibleTextRendering = $false
  $label.BackColor = $form.BackColor
  $label.Margin = [System.Windows.Forms.Padding]::new(0, 0, $RightMargin, 0)
  $label.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
  return $label
}

function New-HudIconBox {
  $box = New-Object System.Windows.Forms.PictureBox
  $box.Width = 36
  $box.Height = 18
  $box.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::CenterImage
  $box.BackColor = $form.BackColor
  $box.Margin = [System.Windows.Forms.Padding]::new(0, 0, 2, 0)
  return $box
}

function New-HudLineIconBox {
  $box = New-Object System.Windows.Forms.PictureBox
  $box.Width = 21
  $box.Height = 18
  $box.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::CenterImage
  $box.BackColor = $form.BackColor
  $box.Margin = [System.Windows.Forms.Padding]::new(3, 0, 0, 0)
  return $box
}

function New-HudDivider {
  $divider = New-Object System.Windows.Forms.Panel
  $divider.AutoSize = $false
  $divider.Width = 1
  $divider.Height = 12
  $divider.BackColor = Get-DividerColor
  $divider.Margin = [System.Windows.Forms.Padding]::new(4, 3, 4, 3)
  return $divider
}

$codexRow = New-HudRow
$claudeRow = New-HudRow
$codexPrefixLabel = New-HudLabel
$codexIconLabel = New-HudIconBox
$codexDivider1 = New-HudDivider
$codexResetLabel = New-HudLabel
$codexDivider2 = New-HudDivider
$codexWeekLabel = New-HudLabel
$codexExtraLabel = New-HudLabel
$claudePrefixLabel = New-HudLabel
$claudeIconLabel = New-HudIconBox
$claudeDivider1 = New-HudDivider
$claudeResetLabel = New-HudLabel
$claudeDivider2 = New-HudDivider
$claudeWeekLabel = New-HudLabel
$claudeExtraLabel = New-HudLabel

foreach ($label in @($codexPrefixLabel, $claudePrefixLabel)) {
  $label.AutoSize = $false
  $label.Width = 48
}
foreach ($label in @($codexIconLabel, $claudeIconLabel)) {
  $label.Width = 38
}

$codexHudControls = @($codexPrefixLabel, $codexIconLabel, $codexDivider1, $codexResetLabel, $codexDivider2, $codexWeekLabel, $codexExtraLabel)
$claudeHudControls = @($claudePrefixLabel, $claudeIconLabel, $claudeDivider1, $claudeResetLabel, $claudeDivider2, $claudeWeekLabel, $claudeExtraLabel)

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Font = $font
$exitItem = $menu.Items.Add("Exit")
$exitItem.add_Click({ $form.Close() })
$form.ContextMenuStrip = $menu
$panel.ContextMenuStrip = $menu
foreach ($label in $codexHudControls) {
  $label.ContextMenuStrip = $menu
  $codexRow.Controls.Add($label) | Out-Null
}
foreach ($label in $claudeHudControls) {
  $label.ContextMenuStrip = $menu
  $claudeRow.Controls.Add($label) | Out-Null
}
$codexRow.ContextMenuStrip = $menu
$claudeRow.ContextMenuStrip = $menu
$panel.Controls.Add($codexRow, 0, 0) | Out-Null
$panel.Controls.Add($claudeRow, 0, 1) | Out-Null
$form.Controls.Add($panel)

$hitForm = $null
if (-not $ClickThrough) {
  $hitForm = New-Object System.Windows.Forms.Form
  $hitForm.Text = "AI Battery hit area"
  $hitForm.Width = $form.Width
  $hitForm.Height = $form.Height
  $hitForm.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $hitForm.ShowInTaskbar = $false
  $hitForm.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $hitForm.BackColor = [System.Drawing.Color]::Black
  $hitForm.Opacity = 0.01
  $hitForm.TopMost = $true
  $hitForm.ContextMenuStrip = $menu
}

function Sync-HitFormBounds {
  if (-not $hitForm -or $hitForm.IsDisposed) { return }
  $hitForm.Bounds = [System.Drawing.Rectangle]::new($form.Left, $form.Top, $form.Width, $form.Height)
}

function Show-HitForm {
  if (-not $hitForm -or $hitForm.IsDisposed) { return }
  Sync-HitFormBounds
  if (-not $hitForm.Visible) {
    $hitForm.Show()
  }
  $style = [AiBatteryNative]::GetWindowLong($hitForm.Handle, [AiBatteryNative]::GWL_EXSTYLE)
  $style = $style -bor [AiBatteryNative]::WS_EX_TOOLWINDOW
  [AiBatteryNative]::SetWindowLong($hitForm.Handle, [AiBatteryNative]::GWL_EXSTYLE, $style) | Out-Null
}

$dragging = $false
$dragOffset = [System.Drawing.Point]::new(0, 0)
$mouseDown = {
  param($sender, $event)
  if ($event.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $script:dragging = $true
    $screenPoint = $sender.PointToScreen([System.Drawing.Point]::new($event.X, $event.Y))
    $script:dragOffset = [System.Drawing.Point]::new(
      ($screenPoint.X - $form.Location.X),
      ($screenPoint.Y - $form.Location.Y)
    )
  }
}
$mouseMove = {
  param($sender, $event)
  if ($script:dragging) {
    $screenPoint = $sender.PointToScreen([System.Drawing.Point]::new($event.X, $event.Y))
    $form.Location = [System.Drawing.Point]::new(($screenPoint.X - $script:dragOffset.X), ($screenPoint.Y - $script:dragOffset.Y))
    Sync-HitFormBounds
  }
}
$mouseUp = {
  $script:dragging = $false
  if ($canMove) {
    Set-HudAnchorFromPlacement $form.Location ([Nullable[int]]$form.Width) ([Nullable[int]]$form.Height)
    Write-HudPosition $form.Location
    Ensure-HudTopMost
  }
}
$canMove = $Movable -or (($Mode -eq "floating") -and (-not $Locked))
$script:positionSaveReady = $false
$script:hudHiddenForFullscreen = $false

function Save-HudPositionIfReady {
  if (-not $canMove -or -not $script:positionSaveReady) { return }
  Set-HudAnchorFromPlacement $form.Location ([Nullable[int]]$form.Width) ([Nullable[int]]$form.Height)
  Write-HudPosition $form.Location
}

if ($canMove) {
  $dragControls = @($form, $panel, $codexRow, $claudeRow) + $codexHudControls + $claudeHudControls
  if ($hitForm) { $dragControls += $hitForm }
  foreach ($control in $dragControls) {
    $control.add_MouseDown($mouseDown)
    $control.add_MouseMove($mouseMove)
    $control.add_MouseUp($mouseUp)
  }
}

function Limit-Number([int]$Value, [int]$Min, [int]$Max) {
  if ($Max -lt $Min) { return $Min }
  return [math]::Max($Min, [math]::Min($Max, $Value))
}

function Set-HudAnchorFromPlacement($Location, [Nullable[int]]$Width, [Nullable[int]]$Height) {
  $placementWidth = if ($null -ne $Width -and $Width -gt 0) { [int]$Width } else { [int]$form.Width }
  $placementHeight = if ($null -ne $Height -and $Height -gt 0) { [int]$Height } else { [int]$form.Height }
  $center = [System.Drawing.Point]::new(
    [int]($Location.X + [math]::Floor($placementWidth / 2)),
    [int]($Location.Y + [math]::Floor($placementHeight / 2))
  )
  $bounds = [System.Windows.Forms.Screen]::FromPoint($center).Bounds
  $leftDistance = [math]::Abs($Location.X - $bounds.Left)
  $rightDistance = [math]::Abs($bounds.Right - ($Location.X + $placementWidth))
  $topDistance = [math]::Abs($Location.Y - $bounds.Top)
  $bottomDistance = [math]::Abs($bounds.Bottom - ($Location.Y + $placementHeight))

  $script:hudAnchorX = if ($rightDistance -lt $leftDistance) { "right" } else { "left" }
  $script:hudAnchorY = if ($bottomDistance -lt $topDistance) { "bottom" } else { "top" }
}

function Set-HudAnchorFromPositionKeyword {
  $script:hudAnchorX = if ($Position -like "*left*") { "left" } else { "right" }
  $script:hudAnchorY = if ($Position -like "top*") { "top" } else { "bottom" }
}

function Get-WindowRectObject([IntPtr]$Handle) {
  if ($Handle -eq [IntPtr]::Zero) { return $null }
  $rect = New-Object AiBatteryRect
  if (-not [AiBatteryNative]::GetWindowRect($Handle, [ref]$rect)) { return $null }
  return [PSCustomObject]@{
    Left = [int]$rect.Left
    Top = [int]$rect.Top
    Right = [int]$rect.Right
    Bottom = [int]$rect.Bottom
    Width = [int]($rect.Right - $rect.Left)
    Height = [int]($rect.Bottom - $rect.Top)
  }
}

function Get-MonitorRectObject([IntPtr]$Monitor) {
  if ($Monitor -eq [IntPtr]::Zero) { return $null }
  $info = New-Object AiBatteryMonitorInfo
  $info.CbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
  if (-not [AiBatteryNative]::GetMonitorInfo($Monitor, [ref]$info)) { return $null }
  return [PSCustomObject]@{
    Left = [int]$info.Monitor.Left
    Top = [int]$info.Monitor.Top
    Right = [int]$info.Monitor.Right
    Bottom = [int]$info.Monitor.Bottom
    Width = [int]($info.Monitor.Right - $info.Monitor.Left)
    Height = [int]($info.Monitor.Bottom - $info.Monitor.Top)
  }
}

function Test-RectCoversMonitor($WindowRect, $MonitorRect) {
  if (-not $WindowRect -or -not $MonitorRect) { return $false }
  $tolerance = 2
  return (
    $WindowRect.Left -le ($MonitorRect.Left + $tolerance) -and
    $WindowRect.Top -le ($MonitorRect.Top + $tolerance) -and
    $WindowRect.Right -ge ($MonitorRect.Right - $tolerance) -and
    $WindowRect.Bottom -ge ($MonitorRect.Bottom - $tolerance)
  )
}

function Test-ForegroundFullscreen {
  if (-not $form -or $form.IsDisposed) { return $false }
  $foreground = [AiBatteryNative]::GetForegroundWindow()
  if ($foreground -eq [IntPtr]::Zero) { return $false }
  if ($foreground -eq $form.Handle) { return $false }
  if ($hitForm -and -not $hitForm.IsDisposed -and $foreground -eq $hitForm.Handle) { return $false }

  $hudMonitor = [AiBatteryNative]::MonitorFromWindow($form.Handle, [AiBatteryNative]::MONITOR_DEFAULTTONEAREST)
  $foregroundMonitor = [AiBatteryNative]::MonitorFromWindow($foreground, [AiBatteryNative]::MONITOR_DEFAULTTONEAREST)
  if ($hudMonitor -eq [IntPtr]::Zero -or $foregroundMonitor -eq [IntPtr]::Zero) { return $false }
  if ($hudMonitor -ne $foregroundMonitor) { return $false }

  $windowRect = Get-WindowRectObject $foreground
  $monitorRect = Get-MonitorRectObject $foregroundMonitor
  return Test-RectCoversMonitor $windowRect $monitorRect
}

function Set-TaskbarPosition {
  $taskbarHandle = [AiBatteryNative]::FindWindow("Shell_TrayWnd", $null)
  if ($taskbarHandle -eq [IntPtr]::Zero) { return $false }

  $taskbarRect = Get-WindowRectObject $taskbarHandle
  if (-not $taskbarRect) { return $false }

  $trayHandle = [AiBatteryNative]::FindWindowEx($taskbarHandle, [IntPtr]::Zero, "TrayNotifyWnd", $null)
  $trayRect = Get-WindowRectObject $trayHandle
  if (-not $trayRect) {
    $trayRect = [PSCustomObject]@{
      Left = $taskbarRect.Right
      Top = $taskbarRect.Bottom
      Right = $taskbarRect.Right
      Bottom = $taskbarRect.Bottom
      Width = 0
      Height = 0
    }
  }

  $screen = [System.Windows.Forms.Screen]::FromHandle($taskbarHandle)
  $bounds = $screen.Bounds
  $margin = 6
  $isHorizontal = $taskbarRect.Width -ge $taskbarRect.Height

  if ($isHorizontal) {
    $x = $trayRect.Left - $form.Width - $margin
    $y = $taskbarRect.Top + [math]::Floor(($taskbarRect.Height - $form.Height) / 2)
  } else {
    $isLeft = $taskbarRect.Left -le $bounds.Left
    $x = if ($isLeft) { $taskbarRect.Right + $margin } else { $taskbarRect.Left - $form.Width - $margin }
    $y = $trayRect.Top - $form.Height - $margin
  }

  $x = Limit-Number $x ($bounds.Left + $margin) ($bounds.Right - $form.Width - $margin)
  $y = Limit-Number $y ($bounds.Top + $margin) ($bounds.Bottom - $form.Height - $margin)
  $form.Location = [System.Drawing.Point]::new([int]$x, [int]$y)
  Set-HudAnchorFromPlacement $form.Location ([Nullable[int]]$form.Width) ([Nullable[int]]$form.Height)
  return $true
}

function Get-OnScreenPoint([int]$X, [int]$Y, [int]$W, [int]$H) {
  $rect = [System.Drawing.Rectangle]::new($X, $Y, [math]::Max(1, $W), [math]::Max(1, $H))
  foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    # Compare against the full monitor bounds, not the working area: sitting
    # on top of the taskbar is this HUD's primary use case, and the taskbar
    # band is outside every working area.
    $overlap = [System.Drawing.Rectangle]::Intersect($screen.Bounds, $rect)
    if ($overlap.Width -ge 24 -and $overlap.Height -ge 10) {
      return [System.Drawing.Point]::new($X, $Y)
    }
  }

  # The saved spot is no longer on any screen (monitor unplugged or layout
  # changed), so pull the HUD back into the primary working area.
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $margin = 18
  $newX = Limit-Number $X ($area.Left + $margin) ($area.Right - $W - $margin)
  $newY = Limit-Number $Y ($area.Top + $margin) ($area.Bottom - $H - $margin)
  return [System.Drawing.Point]::new([int]$newX, [int]$newY)
}

function Set-Position {
  if ($Position -eq "saved") {
    $savedPlacement = Read-HudPlacement
    if ($savedPlacement) {
      if ($null -ne $savedPlacement.Width -and $savedPlacement.Width -gt 0) {
        $form.Width = [int]$savedPlacement.Width
      }
      if ($null -ne $savedPlacement.Height -and $savedPlacement.Height -gt 0) {
        $form.Height = [int]$savedPlacement.Height
      }
      $form.Location = Get-OnScreenPoint ([int]$savedPlacement.X) ([int]$savedPlacement.Y) ([int]$form.Width) ([int]$form.Height)
      Set-HudAnchorFromPlacement $form.Location ([Nullable[int]]$form.Width) ([Nullable[int]]$form.Height)
      return
    }
  }

  if ($Position -eq "taskbar") {
    if (Set-TaskbarPosition) { return }
  }

  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $margin = if ($Mode -eq "statusline") { 8 } else { 18 }
  $x = if ($Position -like "*left*") {
    $area.Left + $margin
  } elseif ($Position -like "*center*") {
    $area.Left + [math]::Floor(($area.Width - $form.Width) / 2)
  } else {
    $area.Right - $form.Width - $margin
  }
  $y = if ($Position -like "top*") { $area.Top + $margin } else { $area.Bottom - $form.Height - $margin }
  $form.Location = [System.Drawing.Point]::new($x, $y)
  Set-HudAnchorFromPositionKeyword
}

function Ensure-HudTopMost {
  if (-not $form -or $form.IsDisposed) { return }
  if ($script:hudHiddenForFullscreen) { return }
  if ($hitForm -and -not $hitForm.IsDisposed -and $hitForm.Visible) {
    $hitForm.TopMost = $true
    [AiBatteryNative]::SetWindowPos(
      $hitForm.Handle,
      [AiBatteryNative]::HWND_TOPMOST,
      0,
      0,
      0,
      0,
      [AiBatteryNative]::SWP_NOMOVE -bor [AiBatteryNative]::SWP_NOSIZE -bor [AiBatteryNative]::SWP_NOACTIVATE -bor [AiBatteryNative]::SWP_SHOWWINDOW
    ) | Out-Null
  }
  $form.TopMost = $true
  [AiBatteryNative]::SetWindowPos(
    $form.Handle,
    [AiBatteryNative]::HWND_TOPMOST,
    0,
    0,
    0,
    0,
    [AiBatteryNative]::SWP_NOMOVE -bor [AiBatteryNative]::SWP_NOSIZE -bor [AiBatteryNative]::SWP_NOACTIVATE -bor [AiBatteryNative]::SWP_SHOWWINDOW
  ) | Out-Null
}

function Set-HudHiddenForFullscreen([bool]$Hidden) {
  $script:hudHiddenForFullscreen = $Hidden
  if ($Hidden) {
    if ($hitForm -and -not $hitForm.IsDisposed -and $hitForm.Visible) {
      $hitForm.Hide()
    }
    if ($form -and -not $form.IsDisposed -and $form.Visible) {
      $form.Hide()
    }
    return
  }

  if ($form -and -not $form.IsDisposed -and -not $form.Visible) {
    $form.Show()
  }
  Show-HitForm
  Sync-HitFormBounds
}

function Update-HudVisibilityForFullscreen {
  if (-not $form -or $form.IsDisposed) { return }
  if (Test-ForegroundFullscreen) {
    Set-HudHiddenForFullscreen $true
    return
  }
  Set-HudHiddenForFullscreen $false
  Ensure-HudTopMost
}

function Set-HudBatteryImage($Box, [Nullable[int]]$Percent, [bool]$Running) {
  $oldImage = $Box.Image
  $Box.Image = New-BatteryImage $Percent $Running
  $Box.Visible = $true
  $Box.Tag = $true
  if ($oldImage) { $oldImage.Dispose() }
}

function New-HudGlyphImage([string]$Kind, [System.Drawing.Color]$Color, [int]$Width = 21, [int]$Height = 18) {
  $bitmap = [System.Drawing.Bitmap]::new($Width, $Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $graphics.Clear([System.Drawing.Color]::Transparent)

  if ($Kind -eq "reset") {
    $pen = [System.Drawing.Pen]::new($Color, 2.1)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $brush = [System.Drawing.SolidBrush]::new($Color)
    try {
      $arcX = 3.6
      $arcY = 2.5
      $arcW = 13.0
      $arcH = 13.0
      $startAngle = 150.0
      $sweepAngle = 190.0
      $endAngle = ($startAngle + $sweepAngle) * [math]::PI / 180.0
      $centerX = $arcX + ($arcW / 2.0)
      $centerY = $arcY + ($arcH / 2.0)
      $radiusX = $arcW / 2.0
      $radiusY = $arcH / 2.0

      $graphics.DrawArc($pen, [single]$arcX, [single]$arcY, [single]$arcW, [single]$arcH, [single]$startAngle, [single]$sweepAngle)

      $tipX = $centerX + ($radiusX * [math]::Cos($endAngle))
      $tipY = $centerY + ($radiusY * [math]::Sin($endAngle))
      $dirX = -[math]::Sin($endAngle)
      $dirY = [math]::Cos($endAngle)
      $length = [math]::Sqrt(($dirX * $dirX) + ($dirY * $dirY))
      if ($length -gt 0) {
        $dirX = $dirX / $length
        $dirY = $dirY / $length
      }
      $normalX = -$dirY
      $normalY = $dirX
      $headLength = 4.8
      $headWidth = 3.3
      $baseX = $tipX - ($dirX * $headLength)
      $baseY = $tipY - ($dirY * $headLength)

      $points = @(
        [System.Drawing.PointF]::new([single]$tipX, [single]$tipY),
        [System.Drawing.PointF]::new([single]($baseX + ($normalX * $headWidth)), [single]($baseY + ($normalY * $headWidth))),
        [System.Drawing.PointF]::new([single]($baseX - ($normalX * $headWidth)), [single]($baseY - ($normalY * $headWidth)))
      )
      $graphics.FillPolygon($brush, $points)
    } finally {
      $pen.Dispose()
      $brush.Dispose()
      $graphics.Dispose()
    }
    return $bitmap
  }

  $sourceSize = 48
  $source = [System.Drawing.Bitmap]::new($sourceSize, $sourceSize)
  $sourceGraphics = [System.Drawing.Graphics]::FromImage($source)
  $sourceGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $sourceGraphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $sourceGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $sourceGraphics.Clear([System.Drawing.Color]::Transparent)

  $brush = [System.Drawing.SolidBrush]::new($Color)
  $format = [System.Drawing.StringFormat]::new()
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Near

  try {
    $glyph = [string][char]0x2466
    $maxIconWidth = 12
    $maxIconHeight = 12
    $sourceGraphics.DrawString(
      $glyph,
      $symbolFont,
      $brush,
      [System.Drawing.RectangleF]::new([single]0, [single]0, [single]$sourceSize, [single]$sourceSize),
      $format
    )

    $left = $sourceSize
    $top = $sourceSize
    $right = -1
    $bottom = -1
    for ($y = 0; $y -lt $sourceSize; $y += 1) {
      for ($x = 0; $x -lt $sourceSize; $x += 1) {
        if ($source.GetPixel($x, $y).A -gt 0) {
          if ($x -lt $left) { $left = $x }
          if ($x -gt $right) { $right = $x }
          if ($y -lt $top) { $top = $y }
          if ($y -gt $bottom) { $bottom = $y }
        }
      }
    }

    if ($right -ge $left -and $bottom -ge $top) {
      $sourceRect = [System.Drawing.Rectangle]::new($left, $top, ($right - $left + 1), ($bottom - $top + 1))
      $scale = [math]::Min(1.0, [math]::Min(($maxIconWidth / [double]$sourceRect.Width), ($maxIconHeight / [double]$sourceRect.Height)))
      $targetWidth = [math]::Max(1, [int][math]::Round($sourceRect.Width * $scale))
      $targetHeight = [math]::Max(1, [int][math]::Round($sourceRect.Height * $scale))
      $targetX = [math]::Floor(($Width - $targetWidth) / 2)
      $targetY = [math]::Floor(($Height - $targetHeight) / 2)
      $targetRect = [System.Drawing.Rectangle]::new([int]$targetX, [int]$targetY, $targetWidth, $targetHeight)
      $graphics.DrawImage($source, $targetRect, $sourceRect, [System.Drawing.GraphicsUnit]::Pixel)
    }
  } finally {
    $brush.Dispose()
    $format.Dispose()
    $sourceGraphics.Dispose()
    $source.Dispose()
    $graphics.Dispose()
  }

  return $bitmap
}

function Set-HudLineIconImage($Box, [string]$Kind, [string]$Value, [System.Drawing.Color]$Color) {
  $oldImage = $Box.Image
  if ([string]::IsNullOrWhiteSpace($Value)) {
    $Box.Image = $null
    $Box.Visible = $false
  } else {
    $Box.Image = New-HudGlyphImage $Kind $Color
    $Box.Visible = $true
  }
  if ($oldImage) { $oldImage.Dispose() }
}

function Set-HudMetricLabel($Label, [string]$Value, [System.Drawing.Color]$Color, [Nullable[int]]$FixedWidth = $null) {
  $Label.Text = $Value
  $Label.ForeColor = $Color
  if ([string]::IsNullOrWhiteSpace($Value)) {
    $Label.Width = 0
    $Label.Visible = $false
    $Label.Tag = $false
  } else {
    $Label.Width = if ($null -ne $FixedWidth -and $FixedWidth -gt 0) { [int]$FixedWidth } else { (Get-LabelTextWidth $Label) + 1 }
    $Label.Visible = $true
    $Label.Tag = $true
  }
}

function Set-HudDivider($Divider, [string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    $Divider.Visible = $false
    $Divider.Width = 0
    $Divider.Tag = $false
  } else {
    $Divider.Visible = $true
    $Divider.Width = 1
    $Divider.Tag = $true
  }
}

function Set-HudParts($Parts, $PrefixLabel, $BatteryBox, $Divider1, $ResetLabel, $Divider2, $WeekLabel, $ExtraLabel) {
  $PrefixLabel.Text = $Parts.Prefix
  $PrefixLabel.ForeColor = $Parts.TextColor
  $PrefixLabel.Width = 48
  $PrefixLabel.Visible = $true
  $PrefixLabel.Tag = $true
  Set-HudBatteryImage $BatteryBox $Parts.Percent $Parts.Running
  Set-HudDivider $Divider1 $Parts.ResetValue
  Set-HudMetricLabel $ResetLabel $Parts.ResetValue $Parts.TextColor 52
  Set-HudDivider $Divider2 $Parts.WeekValue
  Set-HudMetricLabel $WeekLabel $Parts.WeekValue $Parts.TextColor 52
  Set-HudMetricLabel $ExtraLabel $Parts.ExtraText $Parts.TextColor
}

function Set-HudControlsVisible($Controls, [bool]$Visible) {
  foreach ($control in $Controls) {
    $control.Visible = $Visible
    $control.Tag = $Visible
  }
}

function Get-LabelTextWidth($Label) {
  if (-not $Label.Text) { return 0 }
  return [System.Windows.Forms.TextRenderer]::MeasureText(
    $Label.Text,
    $Label.Font,
    [System.Drawing.Size]::new(1000, 1000),
    [System.Windows.Forms.TextFormatFlags]::NoPadding
  ).Width
}

function Get-ControlLayoutWidth($Control) {
  # Control.Visible reads as $false while the form is still hidden, so track
  # the intended visibility in Tag to keep pre-show layout math correct.
  if ($Control.Tag -ne $true) { return 0 }
  $baseWidth = $Control.Width
  return $baseWidth + $Control.Margin.Left + $Control.Margin.Right
}

function Get-HudControlsWidth($Controls) {
  $width = 0
  foreach ($control in $Controls) {
    $width += Get-ControlLayoutWidth $control
  }
  return $width
}

function Resize-HudToContent {
  if ($Mode -eq "tray") { return }

  $oldRight = $form.Left + $form.Width
  $oldBottom = $form.Top + $form.Height
  $codexWidth = $(if ($script:codexRowVisible) { Get-HudControlsWidth $codexHudControls } else { 0 })
  $claudeWidth = $(if ($script:claudeRowVisible) { Get-HudControlsWidth $claudeHudControls } else { 0 })
  $contentWidth = [math]::Max($codexWidth, $claudeWidth)
  $desiredWidth = $panel.Padding.Left + $panel.Padding.Right +
    $contentWidth +
    1
  $desiredWidth = [math]::Max(150, [int][math]::Ceiling($desiredWidth))

  $bothRows = $script:codexRowVisible -and $script:claudeRowVisible
  $desiredHeight = [int]$(if ($bothRows) { $script:hudTwoRowHeight } else { $script:hudOneRowHeight })
  if ($bothRows) {
    $panel.RowStyles[0] = [System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Percent, 50)
    $panel.RowStyles[1] = [System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Percent, 50)
  } elseif ($script:claudeRowVisible) {
    $panel.RowStyles[0] = [System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Absolute, 0)
    $panel.RowStyles[1] = [System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Percent, 100)
  } else {
    $panel.RowStyles[0] = [System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Percent, 100)
    $panel.RowStyles[1] = [System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Absolute, 0)
  }

  if (([math]::Abs($form.Width - $desiredWidth) -gt 1) -or ($form.Height -ne $desiredHeight)) {
    $form.Width = $desiredWidth
    $form.Height = $desiredHeight
    $newX = if ($script:hudAnchorX -eq "right") { $oldRight - $form.Width } else { $form.Left }
    $newY = if ($script:hudAnchorY -eq "bottom") { $oldBottom - $form.Height } else { $form.Top }
    $form.Location = [System.Drawing.Point]::new([int]$newX, [int]$newY)
    Sync-HitFormBounds
    Save-HudPositionIfReady
  }
}

function Show-HudMessage([string]$Message) {
  $codexPrefixLabel.Text = $Message
  $codexPrefixLabel.ForeColor = [System.Drawing.Color]::FromArgb(145, 145, 145)
  $codexPrefixLabel.Width = (Get-LabelTextWidth $codexPrefixLabel) + 1
  $codexPrefixLabel.Visible = $true
  $codexPrefixLabel.Tag = $true
  foreach ($label in @($codexResetLabel, $codexWeekLabel, $codexExtraLabel, $claudePrefixLabel, $claudeResetLabel, $claudeWeekLabel, $claudeExtraLabel)) {
    $label.Text = ""
    $label.Width = 0
    $label.Visible = $false
    $label.Tag = $false
  }
  foreach ($divider in @($codexDivider1, $codexDivider2, $claudeDivider1, $claudeDivider2)) {
    $divider.Visible = $false
    $divider.Width = 0
    $divider.Tag = $false
  }
  Set-HudBatteryImage $codexIconLabel $null $false
  $oldImage = $claudeIconLabel.Image
  $claudeIconLabel.Image = $null
  $claudeIconLabel.Visible = $false
  $claudeIconLabel.Tag = $false
  if ($oldImage) { $oldImage.Dispose() }
  $script:codexRowVisible = $true
  $script:claudeRowVisible = $false
  $codexRow.Visible = $true
  $claudeRow.Visible = $false
  Resize-HudToContent
}

function Update-HudFromSnapshot($Snapshot) {
  if (-not $Snapshot) {
    Show-HudMessage "AI Battery starting..."
    Update-HudVisibilityForFullscreen
    return
  }

  try {
    $texts = ConvertTo-HudTexts $Snapshot
    $script:codexRowVisible = [bool]$texts.CodexVisible
    $script:claudeRowVisible = [bool]$texts.ClaudeVisible
    if ($texts.CodexVisible) {
      $codexRow.Visible = $true
      Set-HudParts $texts.Codex $codexPrefixLabel $codexIconLabel $codexDivider1 $codexResetLabel $codexDivider2 $codexWeekLabel $codexExtraLabel
    } else {
      $codexRow.Visible = $false
      Set-HudControlsVisible $codexHudControls $false
    }
    if ($texts.ClaudeVisible) {
      $claudeRow.Visible = $true
      Set-HudParts $texts.Claude $claudePrefixLabel $claudeIconLabel $claudeDivider1 $claudeResetLabel $claudeDivider2 $claudeWeekLabel $claudeExtraLabel
    } else {
      $claudeRow.Visible = $false
      Set-HudControlsVisible $claudeHudControls $false
    }
    Resize-HudToContent
  } catch {
    Show-HudMessage "AI Battery unavailable"
  }
  Update-HudVisibilityForFullscreen
}

function Invoke-HudPump {
  # Everything here must return quickly: this runs on the UI thread, and the
  # actual data fetch happens on a background runspace.
  if ($script:fetchPowerShell -and -not $script:fetchHandle.IsCompleted -and
      ([datetime]::UtcNow - $script:lastFetchStartUtc).TotalSeconds -gt 30) {
    Stop-SnapshotFetch
  }

  $fresh = Complete-SnapshotFetch
  if ($fresh) {
    $merged = Merge-HudSnapshot $fresh $script:latestSnapshot
    $script:latestSnapshot = $merged
    Write-HudSnapshot $merged
    Update-HudFromSnapshot $merged

    $missingWeekly = @($merged.results | Where-Object { $_.ok -and $null -ne $_.percentRemaining -and $null -eq $_.secondary })
    if ($missingWeekly.Count -gt 0 -and $script:weeklyRetryCount -lt 6) {
      $script:weeklyRetryCount += 1
      Start-SnapshotFetch
      return
    }
    $script:weeklyRetryCount = 0
    return
  }

  if (-not $script:fetchPowerShell -and
      ([datetime]::UtcNow - $script:lastFetchStartUtc).TotalSeconds -ge [math]::Max(1, $Interval)) {
    Start-SnapshotFetch
  }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({ Invoke-HudPump })
$topMostTimer = New-Object System.Windows.Forms.Timer
$topMostTimer.Interval = 1000
$topMostTimer.add_Tick({ Update-HudVisibilityForFullscreen })
$form.add_FormClosed({
  if ($canMove) {
    Write-HudPosition $form.Location
  }
  $timer.Stop()
  $timer.Dispose()
  $topMostTimer.Stop()
  $topMostTimer.Dispose()
  Stop-SnapshotFetch
  foreach ($box in @($codexIconLabel, $claudeIconLabel)) {
    if ($box.Image) {
      $box.Image.Dispose()
      $box.Image = $null
    }
  }
  $font.Dispose()
  $symbolFont.Dispose()
  if ($hitForm -and -not $hitForm.IsDisposed) {
    $hitForm.Close()
    $hitForm.Dispose()
  }
  Release-SingleInstance
})

$form.add_LocationChanged({
  # No position save here: writing the state file on every drag pixel causes
  # visible hitches. MouseUp and Resize-HudToContent persist the placement.
  Sync-HitFormBounds
})
$form.add_SizeChanged({ Sync-HitFormBounds })
$form.add_Shown({
  Show-HitForm
  Update-HudVisibilityForFullscreen
  Signal-HudReady
})

Set-Position
$script:positionSaveReady = $true

$diskSnapshot = Read-HudSnapshot
if ($script:initialHudSnapshot) {
  $script:latestSnapshot = Merge-HudSnapshot $script:initialHudSnapshot $diskSnapshot
  $script:initialHudSnapshot = $null
  Write-HudSnapshot $script:latestSnapshot
} else {
  $script:latestSnapshot = $diskSnapshot
}
Update-HudFromSnapshot $script:latestSnapshot
Start-SnapshotFetch
if ($Mode -eq "statusline" -or $ClickThrough) {
  $style = [AiBatteryNative]::GetWindowLong($form.Handle, [AiBatteryNative]::GWL_EXSTYLE)
  $style = $style -bor [AiBatteryNative]::WS_EX_TOOLWINDOW -bor [AiBatteryNative]::WS_EX_NOACTIVATE
  if ($ClickThrough) {
    $style = $style -bor [AiBatteryNative]::WS_EX_TRANSPARENT
  }
  [AiBatteryNative]::SetWindowLong($form.Handle, [AiBatteryNative]::GWL_EXSTYLE, $style) | Out-Null
}
$timer.Start()
$topMostTimer.Start()
[System.Windows.Forms.Application]::Run($form)
