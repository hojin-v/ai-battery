param(
  [int]$Interval = 5,
  [string]$Position = $(if ($env:AI_BATTERY_HUD_POSITION) { $env:AI_BATTERY_HUD_POSITION } elseif ($env:CLAUDEX_BATTERY_HUD_POSITION) { $env:CLAUDEX_BATTERY_HUD_POSITION } else { "saved" }),
  [ValidateSet("tray", "statusline", "floating")]
  [string]$Mode = $(if ($env:AI_BATTERY_HUD_MODE) { $env:AI_BATTERY_HUD_MODE } elseif ($env:CLAUDEX_BATTERY_HUD_MODE) { $env:CLAUDEX_BATTERY_HUD_MODE } else { "floating" }),
  [string]$BatteryCommand = $(if ($env:AI_BATTERY_COMMAND) { $env:AI_BATTERY_COMMAND } elseif ($env:CLAUDEX_BATTERY_COMMAND) { $env:CLAUDEX_BATTERY_COMMAND } else { "ai-battery --json" }),
  [string]$BatteryCommandBase64 = "",
  [string]$InitialJsonBase64 = "",
  [int]$Width = 282,
  [string]$Backdrop = $(if ($env:AI_BATTERY_HUD_BACKDROP) { $env:AI_BATTERY_HUD_BACKDROP } elseif ($env:CLAUDEX_BATTERY_HUD_BACKDROP) { $env:CLAUDEX_BATTERY_HUD_BACKDROP } else { "off" }),
  [string]$Text = $(if ($env:AI_BATTERY_HUD_TEXT) { $env:AI_BATTERY_HUD_TEXT } elseif ($env:CLAUDEX_BATTERY_HUD_TEXT) { $env:CLAUDEX_BATTERY_HUD_TEXT } else { "light" }),
  [string]$Transparent = "",
  [double]$Opacity = $(if ($env:AI_BATTERY_HUD_OPACITY) { [double]$env:AI_BATTERY_HUD_OPACITY } elseif ($env:CLAUDEX_BATTERY_HUD_OPACITY) { [double]$env:CLAUDEX_BATTERY_HUD_OPACITY } else { 1.0 }),
  [switch]$Locked,
  [switch]$Movable,
  [switch]$ClickThrough,
  [switch]$StopExisting,
  [switch]$UseWsl,
  [switch]$Once,
  [string]$ReadyPath = "",
  [Int64]$DockWindowHandle = 0,
  [Int64]$DockSession = 0,
  [int]$DockOwnerPid = 0,
  [ValidateSet("", "codex", "claude")]
  [string]$DockProvider = "",
  [string]$DockMarkerPath = "",
  [ValidateSet("bottom", "tabs")]
  [string]$DockPlacement = $(if ($env:AI_BATTERY_WIN_DOCK_POSITION) { $env:AI_BATTERY_WIN_DOCK_POSITION } elseif ($env:CLAUDEX_BATTERY_WIN_DOCK_POSITION) { $env:CLAUDEX_BATTERY_WIN_DOCK_POSITION } else { "bottom" })
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
if ($env:AI_BATTERY_HUD_DEBUG_LOG) { Add-Content $env:AI_BATTERY_HUD_DEBUG_LOG "boot dock=$DockWindowHandle placement=$DockPlacement once=$Once mode=$Mode" }

if (-not [string]::IsNullOrWhiteSpace($BatteryCommandBase64)) {
  try {
    $BatteryCommand = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($BatteryCommandBase64))
  } catch {
    # Fall back to BatteryCommand/env defaults; the HUD can still show an error row.
  }
}

$script:hudStopScanFailed = $false

function Stop-ExistingHudProcesses([bool]$DockedOnly = $false) {
  $script:hudStopScanFailed = $false
  $currentPid = $PID
  $hudProcesses = @()
  $dockHandlePattern = if ($DockWindowHandle -ne 0) {
    '-DockWindowHandle\s+[''"]?' + [regex]::Escape([string]$DockWindowHandle) + '(?:[''"]|\s|$)'
  } else {
    "-DockWindowHandle"
  }
  try {
    $hudProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop |
      Where-Object {
      $_.ProcessId -ne $currentPid -and
      $_.Name -match '^(powershell|pwsh)(\.exe)?$' -and
      $_.CommandLine -and
      $_.CommandLine -like "*ai-battery-hud.ps1*" -and
      $_.CommandLine -notlike "*Start-Process*" -and
      ($(if ($DockedOnly) { $_.CommandLine -match $dockHandlePattern } else { $_.CommandLine -notlike "*-DockWindowHandle*" }))
    })
  } catch {
    $script:hudStopScanFailed = $true
    if ($env:AI_BATTERY_HUD_DEBUG_LOG) {
      try { Add-Content $env:AI_BATTERY_HUD_DEBUG_LOG "stop scan unavailable: $($_.Exception.Message)" } catch { }
    }
    return
  }

  foreach ($hudProcess in $hudProcesses) {
    try {
      Stop-Process -Id $hudProcess.ProcessId -Force -ErrorAction Stop
      Wait-Process -Id $hudProcess.ProcessId -Timeout 3 -ErrorAction SilentlyContinue
    } catch {
      # The process may already have exited.
    }
  }
}

function Get-HudDockRequestPath {
  $root = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "ai-battery"
  } else {
    Join-Path $env:TEMP "ai-battery"
  }
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $name = if ($DockWindowHandle -ne 0) { "tui-dock-request-$DockWindowHandle.json" } else { "hud-dock-request.json" }
  return Join-Path $root $name
}

function Get-HudDockHostPath {
  $root = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "ai-battery" } else { Join-Path $env:TEMP "ai-battery" }
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  return Join-Path $root "tui-dock-host-$DockWindowHandle.json"
}

function Write-HudDockHostMarker {
  if ($DockWindowHandle -eq 0) { return }
  try {
    $targetDpi = 0
    $formDpi = 0
    try { $targetDpi = [int][AiBatteryNative]::GetDpiForWindow([IntPtr]::new([Int64]$DockWindowHandle)) } catch { }
    try { if ($form -and $form.Handle -ne [IntPtr]::Zero) { $formDpi = [int][AiBatteryNative]::GetDpiForWindow($form.Handle) } } catch { }
    $marker = @{
      pid = $PID
      hwnd = [Int64]$DockWindowHandle
      at = [datetime]::UtcNow.ToString("o")
      dpiAwareness = [string]$script:hudDpiAwareness
      targetDpi = $targetDpi
      formDpi = $formDpi
      hudDpi = [int]$script:hudDpi
      stripHeight = [int]$script:dockStripHeight
      formHeight = if ($form) { [int]$form.Height } else { 0 }
    } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText((Get-HudDockHostPath), $marker, [System.Text.UTF8Encoding]::new($false))
  } catch { }
}

function Remove-HudDockHostMarker {
  if ($DockWindowHandle -eq 0) { return }
  $path = Get-HudDockHostPath
  try {
    if (Test-Path -LiteralPath $path) {
      $marker = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
      if ([int]$marker.pid -eq $PID) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    }
  } catch { }
}

function Request-HudStop {
  $requestPath = Get-HudDockRequestPath
  try {
    $request = @{ stop = $true; at = [datetime]::UtcNow.ToString("o") } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($requestPath, $request, [System.Text.UTF8Encoding]::new($false))
  } catch {
    return
  }

  for ($wait = 0; $wait -lt 40; $wait += 1) {
    Start-Sleep -Milliseconds 150
    if (-not (Test-Path -LiteralPath $requestPath)) { return }
  }
  Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
}

if ($StopExisting) {
  Request-HudStop
  Start-Sleep -Milliseconds 400
  Stop-ExistingHudProcesses
  if (-not $Once) {
    exit 0
  }
} elseif (-not $Once -and $DockWindowHandle -eq 0) {
  # Dock launches must never kill a running HUD: they hand the new dock
  # target to it via the request file below instead.
  Stop-ExistingHudProcesses
}

$script:singleInstanceMutex = $null
if (-not $Once) {
  # A replaced instance we just stopped can hold the mutex handle for a
  # moment after Stop-Process returns; retry briefly before treating the
  # mutex owner as a genuinely running HUD.
  $createdNew = $false
  $mutexAttempts = if ($DockWindowHandle -ne 0) { 3 } else { 20 }
  for ($mutexAttempt = 0; $mutexAttempt -lt $mutexAttempts; $mutexAttempt += 1) {
    $mutexName = if ($DockWindowHandle -ne 0) { "Local\AiBatteryTuiStatusline_$DockWindowHandle" } else { "Local\AiBatteryHud" }
    $script:singleInstanceMutex = [System.Threading.Mutex]::new($true, $mutexName, [ref]$createdNew)
    if ($createdNew) { break }
    $script:singleInstanceMutex.Dispose()
    $script:singleInstanceMutex = $null
    Start-Sleep -Milliseconds 150
  }
  if (-not $createdNew -and $DockWindowHandle -ne 0) {
    # A HUD is already running: ask it to adopt this dock target.
    $requestPath = Get-HudDockRequestPath
    $requestWritten = $false
    try {
      $request = @{
        hwnd = [Int64]$DockWindowHandle
        placement = $DockPlacement
        session = [Int64]$DockSession
        ownerPid = [int]$DockOwnerPid
        provider = $DockProvider
        markerPath = $DockMarkerPath
        at = [datetime]::UtcNow.ToString("o")
      } | ConvertTo-Json -Compress
      [System.IO.File]::WriteAllText($requestPath, $request, [System.Text.UTF8Encoding]::new($false))
      $requestWritten = $true
    } catch {
      # If the request cannot be written, fall through to the takeover check.
    }

    # A healthy HUD (docked or floating) consumes the request within a tick or
    # two. If it is still on disk the mutex owner is a zombie (e.g. an
    # orphaned instance from a killed session): replace it.
    $consumed = $false
    if ($requestWritten) {
      for ($wait = 0; $wait -lt 14; $wait += 1) {
        Start-Sleep -Milliseconds 150
        if (-not (Test-Path -LiteralPath $requestPath)) { $consumed = $true; break }
      }
    }
    if (-not $consumed) {
      Stop-ExistingHudProcesses $true
      Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
      for ($mutexAttempt = 0; $mutexAttempt -lt 20; $mutexAttempt += 1) {
        $script:singleInstanceMutex = [System.Threading.Mutex]::new($true, $mutexName, [ref]$createdNew)
        if ($createdNew) { break }
        $script:singleInstanceMutex.Dispose()
        $script:singleInstanceMutex = $null
        Start-Sleep -Milliseconds 150
      }
    }
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

. (Join-Path $PSScriptRoot "native.ps1")

. (Join-Path $PSScriptRoot "snapshot.ps1")

if ($Once) {
  $texts = Get-Texts
  if ($texts.CodexVisible) { Write-Output "$($texts.Codex.Prefix)[battery]$($texts.Codex.Suffix)" }
  if ($texts.ClaudeVisible) { Write-Output "$($texts.Claude.Prefix)[battery]$($texts.Claude.Suffix)" }
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try {
  [System.Windows.Forms.Application]::SetHighDpiMode([System.Windows.Forms.HighDpiMode]::PerMonitorV2) | Out-Null
} catch {
  # Windows PowerShell/.NET Framework does not expose SetHighDpiMode; the
  # native DPI awareness call above covers that runtime.
}
[System.Windows.Forms.Application]::EnableVisualStyles()
try {
  [System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)
} catch {
  # The default is already GDI text rendering on older WinForms.
}

. (Join-Path $PSScriptRoot "rendering.ps1")

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

$script:dockTuiStatusline = ($DockWindowHandle -ne 0)
$script:dockPlacementMode = $DockPlacement
$script:dockStripHeight = if ($script:dockTuiStatusline) { Scale-HudValue 20 } else { 0 }
$script:dockJoinOverlap = if ($script:dockTuiStatusline -and $script:dockPlacementMode -eq "bottom") { [math]::Max(1, (Scale-HudValue 8)) } else { 0 }
$script:dockHorizontalInset = 0
$script:dockLeftOpticalInset = 1
$script:dockSquareCorners = $false
$script:dockTuiResponsiveLayoutName = ""
$script:dockTuiResponsiveThresholds = ""
$script:dockOuterBorderColor = [System.Drawing.Color]::FromArgb(72, 72, 72)
$form = New-Object System.Windows.Forms.Form
$form.Text = "AI Battery"
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Width = Scale-HudValue $Width
$form.Height = if ($script:dockTuiStatusline) { $script:dockStripHeight + $script:dockJoinOverlap } elseif ($Mode -eq "floating") { Scale-HudValue 44 } elseif ($Mode -eq "statusline") { Scale-HudValue 44 } else { Scale-HudValue 54 }
$script:hudTwoRowHeight = $form.Height
$script:hudOneRowHeight = [math]::Max((Scale-HudValue 20), $form.Height - (Scale-HudValue 18))
$form.TopMost = ($DockWindowHandle -eq 0)
$form.ShowInTaskbar = $false
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.Padding = [System.Windows.Forms.Padding]::new(0)
$script:hudTransparentSurface = if ($script:dockTuiStatusline) { $false } else { Test-HudTransparentSurface }
$script:hudContrastBackdrop = Test-HudContrastBackdrop
$script:hudChromeBackColor = if ($script:dockTuiStatusline) {
  [System.Drawing.Color]::FromArgb(12, 12, 12)
} else {
  [System.Drawing.Color]::FromArgb(24, 24, 24)
}
if ($script:hudTransparentSurface) {
  $transparentBackColor = if ($script:hudDarkText -and (-not $script:hudContrastBackdrop)) {
    [System.Drawing.Color]::FromArgb(254, 254, 254)
  } else {
    [System.Drawing.Color]::FromArgb(18, 18, 18)
  }
  $form.BackColor = $transparentBackColor
  $form.TransparencyKey = $transparentBackColor
} else {
  $form.BackColor = $script:hudChromeBackColor
}
$script:hudSurfaceBackColor = if ($script:hudContrastBackdrop -or (-not $script:hudTransparentSurface)) {
  $script:hudChromeBackColor
} else {
  $form.BackColor
}
$form.Opacity = if ($script:dockTuiStatusline) {
  1.0
} else {
  [math]::Max(0.2, [math]::Min(1.0, $Opacity))
}

function New-HudMainFont {
  if ($script:dockTuiStatusline) {
    # Use explicit physical pixels for the dock strip. Windows PowerShell's
    # WinForms host otherwise keeps the 96-DPI font after a monitor move.
    return [System.Drawing.Font]::new(
      "Cascadia Mono",
      [single](Scale-HudValue 12),
      [System.Drawing.FontStyle]::Regular,
      [System.Drawing.GraphicsUnit]::Pixel
    )
  }
  return [System.Drawing.Font]::new("Segoe UI", $(if ($Mode -eq "statusline") { 8.5 } else { 9 }), [System.Drawing.FontStyle]::Regular)
}

function New-HudSymbolFont {
  if ($script:dockTuiStatusline) {
    return [System.Drawing.Font]::new(
      "Cascadia Mono",
      [single](Scale-HudValue 16),
      [System.Drawing.FontStyle]::Regular,
      [System.Drawing.GraphicsUnit]::Pixel
    )
  }
  return [System.Drawing.Font]::new("Cascadia Mono", $(if ($Mode -eq "statusline") { 11.5 } else { 12 }), [System.Drawing.FontStyle]::Regular)
}

$font = New-HudMainFont
$symbolFont = New-HudSymbolFont

$panel = New-Object System.Windows.Forms.TableLayoutPanel
$panel.Dock = [System.Windows.Forms.DockStyle]::Fill
$panel.RowCount = $(if ($script:dockTuiStatusline) { 1 } else { 2 })
$panel.ColumnCount = 1
$panel.GrowStyle = [System.Windows.Forms.TableLayoutPanelGrowStyle]::FixedSize
$panel.Padding = if ($script:dockTuiStatusline) {
  New-HudPadding 8 2 2 2
} elseif ($Mode -eq "floating" -or $Mode -eq "statusline") {
  New-HudPadding 6 4 2 3
} else {
  New-HudPadding 10 7 10 6
}
$panel.BackColor = $script:hudSurfaceBackColor
$panel.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Percent, $(if ($script:dockTuiStatusline) { 100 } else { 50 }))) | Out-Null
if (-not $script:dockTuiStatusline) {
  $panel.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Percent, 50)) | Out-Null
}
$panel.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 100)) | Out-Null

function New-HudRow {
  $row = New-Object System.Windows.Forms.FlowLayoutPanel
  $row.Dock = [System.Windows.Forms.DockStyle]::Fill
  $row.FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
  $row.WrapContents = $false
  $row.Margin = [System.Windows.Forms.Padding]::new(0)
  $row.Padding = [System.Windows.Forms.Padding]::new(0)
  $row.BackColor = $script:hudSurfaceBackColor
  return $row
}

function New-HudLabel([int]$RightMargin = 0) {
  $label = New-Object System.Windows.Forms.Label
  $label.AutoSize = $false
  $label.Width = 0
  $label.Height = Scale-HudValue 18
  $label.Font = $font
  $label.UseCompatibleTextRendering = $false
  $label.BackColor = $script:hudSurfaceBackColor
  $label.Margin = New-HudPadding 0 0 $RightMargin 0
  $label.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
  return $label
}

function New-HudIconBox {
  $box = New-Object System.Windows.Forms.PictureBox
  $box.Width = Scale-HudValue 40
  $box.Height = Scale-HudValue 18
  $box.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
  $box.BackColor = $script:hudSurfaceBackColor
  $box.ForeColor = Get-HudBatteryTextColor $true
  $box.Margin = New-HudPadding 0 0 2 0
  $box.add_Paint({
    param($sender, $event)
    $text = [string]$sender.AccessibleName
    if ([string]::IsNullOrWhiteSpace($text)) { return }

    $drawFont = $null
    $disposeDrawFont = $false
    try {
      $drawFont = $font
      if (-not $drawFont) {
        $drawFont = [System.Drawing.Font]::new("Segoe UI", 9, [System.Drawing.FontStyle]::Regular)
        $disposeDrawFont = $true
      }
      $rect = [System.Drawing.Rectangle]::new(
        (Scale-HudValue 2),
        0,
        [math]::Max(1, $sender.Width - (Scale-HudValue 4)),
        $sender.Height
      )
      $flags = [System.Windows.Forms.TextFormatFlags]::HorizontalCenter -bor
        [System.Windows.Forms.TextFormatFlags]::VerticalCenter -bor
        [System.Windows.Forms.TextFormatFlags]::SingleLine -bor
        [System.Windows.Forms.TextFormatFlags]::NoPadding
      [System.Windows.Forms.TextRenderer]::DrawText($event.Graphics, $text, $drawFont, $rect, $sender.ForeColor, $flags)
    } finally {
      if ($disposeDrawFont -and $drawFont) { $drawFont.Dispose() }
    }
  })
  return $box
}

function New-HudLineIconBox {
  $box = New-Object System.Windows.Forms.PictureBox
  $box.Width = Scale-HudValue 21
  $box.Height = Scale-HudValue 18
  $box.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::CenterImage
  $box.BackColor = $script:hudSurfaceBackColor
  $box.Margin = New-HudPadding 3 0 0 0
  return $box
}

function New-HudDivider {
  $divider = New-Object System.Windows.Forms.Panel
  $divider.AutoSize = $false
  $divider.Width = Scale-HudValue 1
  $divider.Height = Scale-HudValue 12
  $divider.BackColor = Get-DividerColor
  $divider.Margin = New-HudPadding 4 3 4 3
  return $divider
}

function Draw-TuiSegment($Graphics, [string]$Value, $Color, [ref]$X, [int]$Y, $DrawFont) {
  if ([string]::IsNullOrEmpty($Value)) { return }
  $flags = [System.Windows.Forms.TextFormatFlags]::NoPadding -bor
    [System.Windows.Forms.TextFormatFlags]::NoPrefix -bor
    [System.Windows.Forms.TextFormatFlags]::SingleLine
  [System.Windows.Forms.TextRenderer]::DrawText(
    $Graphics,
    $Value,
    $DrawFont,
    [System.Drawing.Point]::new([int]$X.Value, $Y),
    $Color,
    $flags
  )
  $size = [System.Windows.Forms.TextRenderer]::MeasureText(
    $Value,
    $DrawFont,
    [System.Drawing.Size]::new(4096, 64),
    $flags
  )
  $X.Value = [int]$X.Value + [int]$size.Width
}

function Get-TuiTextWidth([string]$Value, $DrawFont) {
  if ([string]::IsNullOrEmpty($Value)) { return 0 }
  $flags = [System.Windows.Forms.TextFormatFlags]::NoPadding -bor
    [System.Windows.Forms.TextFormatFlags]::NoPrefix -bor
    [System.Windows.Forms.TextFormatFlags]::SingleLine
  $size = [System.Windows.Forms.TextRenderer]::MeasureText(
    $Value,
    $DrawFont,
    [System.Drawing.Size]::new(4096, 64),
    $flags
  )
  return [int]$size.Width
}

function Get-TuiProviderDisplayValues($Result, [string]$Name, [int]$BarWidth, [bool]$ShowWindows) {
  $percent = if ($Result -and $Result.ok -and $null -ne $Result.percentRemaining) { [int]$Result.percentRemaining } else { $null }
  $values = [ordered]@{
    Prefix = $Name + " "
    Bar = ([string][char]0x275A) * $BarWidth
    Percent = $(if ($null -ne $percent) { " $percent%" } else { " --%" })
    Primary = ""
    Secondary = ""
  }
  if ($ShowWindows -and $Result -and $Result.primary) {
    $values.Primary = "$(Get-WindowText $Result.primary.windowMinutes)  $(Get-ResetClock $Result.primary)"
  }
  if ($ShowWindows -and $Result -and $Result.secondary) {
    $values.Secondary = "$(Get-WindowText $Result.secondary.windowMinutes)  $([int]$Result.secondary.remainingPercent)%"
    if ($Result.secondary.remainingPercent -le 10 -and -not $Result.secondary.resetPassed) {
      $values.Secondary += " $(Get-ResetClock $Result.secondary)"
    }
  }
  return [PSCustomObject]$values
}

function Get-TuiProviderDisplayWidth($Result, [string]$Name, $DrawFont, [int]$BarWidth, [bool]$ShowWindows) {
  $values = Get-TuiProviderDisplayValues $Result $Name $BarWidth $ShowWindows
  $width = (Get-TuiTextWidth $values.Prefix $DrawFont) +
    (Get-TuiTextWidth $values.Bar $DrawFont) +
    (Get-TuiTextWidth $values.Percent $DrawFont)
  $metricDivider = "  $([char]0x2502)  "
  if ($values.Primary) {
    $width += (Get-TuiTextWidth $metricDivider $DrawFont) + (Get-TuiTextWidth $values.Primary $DrawFont)
  }
  if ($values.Secondary) {
    $width += (Get-TuiTextWidth $metricDivider $DrawFont) + (Get-TuiTextWidth $values.Secondary $DrawFont)
  }
  return $width
}

function Get-DockedTuiResponsiveLayout($Codex, $Claude, $DrawFont, [int]$AvailableWidth) {
  # Preserve time-window information first, then trade bar length for it. Once
  # the windows no longer fit, return to a full ten-cell provider summary; that
  # summary still fits at Windows Terminal's minimum practical width.
  $candidates = @(
    [PSCustomObject]@{ Name = "full"; BarWidth = 10; ShowWindows = $true },
    [PSCustomObject]@{ Name = "metrics-half"; BarWidth = 5; ShowWindows = $true },
    [PSCustomObject]@{ Name = "summary-full"; BarWidth = 10; ShowWindows = $false }
  )
  $providerDividerWidth = if ($Codex -and $Claude) { Get-TuiTextWidth "  $([char]0x2503)  " $DrawFont } else { 0 }
  $requiredWidths = @()
  foreach ($candidate in $candidates) {
    $required = $providerDividerWidth
    if ($Codex) {
      $required += Get-TuiProviderDisplayWidth $Codex "Codex" $DrawFont $candidate.BarWidth $candidate.ShowWindows
    }
    if ($Claude) {
      $required += Get-TuiProviderDisplayWidth $Claude "Claude" $DrawFont $candidate.BarWidth $candidate.ShowWindows
    }
    $requiredWidths += $required
  }

  # The five-cell variants only save about 50 physical pixels for two
  # providers. Pure fit-based selection therefore makes those stages nearly
  # impossible to see while resizing. Give every density a useful interval,
  # while never selecting a layout below the width it actually requires.
  $fullThreshold = [int][math]::Ceiling($requiredWidths[0] * 1.08)
  $metricsHalfThreshold = [math]::Max($requiredWidths[1], [int][math]::Ceiling($requiredWidths[0] * 0.98))
  $script:dockTuiResponsiveThresholds = "$fullThreshold,$metricsHalfThreshold"
  if ($AvailableWidth -ge $fullThreshold) { return $candidates[0] }
  if ($AvailableWidth -ge $metricsHalfThreshold) { return $candidates[1] }
  return $candidates[2]
}

function Draw-TuiProvider($Graphics, $Result, [string]$Name, [ref]$X, [int]$Y, $DrawFont, $Layout) {
  $running = Get-DockedTuiProviderRunning $Result $Name
  $textColor = if ($running) { [System.Drawing.Color]::FromArgb(255, 255, 255) } else { [System.Drawing.Color]::FromArgb(125, 125, 125) }
  $dividerColor = [System.Drawing.Color]::FromArgb(105, 105, 105)
  $percent = if ($Result -and $Result.ok -and $null -ne $Result.percentRemaining) { [int]$Result.percentRemaining } else { $null }
  $clamped = if ($null -ne $percent) { [math]::Max(0, [math]::Min(100, $percent)) } else { 0 }
  $barWidth = [math]::Max(1, [int]$Layout.BarWidth)
  $filled = if ($null -ne $percent) { [int][math]::Round(($clamped / 100.0) * $barWidth) } else { 0 }
  if ($clamped -gt 0 -and $filled -eq 0) { $filled = 1 }
  $barGlyph = [string][char]0x275A
  $values = Get-TuiProviderDisplayValues $Result $Name $barWidth ([bool]$Layout.ShowWindows)

  Draw-TuiSegment $Graphics $values.Prefix $textColor $X $Y $DrawFont
  $barStart = [int]$X.Value
  Draw-TuiSegment $Graphics $values.Bar ([System.Drawing.Color]::FromArgb(82, 82, 82)) $X $Y $DrawFont
  if ($filled -gt 0) {
    $overlayValue = $barStart
    $overlayX = [ref]$overlayValue
    Draw-TuiSegment $Graphics ($barGlyph * $filled) (Get-PercentColor $percent) $overlayX $Y $DrawFont
  }
  Draw-TuiSegment $Graphics $values.Percent $textColor $X $Y $DrawFont

  if ($values.Primary) {
    Draw-TuiSegment $Graphics "  $([char]0x2502)  " $dividerColor $X $Y $DrawFont
    Draw-TuiSegment $Graphics $values.Primary $textColor $X $Y $DrawFont
  }
  if ($values.Secondary) {
    Draw-TuiSegment $Graphics "  $([char]0x2502)  " $dividerColor $X $Y $DrawFont
    Draw-TuiSegment $Graphics $values.Secondary $textColor $X $Y $DrawFont
  }
}

function Get-DockedTuiProviderRunning($Result, [string]$Name) {
  if ($script:dockTuiStatusline -and $script:dockSessionTrackingEnabled) {
    return Test-DockProviderActiveForTarget $Name ([Int64]$script:dockTargetHandle)
  }
  return [bool]($Result -and $Result.running)
}

function Draw-DockedTuiStatusline($Graphics, [int]$Width, [int]$Height) {
  $snapshot = $script:latestSnapshot
  if (-not $snapshot -or -not $snapshot.results) { return }
  $codex = Get-Provider $snapshot "codex"
  $claude = Get-Provider $snapshot "claude"
  $xValue = Scale-HudValue 15
  $x = [ref]$xValue
  $rightPadding = Scale-HudValue 10
  $availableWidth = [math]::Max(1, $Width - $xValue - $rightPadding)
  $layout = Get-DockedTuiResponsiveLayout $codex $claude $font $availableWidth
  if ($script:dockTuiResponsiveLayoutName -ne $layout.Name) {
    $script:dockTuiResponsiveLayoutName = $layout.Name
    if (Get-Command Write-HudDockDebug -ErrorAction SilentlyContinue) {
      Write-HudDockDebug "dock responsive layout -> $($layout.Name) width=$availableWidth thresholds=$script:dockTuiResponsiveThresholds"
    }
  }
  $visibleTop = [math]::Max(0, [int]$script:dockJoinOverlap - (Scale-HudValue 2))
  $visibleHeight = [math]::Max(1, $Height - $visibleTop)
  $y = $visibleTop + [math]::Max(0, [int][math]::Floor(($visibleHeight - $font.Height) / 2) - 1)
  if ($codex) { Draw-TuiProvider $Graphics $codex "Codex" $x $y $font $layout }
  if ($codex -and $claude) {
    Draw-TuiSegment $Graphics "  $([char]0x2503)  " ([System.Drawing.Color]::FromArgb(150, 150, 150)) $x $y $font
  }
  if ($claude) { Draw-TuiProvider $Graphics $claude "Claude" $x $y $font $layout }
}

$script:dockTuiRenderKey = $null

function Get-DockedTuiRenderKey($Snapshot) {
  if (-not $Snapshot -or -not $Snapshot.results) { return "empty" }
  $parts = @()
  foreach ($name in @("codex", "claude")) {
    $result = Get-Provider $Snapshot $name
    if (-not $result) { $parts += "$name`:missing"; continue }
    $primary = if ($result.primary) {
      "$(Get-WindowText $result.primary.windowMinutes):$(Get-ResetClock $result.primary)"
    } else { "" }
    $secondary = if ($result.secondary) {
      "$($result.secondary.windowMinutes):$($result.secondary.remainingPercent):$($result.secondary.resetPassed):$(Get-ResetClock $result.secondary)"
    } else { "" }
    $running = Get-DockedTuiProviderRunning $result $name
    $parts += "$name`:$running`:$($result.ok):$($result.percentRemaining):$primary`:$secondary"
  }
  return $parts -join "|"
}

function Invalidate-DockedTuiIfChanged($Snapshot) {
  if (-not $script:dockTuiPaintPanel) { return }
  $nextKey = Get-DockedTuiRenderKey $Snapshot
  if ($script:dockTuiRenderKey -eq $nextKey) { return }
  $script:dockTuiRenderKey = $nextKey
  $script:dockTuiPaintPanel.Invalidate()
}

function Draw-DockedTuiOuterBorder($Graphics, [int]$Width, [int]$Height) {
  if (-not (Test-DockBottomPlacement) -or $Width -lt 4 -or $Height -lt 4) { return }
  $radius = [math]::Min((Scale-HudValue 8), [math]::Floor(($Height - 1) / 2))
  $left = [single]0.5
  $right = [single]($Width - 0.5)
  $bottom = [single]($Height - 0.5)
  $arcTop = [single]($Height - ($radius * 2) + 0.5)
  $arcDiameter = [single](($radius * 2) - 1)
  $rightArcLeft = [single]($Width - ($radius * 2) + 0.5)
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $pen = [System.Drawing.Pen]::new($script:dockOuterBorderColor, 0.5)
  try {
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    # The terminal covers the open top edge. Only the three exposed edges are
    # painted so the overlap cannot create a horizontal join line.
    $path.StartFigure()
    if ($script:dockSquareCorners) {
      $path.AddLine($left, [single]0, $left, $bottom)
      $path.AddLine($left, $bottom, $right, $bottom)
      $path.AddLine($right, $bottom, $right, [single]0)
    } else {
      $path.AddLine($left, [single]0, $left, [single]($Height - $radius))
      $path.AddArc($left, $arcTop, $arcDiameter, $arcDiameter, 180, -90)
      $path.AddLine([single]$radius, $bottom, [single]($Width - $radius), $bottom)
      $path.AddArc($rightArcLeft, $arcTop, $arcDiameter, $arcDiameter, 90, -90)
      $path.AddLine($right, [single]($Height - $radius), $right, [single]0)
    }
    $Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $Graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::GammaCorrected
    $Graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $Graphics.DrawPath($pen, $path)
  } finally {
    $pen.Dispose()
    $path.Dispose()
  }
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
$providerDivider = New-HudDivider
$providerDivider.Margin = New-HudPadding 8 3 8 3

foreach ($label in @($codexPrefixLabel, $claudePrefixLabel)) {
  $label.AutoSize = $false
  $label.Width = Scale-HudValue 48
}
foreach ($label in @($codexIconLabel, $claudeIconLabel)) {
  $label.Width = Scale-HudValue 42
}

$codexHudControls = @($codexPrefixLabel, $codexIconLabel, $codexDivider1, $codexResetLabel, $codexDivider2, $codexWeekLabel, $codexExtraLabel)
$claudeHudControls = @($claudePrefixLabel, $claudeIconLabel, $claudeDivider1, $claudeResetLabel, $claudeDivider2, $claudeWeekLabel, $claudeExtraLabel)

function Test-PointInBounds($Bounds, [System.Drawing.Point]$Point) {
  if (-not $Bounds) { return $false }
  return $Bounds.Contains($Point)
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Font = $font
$menu.AutoClose = $true
$script:hudMenuOpenedAt = [datetime]::UtcNow
$script:hudMenuLastInsideAt = [datetime]::UtcNow
$script:hudMenuReadyForOutsideClick = $false
$exitItem = $menu.Items.Add("Exit")
$exitItem.add_Click({ $form.Close() })
$menu.add_Opened({
  $script:hudMenuOpenedAt = [datetime]::UtcNow
  $script:hudMenuLastInsideAt = [datetime]::UtcNow
  $script:hudMenuReadyForOutsideClick = $false
})
function Hide-HudMenu {
  if ($menu -and -not $menu.IsDisposed -and $menu.Visible) {
    $menu.Close([System.Windows.Forms.ToolStripDropDownCloseReason]::CloseCalled)
  }
}
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
$providerDivider.ContextMenuStrip = $menu
$script:dockCombinedRow = $null
$script:dockTuiPaintPanel = $null
if ($script:dockTuiStatusline) {
  $script:dockTuiPaintPanel = New-Object System.Windows.Forms.Panel
  $script:dockTuiPaintPanel.Dock = [System.Windows.Forms.DockStyle]::Fill
  $script:dockTuiPaintPanel.Margin = [System.Windows.Forms.Padding]::new(0)
  $script:dockTuiPaintPanel.BackColor = [System.Drawing.Color]::FromArgb(12, 12, 12)
  $script:dockTuiPaintPanel.ContextMenuStrip = $menu
  try {
    $doubleBuffered = $script:dockTuiPaintPanel.GetType().GetProperty(
      "DoubleBuffered",
      ([System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic)
    )
    if ($doubleBuffered) { $doubleBuffered.SetValue($script:dockTuiPaintPanel, $true, $null) }
  } catch { }
  $script:dockTuiPaintPanel.add_Paint({
    param($sender, $event)
    Draw-DockedTuiStatusline $event.Graphics $sender.Width $sender.Height
    Draw-DockedTuiOuterBorder $event.Graphics $sender.Width $sender.Height
  })
} else {
  $panel.Controls.Add($codexRow, 0, 0) | Out-Null
  $panel.Controls.Add($claudeRow, 0, 1) | Out-Null
}
if ($script:dockTuiStatusline) {
  $form.Controls.Add($script:dockTuiPaintPanel)
} else {
  $form.Controls.Add($panel)
}

$hitForm = $null
if ((-not $ClickThrough) -and $script:hudTransparentSurface) {
  $hitForm = New-Object System.Windows.Forms.Form
  $hitForm.Text = "AI Battery hit area"
  $hitForm.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
  $hitForm.Width = $form.Width
  $hitForm.Height = $form.Height
  $hitForm.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $hitForm.ShowInTaskbar = $false
  $hitForm.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $hitForm.BackColor = [System.Drawing.Color]::Black
  $hitForm.Opacity = 0.01
  $hitForm.TopMost = ($DockWindowHandle -eq 0)
  $hitForm.ContextMenuStrip = $menu
}

function Sync-HitFormBounds {
  if (-not $hitForm -or $hitForm.IsDisposed) { return }
  $hitForm.Bounds = [System.Drawing.Rectangle]::new($form.Left, $form.Top, $form.Width, $form.Height)
}

function Set-DockedTuiWindowRegion {
  if (-not $script:dockTuiStatusline -or -not $form -or $form.IsDisposed) { return }
  if ($form.Region) {
    $oldRegion = $form.Region
    $form.Region = $null
    $oldRegion.Dispose()
  }
  $rounded = if (Test-DockBottomPlacement) { [AiBatteryNative]::DWMWCP_DONOTROUND } else { [AiBatteryNative]::DWMWCP_ROUND }
  $ncRendering = if ($script:dockSquareCorners) { [AiBatteryNative]::DWMNCRP_DISABLED } else { [AiBatteryNative]::DWMNCRP_USEWINDOWSTYLE }
  $noBorder = [AiBatteryNative]::DWMWA_COLOR_NONE
  try {
    [AiBatteryNative]::DwmSetWindowAttribute($form.Handle, [AiBatteryNative]::DWMWA_WINDOW_CORNER_PREFERENCE, [ref]$rounded, 4) | Out-Null
    [AiBatteryNative]::DwmSetWindowAttribute($form.Handle, [AiBatteryNative]::DWMWA_BORDER_COLOR, [ref]$noBorder, 4) | Out-Null
    [AiBatteryNative]::DwmSetWindowAttribute($form.Handle, [AiBatteryNative]::DWMWA_NCRENDERING_POLICY, [ref]$ncRendering, 4) | Out-Null
  } catch { }
  if (Test-DockBottomPlacement -and -not $script:dockSquareCorners) {
    $radius = [math]::Min((Scale-HudValue 8), [math]::Floor($form.Height / 2))
    $diameter = $radius * 2
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    try {
      # A square top removes the sliver between the two HWNDs. The exposed
      # bottom keeps the same rounded silhouette as Windows Terminal.
      $path.StartFigure()
      $path.AddLine(0, 0, $form.Width, 0)
      $path.AddLine($form.Width, 0, $form.Width, ($form.Height - $radius))
      $path.AddArc(($form.Width - $diameter), ($form.Height - $diameter), $diameter, $diameter, 0, 90)
      $path.AddLine(($form.Width - $radius), $form.Height, $radius, $form.Height)
      $path.AddArc(0, ($form.Height - $diameter), $diameter, $diameter, 90, 90)
      $path.AddLine(0, ($form.Height - $radius), 0, 0)
      $path.CloseFigure()
      $form.Region = [System.Drawing.Region]::new($path)
    } finally {
      $path.Dispose()
    }
  }
}

function Show-HitForm {
  if (-not $hitForm -or $hitForm.IsDisposed) { return }
  Sync-HitFormBounds
  if (-not $hitForm.Visible) {
    $hitForm.Show()
  }
  $style = [AiBatteryNative]::GetWindowLong($hitForm.Handle, [AiBatteryNative]::GWL_EXSTYLE)
  $style = $style -bor [AiBatteryNative]::WS_EX_TOOLWINDOW -bor [AiBatteryNative]::WS_EX_NOACTIVATE
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
# A docked HUD is glued to its terminal window; dragging and position saving
# are floating-mode concepts.
$canMove = ($DockWindowHandle -eq 0) -and ($Movable -or (($Mode -eq "floating") -and (-not $Locked)))
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

. (Join-Path $PSScriptRoot "windowing.ps1")

. (Join-Path $PSScriptRoot "dock.ps1")
Initialize-HudDockResizeGrip

$script:fullscreenClearCount = 0

function Update-HudVisibilityForFullscreen {
  if (-not $form -or $form.IsDisposed) { return }
  if ($script:dockTuiStatusline) {
    # The docked strip is part of the terminal UI. Maximize/fullscreen/snap
    # layouts are repaired by Update-HudDockPlacement instead of hiding it.
    Set-HudHiddenForFullscreen $false
    return
  }
  if (Test-FullscreenOnHudMonitor) {
    $script:fullscreenClearCount = 0
    Set-HudHiddenForFullscreen $true
    return
  }
  if ($script:hudHiddenForFullscreen) {
    $script:fullscreenClearCount += 1
    if ($script:fullscreenClearCount -lt 2) { return }
  }
  $script:fullscreenClearCount = 0
  Set-HudHiddenForFullscreen $false
  Ensure-HudTopMost
}

$script:fullscreenCheckPending = $false

function Update-HudMenuAutoHide {
  if (-not $menu -or $menu.IsDisposed -or -not $menu.Visible) { return }
  $now = [datetime]::UtcNow
  $point = [System.Windows.Forms.Cursor]::Position
  $insideMenu = Test-PointInBounds $menu.Bounds $point
  $insideHud = Test-PointInBounds $form.Bounds $point
  if ($hitForm -and -not $hitForm.IsDisposed) {
    $insideHud = $insideHud -or (Test-PointInBounds $hitForm.Bounds $point)
  }

  if ($insideMenu -or $insideHud) {
    $script:hudMenuLastInsideAt = $now
  }

  $buttons = [System.Windows.Forms.Control]::MouseButtons
  if (-not $script:hudMenuReadyForOutsideClick) {
    if ($buttons -eq [System.Windows.Forms.MouseButtons]::None) {
      $script:hudMenuReadyForOutsideClick = $true
    }
    return
  }

  if ($buttons -ne [System.Windows.Forms.MouseButtons]::None -and -not $insideMenu) {
    Hide-HudMenu
    return
  }

  if ((-not $insideMenu) -and (-not $insideHud) -and (($now - $script:hudMenuLastInsideAt).TotalMilliseconds -gt 1500)) {
    Hide-HudMenu
  }
}

function Request-FullscreenCheck {
  if (-not $form -or $form.IsDisposed) { return }
  if ($form.InvokeRequired) {
    if ($script:fullscreenCheckPending) { return }
    $script:fullscreenCheckPending = $true
    try {
      $form.BeginInvoke([Action]{
        $script:fullscreenCheckPending = $false
        Apply-DockPendingMoveSizeState
        Update-HudVisibilityForFullscreen
        Update-HudDockPlacement
      }) | Out-Null
    } catch {
      $script:fullscreenCheckPending = $false
    }
    return
  }
  Apply-DockPendingMoveSizeState
  Update-HudVisibilityForFullscreen
  Update-HudDockPlacement
}

$script:fullscreenEventCallback = $null
$script:fullscreenEventHooks = @()

function Start-FullscreenEventHooks {
  if ($script:fullscreenEventCallback) { return }
  $script:fullscreenEventCallback = [AiBatteryWinEventDelegate]{
    param($hook, $eventType, $hwnd, $idObject, $idChild, $eventThread, $eventTime)
    if ($script:dockTargetHandle -ne [IntPtr]::Zero) {
      if (($eventType -eq [AiBatteryNative]::EVENT_SYSTEM_MOVESIZESTART -or
          $eventType -eq [AiBatteryNative]::EVENT_SYSTEM_MOVESIZEEND) -and
          $hwnd -eq $script:dockTargetHandle) {
        Set-DockPendingMoveSizeState ($eventType -eq [AiBatteryNative]::EVENT_SYSTEM_MOVESIZESTART)
        Request-FullscreenCheck
        return
      }
      # Global reorder/location traffic is noisy and made the dock repeatedly
      # show itself. The 150ms fallback still maintains relative Z-order.
      if ($hwnd -ne $script:dockTargetHandle) { return }
    }
    if ($idObject -ne [AiBatteryNative]::OBJID_WINDOW) { return }
    Request-FullscreenCheck
  }

  $events = @(
    [AiBatteryNative]::EVENT_SYSTEM_FOREGROUND,
    [AiBatteryNative]::EVENT_SYSTEM_MOVESIZESTART,
    [AiBatteryNative]::EVENT_SYSTEM_MOVESIZEEND,
    [AiBatteryNative]::EVENT_OBJECT_SHOW,
    [AiBatteryNative]::EVENT_OBJECT_HIDE,
    [AiBatteryNative]::EVENT_OBJECT_REORDER,
    [AiBatteryNative]::EVENT_OBJECT_LOCATIONCHANGE,
    [AiBatteryNative]::EVENT_OBJECT_CLOAKED,
    [AiBatteryNative]::EVENT_OBJECT_UNCLOAKED
  )
  $flags = [AiBatteryNative]::WINEVENT_OUTOFCONTEXT -bor [AiBatteryNative]::WINEVENT_SKIPOWNPROCESS
  foreach ($eventId in $events) {
    try {
      $hook = [AiBatteryNative]::SetWinEventHook($eventId, $eventId, [IntPtr]::Zero, $script:fullscreenEventCallback, 0, 0, $flags)
      if ($hook -ne [IntPtr]::Zero) {
        $script:fullscreenEventHooks += $hook
      }
    } catch {
      # Polling still covers older or restricted Windows environments.
    }
  }
}

function Stop-FullscreenEventHooks {
  foreach ($hook in $script:fullscreenEventHooks) {
    try {
      [AiBatteryNative]::UnhookWinEvent($hook) | Out-Null
    } catch {
      # The hook may already be gone during shutdown.
    }
  }
  $script:fullscreenEventHooks = @()
  $script:fullscreenEventCallback = $null
}

. (Join-Path $PSScriptRoot "controls.ps1")

$form.add_FormClosed({
  Remove-HudDockHostMarker
  try { Restore-DockTargetSpace } catch { }
  if ($canMove) {
    Write-HudPosition $form.Location
  }
  $timer.Stop()
  $timer.Dispose()
  $topMostTimer.Stop()
  $topMostTimer.Dispose()
  $menuAutoHideTimer.Stop()
  $menuAutoHideTimer.Dispose()
  Stop-FullscreenEventHooks
  Stop-SnapshotFetch
  foreach ($box in @($codexIconLabel, $claudeIconLabel)) {
    if ($box.Image) {
      $box.Image.Dispose()
      $box.Image = $null
    }
  }
  if ($menu -and -not $menu.IsDisposed) {
    $menu.Dispose()
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
$form.add_SizeChanged({
  Set-DockedTuiWindowRegion
  Sync-HitFormBounds
})
$form.add_Shown({
  Show-HitForm
  Update-HudVisibilityForFullscreen
  Update-HudDockPlacement
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
$style = [AiBatteryNative]::GetWindowLong($form.Handle, [AiBatteryNative]::GWL_EXSTYLE)
$style = $style -bor [AiBatteryNative]::WS_EX_TOOLWINDOW -bor [AiBatteryNative]::WS_EX_NOACTIVATE
if ($ClickThrough) {
  $style = $style -bor [AiBatteryNative]::WS_EX_TRANSPARENT
}
[AiBatteryNative]::SetWindowLong($form.Handle, [AiBatteryNative]::GWL_EXSTYLE, $style) | Out-Null
if ($script:dockTuiStatusline) {
  $rounded = [AiBatteryNative]::DWMWCP_ROUND
  try {
    [AiBatteryNative]::DwmSetWindowAttribute($form.Handle, [AiBatteryNative]::DWMWA_WINDOW_CORNER_PREFERENCE, [ref]$rounded, 4) | Out-Null
  } catch { }
  Set-DockedTuiWindowRegion
}
$timer.Start()
Start-FullscreenEventHooks
$topMostTimer.Start()
$menuAutoHideTimer.Start()
Write-HudDockHostMarker
if ($env:AI_BATTERY_HUD_DEBUG_LOG) { Add-Content $env:AI_BATTERY_HUD_DEBUG_LOG "run dockTarget=$([Int64]$script:dockTargetHandle)" }
[System.Windows.Forms.Application]::Run($form)
if ($env:AI_BATTERY_HUD_DEBUG_LOG) { Add-Content $env:AI_BATTERY_HUD_DEBUG_LOG "run returned" }
