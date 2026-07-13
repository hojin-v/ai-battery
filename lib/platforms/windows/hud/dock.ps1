$script:dockTargetHandle = if ($DockWindowHandle -ne 0) { [IntPtr]::new($DockWindowHandle) } else { [IntPtr]::Zero }
$script:dockSession = [Int64]$DockSession
$script:dockSessions = @{}
$script:dockSessionTrackingEnabled = $false
$script:dockLastSessionSweepUtc = [datetime]::MinValue
$script:dockRequestLastWriteUtc = [datetime]::MinValue
$script:dockLastPlacement = $null
$script:dockSpaceReserved = $false
$script:dockTargetWasZoomed = $false
$script:dockBorderAdjusted = $false
$script:dockOriginalBorderColor = [AiBatteryNative]::DWMWA_COLOR_DEFAULT
$script:dockMoveSizeActive = $false
$script:dockGlobalDragActive = $false
$script:dockObservedFrameDragActive = $false
$script:dockObservedRawRectKey = ""
$script:dockSnapPreviewActive = $false
$script:dockShellSnapFlyoutActive = $false
$script:dockTargetForegroundAtUtc = [datetime]::MinValue
$script:dockPendingMoveSizeState = $null
$script:dockShowAfterMoveSizeUtc = [datetime]::MinValue
$script:dockFastTrackingUntilUtc = [datetime]::MinValue
$script:dockActiveTrackingInterval = 16
$script:dockIdleTrackingInterval = 150
$script:dockUnavailableSinceUtc = [datetime]::MinValue
$script:dockFrameInsetsValid = $false
$script:dockFrameInsetLeft = 0
$script:dockFrameInsetTop = 0
$script:dockFrameInsetRight = 0
$script:dockFrameInsetBottom = 0
$script:dockTargetFrameChangedAtUtc = [datetime]::MinValue

function Get-DockSessionKey([Int64]$Session, [string]$Provider) {
  $normalizedProvider = if ($Provider) { $Provider.Trim().ToLowerInvariant() } else { "unknown" }
  return "${normalizedProvider}:$Session"
}

function Write-DockSessionMarker([string]$MarkerPath, [Int64]$Hwnd, [Int64]$Session, [int]$OwnerPid, [string]$Provider) {
  if (-not $MarkerPath) { return }
  try {
    $markerDirectory = [System.IO.Path]::GetDirectoryName($MarkerPath)
    if ($markerDirectory) { [System.IO.Directory]::CreateDirectory($markerDirectory) | Out-Null }
    $previous = $null
    if (Test-Path -LiteralPath $MarkerPath) {
      try { $previous = Get-Content -LiteralPath $MarkerPath -Raw | ConvertFrom-Json } catch { }
    }
    $markerData = @{
      hwnd = $Hwnd
      session = $Session
      ownerPid = $OwnerPid
      provider = $Provider
      hostPid = $PID
      attachedAt = [datetime]::UtcNow.ToString("o")
      stage = "attached"
    }
    foreach ($name in @("columns", "windowCheckedAt")) {
      if ($previous -and $previous.PSObject.Properties.Name -contains $name) {
        $markerData[$name] = $previous.$name
      }
    }
    $marker = $markerData | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($MarkerPath, $marker, [System.Text.UTF8Encoding]::new($false))
  } catch {
    Write-HudDockDebug "dock session marker failed path=$MarkerPath session=$Session"
  }
}

function Request-PreviousDockSessionDetach([string]$MarkerPath, [Int64]$Hwnd, [Int64]$Session, [string]$Provider) {
  if (-not $MarkerPath -or $Hwnd -eq 0 -or $Session -eq 0) { return }
  try {
    if (-not (Test-Path -LiteralPath $MarkerPath)) { return }
    $previous = Get-Content -LiteralPath $MarkerPath -Raw | ConvertFrom-Json
    $previousHwnd = if ($null -ne $previous.previousHwnd) {
      [Int64]$previous.previousHwnd
    } elseif ($null -ne $previous.hwnd) {
      [Int64]$previous.hwnd
    } else { 0 }
    if ($previousHwnd -eq 0 -or $previousHwnd -eq $Hwnd) { return }
    $ipcRoot = if ($env:LOCALAPPDATA) {
      Join-Path $env:LOCALAPPDATA "ai-battery"
    } else {
      Join-Path ([System.IO.Path]::GetTempPath()) "ai-battery"
    }
    [System.IO.Directory]::CreateDirectory($ipcRoot) | Out-Null
    $requestPath = Join-Path $ipcRoot "tui-dock-request-$previousHwnd.json"
    $request = @{
      detach = $true
      hwnd = $previousHwnd
      session = $Session
      provider = $Provider
      migratedTo = $Hwnd
      at = [datetime]::UtcNow.ToString("o")
    } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($requestPath, $request, [System.Text.UTF8Encoding]::new($false))
    Write-HudDockDebug "dock session migration requested session=$Session provider=$Provider oldHwnd=$previousHwnd newHwnd=$Hwnd"
  } catch {
    Write-HudDockDebug "dock session migration request failed path=$MarkerPath session=$Session"
  }
}

function Notify-DockSessionStateChanged {
  $script:dockTuiRenderKey = $null
  if ($script:dockTuiPaintPanel -and -not $script:dockTuiPaintPanel.IsDisposed) {
    $script:dockTuiPaintPanel.Invalidate()
  }
}

function Add-DockSession([Int64]$Hwnd, [Int64]$Session, [int]$OwnerPid, [string]$Provider, [string]$MarkerPath) {
  if ($Hwnd -eq 0 -or $Session -eq 0) { return }
  Request-PreviousDockSessionDetach $MarkerPath $Hwnd $Session $Provider
  $script:dockSessionTrackingEnabled = $true
  $script:dockSessions[(Get-DockSessionKey $Session $Provider)] = [PSCustomObject]@{
    Hwnd = $Hwnd
    Session = $Session
    OwnerPid = $OwnerPid
    Provider = $Provider
    AttachedAt = [datetime]::UtcNow
  }
  Write-DockSessionMarker $MarkerPath $Hwnd $Session $OwnerPid $Provider
  Notify-DockSessionStateChanged
  Write-HudDockDebug "dock session attached session=$Session owner=$OwnerPid provider=$Provider hwnd=$Hwnd"
}

function Remove-DockSession([Int64]$Session, [string]$Provider) {
  if ($Session -eq 0) { return }
  if ($Provider) {
    if ($script:dockSessions.Remove((Get-DockSessionKey $Session $Provider))) {
      Notify-DockSessionStateChanged
    }
    return
  }
  $changed = $false
  foreach ($key in @($script:dockSessions.Keys)) {
    if ([Int64]$script:dockSessions[$key].Session -eq $Session) {
      $changed = $script:dockSessions.Remove($key) -or $changed
    }
  }
  if ($changed) { Notify-DockSessionStateChanged }
}

function Remove-DockSessionsForTarget([Int64]$Hwnd) {
  $changed = $false
  foreach ($key in @($script:dockSessions.Keys)) {
    if ([Int64]$script:dockSessions[$key].Hwnd -eq $Hwnd) {
      $changed = $script:dockSessions.Remove($key) -or $changed
    }
  }
  if ($changed) { Notify-DockSessionStateChanged }
}

function Get-DockSessionsForTarget([Int64]$Hwnd) {
  return @($script:dockSessions.Values | Where-Object { [Int64]$_.Hwnd -eq $Hwnd })
}

function Test-DockProviderActiveForTarget([string]$Provider, [Int64]$Hwnd) {
  if ($Hwnd -eq 0) { return $false }
  $normalized = if ($Provider) { $Provider.Trim().ToLowerInvariant() } else { "" }
  return @($script:dockSessions.Values | Where-Object {
    [Int64]$_.Hwnd -eq $Hwnd -and
    [string]$_.Provider -eq $normalized -and
    (Test-DockSessionOwnerAlive $_)
  }).Count -gt 0
}

function Test-DockBottomPlacement {
  return $script:dockTuiStatusline -and $script:dockPlacementMode -eq "bottom"
}

function Set-DockPlacementMode([string]$Placement) {
  $next = if ($Placement -eq "tabs") { "tabs" } else { "bottom" }
  if ($script:dockPlacementMode -eq $next) { return }
  if (Test-DockBottomPlacement) {
    Restore-DockTargetSpace
  }
  $script:dockPlacementMode = $next
  $script:dockJoinOverlap = if ($next -eq "bottom") { [math]::Max(1, (Scale-HudValue 8)) } else { 0 }
  $form.Padding = [System.Windows.Forms.Padding]::new(0)
  $form.Height = $script:dockStripHeight + $script:dockJoinOverlap
  $script:dockLastPlacement = $null
  $form.Invalidate()
  if ($script:dockTuiPaintPanel) { $script:dockTuiPaintPanel.Invalidate() }
}

function Hide-DockTargetBorder {
  if ($script:dockBorderAdjusted) { return }
  $target = $script:dockTargetHandle
  if ($target -eq [IntPtr]::Zero -or -not [AiBatteryNative]::IsWindow($target)) { return }
  $original = [AiBatteryNative]::DWMWA_COLOR_DEFAULT
  try {
    $read = [AiBatteryNative]::DwmGetWindowAttribute(
      $target,
      [AiBatteryNative]::DWMWA_BORDER_COLOR,
      [ref]$original,
      4
    )
    if ($read -ne 0) { return }
    $none = [AiBatteryNative]::DWMWA_COLOR_NONE
    $write = [AiBatteryNative]::DwmSetWindowAttribute(
      $target,
      [AiBatteryNative]::DWMWA_BORDER_COLOR,
      [ref]$none,
      4
    )
    if ($write -eq 0) {
      $script:dockOriginalBorderColor = [int]$original
      $script:dockBorderAdjusted = $true
    }
  } catch { }
}

function Restore-DockTargetBorder {
  if (-not $script:dockBorderAdjusted) { return }
  $target = $script:dockTargetHandle
  $original = [int]$script:dockOriginalBorderColor
  $script:dockBorderAdjusted = $false
  $script:dockOriginalBorderColor = [AiBatteryNative]::DWMWA_COLOR_DEFAULT
  if ($target -eq [IntPtr]::Zero -or -not [AiBatteryNative]::IsWindow($target)) { return }
  try {
    [AiBatteryNative]::DwmSetWindowAttribute(
      $target,
      [AiBatteryNative]::DWMWA_BORDER_COLOR,
      [ref]$original,
      4
    ) | Out-Null
  } catch { }
}

function Get-DockMonitorWorkArea([IntPtr]$Handle) {
  $monitor = [AiBatteryNative]::MonitorFromWindow($Handle, [AiBatteryNative]::MONITOR_DEFAULTTONEAREST)
  if ($monitor -eq [IntPtr]::Zero) { return $null }
  $info = New-Object AiBatteryMonitorInfo
  $info.CbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
  if (-not [AiBatteryNative]::GetMonitorInfo($monitor, [ref]$info)) { return $null }
  return [PSCustomObject]@{
    Left = [int]$info.Work.Left
    Top = [int]$info.Work.Top
    Right = [int]$info.Work.Right
    Bottom = [int]$info.Work.Bottom
    Width = [int]($info.Work.Right - $info.Work.Left)
    Height = [int]($info.Work.Bottom - $info.Work.Top)
    MonitorLeft = [int]$info.Monitor.Left
    MonitorTop = [int]$info.Monitor.Top
    MonitorRight = [int]$info.Monitor.Right
    MonitorBottom = [int]$info.Monitor.Bottom
    MonitorWidth = [int]($info.Monitor.Right - $info.Monitor.Left)
    MonitorHeight = [int]($info.Monitor.Bottom - $info.Monitor.Top)
  }
}

function Reserve-DockTargetSpace {
  if (-not (Test-DockBottomPlacement) -or $script:dockSpaceReserved) { return }
  $target = $script:dockTargetHandle
  if ($target -eq [IntPtr]::Zero -or -not [AiBatteryNative]::IsWindow($target)) { return }
  $stripHeight = [math]::Max(1, [int]$script:dockStripHeight)
  $rect = Get-WindowRectObject $target
  if (-not $rect -or $rect.Height -le ($stripHeight * 4)) { return }

  $script:dockTargetWasZoomed = [AiBatteryNative]::IsZoomed($target)
  if ($script:dockTargetWasZoomed) {
    $work = Get-DockMonitorWorkArea $target
    if (-not $work -or $work.Height -le ($stripHeight * 4)) { return }
    [AiBatteryNative]::ShowWindow($target, [AiBatteryNative]::SW_RESTORE) | Out-Null
    [System.Windows.Forms.Application]::DoEvents()
    [AiBatteryNative]::SetWindowPos(
      $target,
      [AiBatteryNative]::HWND_TOP,
      $work.Left,
      $work.Top,
      $work.Width,
      ($work.Height - $stripHeight),
      ([AiBatteryNative]::SWP_NOZORDER -bor [AiBatteryNative]::SWP_NOACTIVATE)
    ) | Out-Null
  } else {
    [AiBatteryNative]::SetWindowPos(
      $target,
      [AiBatteryNative]::HWND_TOP,
      $rect.Left,
      $rect.Top,
      $rect.Width,
      ($rect.Height - $stripHeight),
      ([AiBatteryNative]::SWP_NOZORDER -bor [AiBatteryNative]::SWP_NOACTIVATE)
    ) | Out-Null
  }
  $script:dockSpaceReserved = $true
  Write-HudDockDebug "reserved $stripHeight px below terminal (wasZoomed=$($script:dockTargetWasZoomed))"
}

function Restore-DockTargetSpace {
  if (-not $script:dockSpaceReserved -and -not $script:dockBorderAdjusted) { return }
  $target = $script:dockTargetHandle
  $hadReservedSpace = $script:dockSpaceReserved
  $script:dockSpaceReserved = $false
  Restore-DockTargetBorder
  if (-not $hadReservedSpace -or $target -eq [IntPtr]::Zero -or -not [AiBatteryNative]::IsWindow($target)) { return }
  if ($script:dockTargetWasZoomed) {
    [AiBatteryNative]::ShowWindow($target, [AiBatteryNative]::SW_MAXIMIZE) | Out-Null
  } else {
    $rect = Get-WindowRectObject $target
    if ($rect) {
      [AiBatteryNative]::SetWindowPos(
        $target,
        [AiBatteryNative]::HWND_TOP,
        $rect.Left,
        $rect.Top,
        $rect.Width,
        ($rect.Height + [math]::Max(1, [int]$script:dockStripHeight)),
        ([AiBatteryNative]::SWP_NOZORDER -bor [AiBatteryNative]::SWP_NOACTIVATE)
      ) | Out-Null
    }
  }
  $script:dockTargetWasZoomed = $false
}

function Test-DockSessionOwnerAlive($SessionInfo) {
  $ownerPid = [int]$SessionInfo.OwnerPid
  if ($ownerPid -le 0) { return $true }
  try {
    $owner = [System.Diagnostics.Process]::GetProcessById($ownerPid)
    $alive = -not $owner.HasExited
    $owner.Dispose()
    return $alive
  } catch {
    return $false
  }
}

function Deactivate-DockTarget([string]$Reason) {
  $releasedTarget = [Int64]$script:dockTargetHandle
  Restore-DockTargetSpace
  $script:dockTargetHandle = [IntPtr]::Zero
  $script:dockSession = 0
  $script:dockLastPlacement = $null
  $script:dockObservedFrameDragActive = $false
  $script:dockObservedRawRectKey = ""
  Set-HudHiddenForDock $true
  Write-HudDockDebug "dock target released hwnd=$releasedTarget reason=$Reason"
  if ($script:dockSessionTrackingEnabled -and $script:dockSessions.Count -eq 0 -and $DockWindowHandle -ne 0) {
    $form.BeginInvoke([System.Action]{ $form.Close() }) | Out-Null
  }
}

function Select-DockTargetFromActiveSessions([string]$Reason) {
  $next = @($script:dockSessions.Values |
    Where-Object {
      [AiBatteryNative]::IsWindow([IntPtr]::new([Int64]$_.Hwnd)) -and
      (Test-DockSessionOwnerAlive $_)
    } |
    Sort-Object AttachedAt -Descending |
    Select-Object -First 1)
  if ($next.Count -eq 0) {
    Deactivate-DockTarget $Reason
    return
  }

  $nextSession = $next[0]
  $nextHandle = [IntPtr]::new([Int64]$nextSession.Hwnd)
  if ($nextHandle -ne $script:dockTargetHandle) {
    Restore-DockTargetSpace
    $script:dockTargetHandle = $nextHandle
    $script:dockLastPlacement = $null
    $script:dockObservedFrameDragActive = $false
    $script:dockObservedRawRectKey = ""
  }
  $script:dockSession = [Int64]$nextSession.Session
  Update-HudDockPlacement
}

function Update-DockSessionLifetime {
  if (-not $script:dockSessionTrackingEnabled) { return }
  $now = [datetime]::UtcNow
  if (($now - $script:dockLastSessionSweepUtc).TotalMilliseconds -lt 750) { return }
  $script:dockLastSessionSweepUtc = $now

  $changed = $false
  foreach ($key in @($script:dockSessions.Keys)) {
    $sessionInfo = $script:dockSessions[$key]
    $handle = [IntPtr]::new([Int64]$sessionInfo.Hwnd)
    if (-not [AiBatteryNative]::IsWindow($handle) -or -not (Test-DockSessionOwnerAlive $sessionInfo)) {
      Write-HudDockDebug "dock stale session removed session=$($sessionInfo.Session) owner=$($sessionInfo.OwnerPid) hwnd=$($sessionInfo.Hwnd)"
      $changed = $script:dockSessions.Remove($key) -or $changed
    }
  }
  if ($changed) { Notify-DockSessionStateChanged }

  $currentHandle = [Int64]$script:dockTargetHandle
  if ($currentHandle -eq 0) {
    if ($script:dockSessions.Count -gt 0) {
      Select-DockTargetFromActiveSessions "active session has no terminal target"
    }
    return
  }
  if ((Get-DockSessionsForTarget $currentHandle).Count -eq 0) {
    Select-DockTargetFromActiveSessions "no active sessions for terminal"
  }
}

function Repair-DockTargetSpaceAfterShellLayout {
  if (-not (Test-DockBottomPlacement) -or -not $script:dockSpaceReserved) { return }
  $target = $script:dockTargetHandle
  $rect = Get-WindowRectObject $target
  $frame = Get-DockTargetFrame $target
  $work = Get-DockMonitorWorkArea $target
  if (-not $rect -or -not $frame -or -not $work) { return }
  $stripHeight = [math]::Max(1, [int]$script:dockStripHeight)
  $tolerance = [math]::Max(2, (Scale-HudValue 3))
  $coversMonitor = $rect.Left -le ($work.MonitorLeft + 2) -and
    $rect.Top -le ($work.MonitorTop + 2) -and
    $rect.Right -ge ($work.MonitorRight - 2) -and
    $rect.Bottom -ge ($work.MonitorBottom - 2)
  $bottomLimit = if ($coversMonitor) { $work.MonitorBottom } else { $work.Bottom }
  $topLimit = if ($coversMonitor) { $work.MonitorTop } else { $work.Top }
  $leftLimit = if ($coversMonitor) { $work.MonitorLeft } else { $work.Left }
  $rightLimit = if ($coversMonitor) { $work.MonitorRight } else { $work.Right }
  $desiredFrameBottom = $bottomLimit - $stripHeight
  $fillsShellHeight = [math]::Abs([int]$frame.Top - $topLimit) -le $tolerance -and
    [int]$frame.Bottom -ge ($desiredFrameBottom - $tolerance) -and
    [int]$frame.Bottom -le ($bottomLimit + $tolerance)
  $touchesShellSide = [math]::Abs([int]$frame.Left - $leftLimit) -le $tolerance -or
    [math]::Abs([int]$frame.Right - $rightLimit) -le $tolerance
  if (-not $fillsShellHeight -or -not $touchesShellSide) { return }

  # GetWindowRect includes invisible resize margins. Adjusting its bottom to the
  # monitor edge therefore leaves a gap after a snap/maximize transition. Move
  # the raw height by the visible DWM-frame delta instead, in either direction.
  $bottomDelta = $desiredFrameBottom - [int]$frame.Bottom
  if ([math]::Abs($bottomDelta) -le 1) { return }
  $nextHeight = $rect.Height + $bottomDelta
  if ($nextHeight -le ($stripHeight * 4)) { return }
  [AiBatteryNative]::SetWindowPos(
    $target,
    [AiBatteryNative]::HWND_TOP,
    $rect.Left,
    $rect.Top,
    $rect.Width,
    $nextHeight,
    ([AiBatteryNative]::SWP_NOZORDER -bor [AiBatteryNative]::SWP_NOACTIVATE)
  ) | Out-Null
  $script:dockLastPlacement = $null
  Write-HudDockDebug "repaired shell layout frameBottom=$($frame.Bottom) desired=$desiredFrameBottom delta=$bottomDelta"
}

function Test-DockTargetCloaked([IntPtr]$Handle) {
  $cloaked = 0
  try {
    $hr = [AiBatteryNative]::DwmGetWindowAttribute($Handle, [AiBatteryNative]::DWMWA_CLOAKED, [ref]$cloaked, 4)
    if ($hr -eq 0) { return $cloaked -ne 0 }
  } catch { }
  return $false
}

function Get-DockTargetFrame([IntPtr]$Handle) {
  # A zero-sized rect (the ConPTY pseudo-console window reports one) is
  # treated as no frame so the caller hides rather than mis-places the HUD.
  # During snap/restore animations GetWindowRect changes before DWM publishes
  # new extended bounds. Keep the measured invisible-frame insets and apply
  # them to the synchronous rect while fast tracking is active.
  $raw = New-Object AiBatteryRect
  $hasRaw = [AiBatteryNative]::GetWindowRect($Handle, [ref]$raw) -and ($raw.Right - $raw.Left) -gt 0
  $fastTracking = $script:dockMoveSizeActive -or $script:dockGlobalDragActive -or
    $script:dockObservedFrameDragActive -or
    [datetime]::UtcNow -lt $script:dockFastTrackingUntilUtc
  if (-not $fastTracking) {
    try { [AiBatteryNative]::DwmFlush() | Out-Null } catch { }
  }
  $rect = New-Object AiBatteryRect
  try {
    $hr = [AiBatteryNative]::DwmGetWindowAttributeRect($Handle, [AiBatteryNative]::DWMWA_EXTENDED_FRAME_BOUNDS, [ref]$rect, [System.Runtime.InteropServices.Marshal]::SizeOf([type][AiBatteryRect]))
    if ($hr -eq 0 -and ($rect.Right - $rect.Left) -gt 0) {
      if ($hasRaw) {
        $leftInset = [int]$rect.Left - [int]$raw.Left
        $topInset = [int]$rect.Top - [int]$raw.Top
        $rightInset = [int]$raw.Right - [int]$rect.Right
        $bottomInset = [int]$raw.Bottom - [int]$rect.Bottom
        $maxInset = [math]::Max(16, (Scale-HudValue 32))
        if ($leftInset -ge 0 -and $leftInset -le $maxInset -and
            $topInset -ge 0 -and $topInset -le $maxInset -and
            $rightInset -ge 0 -and $rightInset -le $maxInset -and
            $bottomInset -ge 0 -and $bottomInset -le $maxInset) {
          $script:dockFrameInsetLeft = $leftInset
          $script:dockFrameInsetTop = $topInset
          $script:dockFrameInsetRight = $rightInset
          $script:dockFrameInsetBottom = $bottomInset
          $script:dockFrameInsetsValid = $true
        }
      }
      if ($fastTracking -and $hasRaw -and $script:dockFrameInsetsValid) {
        $live = New-Object AiBatteryRect
        $live.Left = [int]$raw.Left + $script:dockFrameInsetLeft
        $live.Top = [int]$raw.Top + $script:dockFrameInsetTop
        $live.Right = [int]$raw.Right - $script:dockFrameInsetRight
        $live.Bottom = [int]$raw.Bottom - $script:dockFrameInsetBottom
        if (($live.Right - $live.Left) -gt 0 -and ($live.Bottom - $live.Top) -gt 0) { return $live }
      }
      return $rect
    }
  } catch { }
  if ($hasRaw) { return $raw }
  return $null
}

function Test-DockTargetUsesSquareCorners($Frame) {
  if (-not (Test-DockBottomPlacement) -or -not $Frame) { return $false }
  $work = Get-DockMonitorWorkArea $script:dockTargetHandle
  if (-not $work) { return $false }
  $tolerance = [math]::Max(2, (Scale-HudValue 3))
  $stripHeight = [math]::Max(1, [int]$script:dockStripHeight)
  $reservedHeight = if ($script:dockSpaceReserved) { $stripHeight } else { 0 }
  $fillsWorkHeight = [math]::Abs([int]$Frame.Top - $work.Top) -le $tolerance -and
    [math]::Abs([int]$Frame.Bottom - ($work.Bottom - $reservedHeight)) -le $tolerance -and
    ([math]::Abs([int]$Frame.Left - $work.Left) -le $tolerance -or
      [math]::Abs([int]$Frame.Right - $work.Right) -le $tolerance)
  $fillsMonitorHeight = [math]::Abs([int]$Frame.Top - $work.MonitorTop) -le $tolerance -and
    [math]::Abs([int]$Frame.Bottom - ($work.MonitorBottom - $reservedHeight)) -le $tolerance -and
    ([math]::Abs([int]$Frame.Left - $work.MonitorLeft) -le $tolerance -or
      [math]::Abs([int]$Frame.Right - $work.MonitorRight) -le $tolerance)
  return $fillsWorkHeight -or $fillsMonitorHeight
}

function Write-HudDockDebug([string]$Message) {
  if (-not $env:AI_BATTERY_HUD_DEBUG_LOG) { return }
  try {
    Add-Content -LiteralPath $env:AI_BATTERY_HUD_DEBUG_LOG -Value "$([datetime]::UtcNow.ToString('o')) $Message"
  } catch { }
}

if ($DockWindowHandle -ne 0 -and $DockSession -ne 0) {
  Add-DockSession ([Int64]$DockWindowHandle) ([Int64]$DockSession) ([int]$DockOwnerPid) ([string]$DockProvider) ([string]$DockMarkerPath)
}

function Set-DockPendingMoveSizeState([bool]$Active) {
  $script:dockPendingMoveSizeState = $Active
}

function Test-DockGlobalTargetDragActive {
  if ($script:dockTargetHandle -eq [IntPtr]::Zero) { return $false }
  $leftButtonDown = Test-DockLeftButtonDown
  return $leftButtonDown -and [AiBatteryNative]::GetForegroundWindow() -eq $script:dockTargetHandle
}

function Test-DockLeftButtonDown {
  return (([int][AiBatteryNative]::GetAsyncKeyState(1)) -band 0x8000) -ne 0
}

function Update-DockGlobalDragState {
  $active = Test-DockGlobalTargetDragActive
  if ($script:dockGlobalDragActive -eq $active) { return }
  $script:dockGlobalDragActive = $active
  if ($active) {
    # Re-read the frame when tracking starts. On release, retain the last
    # placement so an unchanged final frame does not reassign WinForms Bounds
    # and flash a redundant DWM frame.
    $script:dockLastPlacement = $null
    $script:dockFastTrackingUntilUtc = [datetime]::MaxValue
    Write-HudDockDebug "dock global drag tracking started"
  } else {
    $script:dockFastTrackingUntilUtc = [datetime]::UtcNow.AddMilliseconds(350)
    Write-HudDockDebug "dock global drag tracking ended"
  }
  Update-DockTrackingInterval
}

function Update-DockObservedFrameDragState {
  if ($script:dockTargetHandle -eq [IntPtr]::Zero -or
      -not [AiBatteryNative]::IsWindow($script:dockTargetHandle)) {
    $script:dockObservedFrameDragActive = $false
    $script:dockObservedRawRectKey = ""
    return
  }

  $rect = New-Object AiBatteryRect
  if (-not [AiBatteryNative]::GetWindowRect($script:dockTargetHandle, [ref]$rect)) { return }
  $key = "{0},{1},{2},{3}" -f $rect.Left, $rect.Top, $rect.Right, $rect.Bottom
  $changed = $script:dockObservedRawRectKey -ne "" -and $script:dockObservedRawRectKey -ne $key
  $script:dockObservedRawRectKey = $key
  $leftButtonDown = Test-DockLeftButtonDown

  if (-not $leftButtonDown) {
    if ($script:dockObservedFrameDragActive) {
      $script:dockFastTrackingUntilUtc = [datetime]::UtcNow.AddMilliseconds(350)
      Write-HudDockDebug "dock observed frame drag ended"
    }
    $script:dockObservedFrameDragActive = $false
    Update-DockTrackingInterval
    return
  }
  if (-not $changed -or $script:dockObservedFrameDragActive) { return }

  $script:dockObservedFrameDragActive = $true
  $script:dockLastPlacement = $null
  $script:dockFastTrackingUntilUtc = [datetime]::MaxValue
  Write-HudDockDebug "dock observed frame drag started"
  Update-DockTrackingInterval
}

function Set-DockTrackingInterval([int]$Milliseconds) {
  $timerVariable = Get-Variable -Name topMostTimer -Scope Script -ErrorAction SilentlyContinue
  if (-not $timerVariable -or -not $timerVariable.Value) { return }
  $trackingTimer = $timerVariable.Value
  $nextInterval = [math]::Max(15, $Milliseconds)
  if ($trackingTimer.Interval -ne $nextInterval) {
    $trackingTimer.Interval = $nextInterval
  }
}

function Update-DockTrackingInterval {
  if ($script:dockMoveSizeActive -or $script:dockGlobalDragActive -or
      $script:dockObservedFrameDragActive -or
      [datetime]::UtcNow -lt $script:dockFastTrackingUntilUtc) {
    Set-DockTrackingInterval $script:dockActiveTrackingInterval
  } else {
    Set-DockTrackingInterval $script:dockIdleTrackingInterval
  }
}

function Test-DockSnapPreviewActive {
  $leftButtonDown = Test-DockLeftButtonDown
  $recentFrameChange = ([datetime]::UtcNow - $script:dockTargetFrameChangedAtUtc).TotalMilliseconds -le 350
  # MOVESIZE events can refer to an internal Windows Terminal HWND. In that
  # case, use the foreground/left-button fallback only after the target frame
  # has actually moved. Once a preview is entered, keep it active while the
  # button remains down even though Windows freezes the target frame.
  $dragActive = $leftButtonDown -and (
    $script:dockMoveSizeActive -or
    $script:dockObservedFrameDragActive -or
    ($script:dockGlobalDragActive -and ($recentFrameChange -or $script:dockSnapPreviewActive))
  )
  if (-not $dragActive) { return $false }
  $point = [System.Windows.Forms.Cursor]::Position
  $screen = [System.Windows.Forms.Screen]::FromPoint($point)
  if (-not $screen) { return $false }
  $bounds = $screen.Bounds
  # Windows Terminal owns mouse capture during a native title-bar drag, so
  # WinForms MouseButtons can report None. MOVESIZESTART already proves that a
  # drag is active; cursor proximity is the reliable snap-preview signal.
  $edge = if ($script:dockSnapPreviewActive) {
    [math]::Max(12, (Scale-HudValue 32))
  } else {
    [math]::Max(8, (Scale-HudValue 20))
  }
  return $point.X -le ($bounds.Left + $edge) -or
    $point.X -ge ($bounds.Right - $edge - 1) -or
    $point.Y -le ($bounds.Top + $edge)
}

function Test-DockShellSnapFlyoutActive {
  if ($script:dockTargetHandle -eq [IntPtr]::Zero) { return $false }
  $foreground = [AiBatteryNative]::GetForegroundWindow()
  $now = [datetime]::UtcNow
  if ($foreground -eq $script:dockTargetHandle) {
    $script:dockTargetForegroundAtUtc = $now
    # A visible XAML shell host is not specific to the snap flyout and can
    # remain present while a terminal is being moved. Native drag previews are
    # already detected from the cursor/monitor edge below, so do not let this
    # broad shell-window probe hide the HUD during an ordinary title-bar drag.
    # MOVESIZEEND can leave a XamlExplorerHostIslandWindow visible for a few
    # compositor frames after the mouse button is released. Edge-based drag
    # detection already handles real snap previews; suppress this shell probe
    # through the short post-move fast-tracking window so release never hides
    # and re-shows an otherwise stable HUD. Stationary Win+Z/hover detection is
    # unaffected once that window has elapsed.
    if ((Test-DockLeftButtonDown) -or $now -lt $script:dockFastTrackingUntilUtc) { return $false }
    return [AiBatteryNative]::HasVisibleTopLevelWindowClass("XamlExplorerHostIslandWindow")
  }
  if ($foreground -eq [IntPtr]::Zero) { return $false }
  $className = [System.Text.StringBuilder]::new(256)
  [AiBatteryNative]::GetClassName($foreground, $className, $className.Capacity) | Out-Null
  if ($className.ToString() -ne "XamlExplorerHostIslandWindow") { return $false }
  return $script:dockShellSnapFlyoutActive -or
    ($now - $script:dockTargetForegroundAtUtc).TotalMilliseconds -le 2000
}

function Update-DockSnapPreviewVisibility {
  # Normal movement remains visible. This branch only hides at a snap edge;
  # global drag tracking covers terminals whose MOVESIZE event uses a child
  # HWND and must not itself be treated as a reason to hide.
  $shellPreview = Test-DockShellSnapFlyoutActive
  $script:dockShellSnapFlyoutActive = $shellPreview
  if (-not $script:dockMoveSizeActive -and
      -not $script:dockGlobalDragActive -and
      -not $script:dockObservedFrameDragActive -and
      -not $script:dockSnapPreviewActive -and
      -not $shellPreview) { return $false }
  $preview = $shellPreview -or (Test-DockSnapPreviewActive)
  if ($script:dockSnapPreviewActive -ne $preview) {
    $script:dockSnapPreviewActive = $preview
    if ($preview) {
      Write-HudDockDebug "dock hide: snap preview edge entered"
      Set-HudHiddenForDock $true
    } elseif (-not (Test-DockLeftButtonDown)) {
      # Mouse release can be observed before MOVESIZEEND. Keep the HUD hidden
      # until DWM has published the final snapped frame.
      $script:dockShowAfterMoveSizeUtc = [datetime]::UtcNow.AddMilliseconds(120)
      $script:dockFastTrackingUntilUtc = [datetime]::UtcNow.AddMilliseconds(350)
      Write-HudDockDebug "dock snap preview released; waiting for final frame"
    } else {
      Write-HudDockDebug "dock show: snap preview edge left"
      Set-HudHiddenForDock $false
      $script:dockLastPlacement = $null
    }
  }
  return $preview
}

function Apply-DockPendingMoveSizeState {
  if ($null -eq $script:dockPendingMoveSizeState) { return }
  $active = [bool]$script:dockPendingMoveSizeState
  $script:dockPendingMoveSizeState = $null
  if ($script:dockMoveSizeActive -eq $active) { return }
  $script:dockMoveSizeActive = $active
  if ($active) {
    $script:dockLastPlacement = $null
    $script:dockSnapPreviewActive = $false
    $script:dockShowAfterMoveSizeUtc = [datetime]::MinValue
    $script:dockFastTrackingUntilUtc = [datetime]::MaxValue
    Update-DockTrackingInterval
    Write-HudDockDebug "dock move/size tracking started"
  } else {
    $wasSnapPreview = $script:dockSnapPreviewActive
    $script:dockSnapPreviewActive = $false
    $script:dockFastTrackingUntilUtc = [datetime]::UtcNow.AddMilliseconds(350)
    Update-DockTrackingInterval
    if ($wasSnapPreview) {
      # Let DWM publish the snapped extended frame before showing at its edge.
      $script:dockShowAfterMoveSizeUtc = [datetime]::UtcNow.AddMilliseconds(120)
      Write-HudDockDebug "dock snap preview ended; waiting for final frame"
    } else {
      $script:dockShowAfterMoveSizeUtc = [datetime]::MinValue
      Write-HudDockDebug "dock move/size tracking ended"
    }
  }
}

function Test-DockUnavailablePastGrace([string]$Reason) {
  $now = [datetime]::UtcNow
  if ($script:dockUnavailableSinceUtc -eq [datetime]::MinValue) {
    $script:dockUnavailableSinceUtc = $now
    Write-HudDockDebug "dock transient unavailable: $Reason"
    return $false
  }
  return ($now - $script:dockUnavailableSinceUtc).TotalMilliseconds -ge 500
}

function Clear-DockUnavailableGrace {
  $script:dockUnavailableSinceUtc = [datetime]::MinValue
}

function Update-HudDockDpi {
  if (-not $script:dockTuiStatusline -or $script:dockTargetHandle -eq [IntPtr]::Zero) { return $false }
  $targetDpi = 96
  try {
    $value = [AiBatteryNative]::GetDpiForWindow($script:dockTargetHandle)
    if ($value -gt 0) { $targetDpi = [int]$value }
  } catch { }
  if ($targetDpi -eq [int]$script:hudDpi) { return $false }

  # Windows Terminal scales its own reserved geometry while crossing monitors.
  # Keep the reservation active and update our matching physical height; a
  # restore/re-reserve cycle here visibly resizes the terminal during a drag.
  $oldFont = $script:font
  $oldSymbolFont = $script:symbolFont
  $script:hudDpi = $targetDpi
  $script:hudScale = [double]$targetDpi / 96.0
  $script:font = New-HudMainFont
  $script:symbolFont = New-HudSymbolFont
  $script:dockStripHeight = Scale-HudValue 20
  $script:dockJoinOverlap = if (Test-DockBottomPlacement) { [math]::Max(1, (Scale-HudValue 8)) } else { 0 }
  $form.Height = $script:dockStripHeight + $script:dockJoinOverlap
  $script:dockLastPlacement = $null
  $script:dockTuiRenderKey = $null
  Set-DockedTuiWindowRegion
  if ($script:dockTuiPaintPanel) { $script:dockTuiPaintPanel.Invalidate() }
  Write-HudDockHostMarker
  if ($oldFont) { $oldFont.Dispose() }
  if ($oldSymbolFont) { $oldSymbolFont.Dispose() }
  Write-HudDockDebug "dock DPI -> $targetDpi scale=$($script:hudScale)"
  return $true
}

function Update-HudDockPlacement {
  if ($script:dockTargetHandle -eq [IntPtr]::Zero) { return }
  if (-not $form -or $form.IsDisposed) { return }
  Update-HudDockDpi | Out-Null
  Apply-DockPendingMoveSizeState
  Update-DockObservedFrameDragState
  Update-DockGlobalDragState
  Update-DockTrackingInterval
  if (Update-DockSnapPreviewVisibility) { return }
  if ([datetime]::UtcNow -lt $script:dockShowAfterMoveSizeUtc) { return }
  $target = $script:dockTargetHandle
  if (-not [AiBatteryNative]::IsWindow($target)) {
    $closedTarget = [Int64]$target
    Write-HudDockDebug "dock target $closedTarget is gone; releasing its sessions"
    Remove-DockSessionsForTarget $closedTarget
    Select-DockTargetFromActiveSessions "terminal window closed"
    return
  }

  $targetIconic = [AiBatteryNative]::IsIconic($target)
  $targetVisible = [AiBatteryNative]::IsWindowVisible($target) -and
    -not $targetIconic -and
    -not (Test-DockTargetCloaked $target)
  if (-not $targetVisible) {
    if (-not $targetIconic -and -not (Test-DockUnavailablePastGrace "visibility/cloak transition")) {
      return
    }
    Write-HudDockDebug "dock hide: target not visible (visible=$([AiBatteryNative]::IsWindowVisible($target)) iconic=$([AiBatteryNative]::IsIconic($target)))"
    Restore-DockTargetBorder
    $script:dockLastPlacement = $null
    Set-HudHiddenForDock $true
    return
  }
  Clear-DockUnavailableGrace

  if (Test-DockBottomPlacement) {
    Reserve-DockTargetSpace
    Repair-DockTargetSpaceAfterShellLayout
    # Keep the terminal's native side border. The HUD overlaps and covers its
    # bottom edge, then continues that border on its three exposed sides.
    Restore-DockTargetBorder
  }
  $frame = Get-DockTargetFrame $target
  if (-not $frame) {
    if (-not (Test-DockUnavailablePastGrace "missing DWM frame")) { return }
    Write-HudDockDebug "dock hide: no frame rect for target"
    Restore-DockTargetBorder
    Set-HudHiddenForDock $true
    return
  }
  Clear-DockUnavailableGrace
  $nextSquareCorners = Test-DockTargetUsesSquareCorners $frame
  if ($script:dockSquareCorners -ne $nextSquareCorners) {
    $script:dockSquareCorners = $nextSquareCorners
    $script:dockLastPlacement = $null
    $form.Invalidate()
  }
  if (Test-DockBottomPlacement) {
    $horizontalInset = [math]::Max(0, [int]$script:dockHorizontalInset)
    # GDI+ clips the right half-pixel border at the window edge, while the left
    # half is anti-aliased outward. Trim only that optical overhang and keep the
    # already aligned right edge fixed.
    $leftOpticalInset = [math]::Max(0, [int]$script:dockLeftOpticalInset)
    $stripWidth = [math]::Max(1, [int]($frame.Right - $frame.Left) - ($horizontalInset * 2) - $leftOpticalInset)
    $stripHeight = [math]::Max(1, [int]$script:dockStripHeight)
    $joinOverlap = [math]::Max(1, [int]$script:dockJoinOverlap)
    $renderHeight = $stripHeight + $joinOverlap
    $x = [int]$frame.Left + $horizontalInset + $leftOpticalInset
    $anchorBottom = [int]$frame.Bottom
    $y = $anchorBottom - $joinOverlap
    $placement = "{0},{1},{2},{3},{4}" -f $x, $y, $stripWidth, $renderHeight, $script:dockSquareCorners
    if ($script:dockLastPlacement -ne $placement) {
      $script:dockLastPlacement = $placement
      $script:dockTargetFrameChangedAtUtc = [datetime]::UtcNow
      Write-HudDockDebug "dock TUI strip -> $placement"
      $form.Bounds = [System.Drawing.Rectangle]::new($x, $y, $stripWidth, $renderHeight)
      Set-DockedTuiWindowRegion
      Sync-HitFormBounds
      if ($script:dockTuiPaintPanel) { $script:dockTuiPaintPanel.Invalidate() }
    }
    Set-HudHiddenForDock $false
    Sync-HudDockZOrder $target
    return
  }

  if ($script:dockTuiStatusline -and $script:dockPlacementMode -eq "tabs") {
    $dpi = 96
    try {
      $windowDpi = [AiBatteryNative]::GetDpiForWindow($target)
      if ($windowDpi -gt 0) { $dpi = [int]$windowDpi }
    } catch { }
    $dockScale = $dpi / 96.0
    $captionReserve = [int][math]::Round(150 * $dockScale)
    $edgeMargin = [int][math]::Round(8 * $dockScale)
    $minimumWidth = [int][math]::Round(260 * $dockScale)
    $desiredWidth = [int][math]::Round(620 * $dockScale)
    $availableWidth = [int]($frame.Right - $frame.Left) - $captionReserve - ($edgeMargin * 2)
    if ($availableWidth -lt $minimumWidth) {
      Write-HudDockDebug "dock tabs hide: available width $availableWidth"
      Set-HudHiddenForDock $true
      return
    }
    $width = [math]::Min($desiredWidth, $availableWidth)
    $height = [math]::Max(1, [int]$script:dockStripHeight)
    $x = [int]$frame.Right - $captionReserve - $edgeMargin - $width
    $y = [int]$frame.Top + [int][math]::Round(6 * $dockScale)
    $placement = "tabs,{0},{1},{2},{3}" -f $x, $y, $width, $height
    if ($script:dockLastPlacement -ne $placement) {
      $script:dockLastPlacement = $placement
      $script:dockTargetFrameChangedAtUtc = [datetime]::UtcNow
      Write-HudDockDebug "dock tabs -> $placement"
      $form.Bounds = [System.Drawing.Rectangle]::new($x, $y, $width, $height)
      Set-DockedTuiWindowRegion
      Sync-HitFormBounds
      if ($script:dockTuiPaintPanel) { $script:dockTuiPaintPanel.Invalidate() }
    }
    Set-HudHiddenForDock $false
    Sync-HudDockZOrder $target
    return
  }

  $dpi = 96
  try {
    $windowDpi = [AiBatteryNative]::GetDpiForWindow($target)
    if ($windowDpi -gt 0) { $dpi = [int]$windowDpi }
  } catch { }
  $dockScale = $dpi / 96.0
  $captionReserve = [int][math]::Round(150 * $dockScale)
  $edgeMargin = [int][math]::Round(8 * $dockScale)
  $x = $frame.Right - $captionReserve - $form.Width
  $y = $frame.Top + [int][math]::Round(2 * $dockScale)
  if ($x -lt ($frame.Left + $edgeMargin)) {
    # The window is too narrow to host the HUD without covering its tabs.
    Write-HudDockDebug "dock hide: narrow (x=$x frame=$($frame.Left),$($frame.Top),$($frame.Right),$($frame.Bottom) formWidth=$($form.Width) reserve=$captionReserve)"
    Set-HudHiddenForDock $true
    return
  }

  $placement = "{0},{1}" -f $x, $y
  if ($script:dockLastPlacement -ne $placement) {
    $script:dockLastPlacement = $placement
    $script:dockTargetFrameChangedAtUtc = [datetime]::UtcNow
    Write-HudDockDebug "dock placement -> $placement (frame $($frame.Left),$($frame.Top))-($($frame.Right),$($frame.Bottom))"
    $form.Location = [System.Drawing.Point]::new([int]$x, [int]$y)
  }
  Set-HudHiddenForDock $false
  Sync-HudDockZOrder $target
}

function Get-DockNearestVisibleWindowAbove([IntPtr]$Handle) {
  $candidate = [AiBatteryNative]::GetWindow($Handle, [AiBatteryNative]::GW_HWNDPREV)
  for ($scanned = 0; $scanned -lt 64 -and $candidate -ne [IntPtr]::Zero; $scanned += 1) {
    if ([AiBatteryNative]::IsWindowVisible($candidate)) { return $candidate }
    $candidate = [AiBatteryNative]::GetWindow($candidate, [AiBatteryNative]::GW_HWNDPREV)
  }
  return [IntPtr]::Zero
}

function Sync-HudDockZOrder([IntPtr]$Target) {
  # Keep the dock immediately above its terminal but below every window that
  # already covers the terminal. The bottom layout overlaps the terminal frame
  # so its opaque surface masks the DWM edge without becoming globally topmost.
  if (-not $form -or $form.IsDisposed) { return }
  if ($script:hudHiddenForFullscreen -or $script:hudHiddenForDock) { return }
  $formHandle = $form.Handle
  $hitHandle = if ($hitForm -and -not $hitForm.IsDisposed) { $hitForm.Handle } else { [IntPtr]::Zero }
  $zFlags = [AiBatteryNative]::SWP_NOMOVE -bor [AiBatteryNative]::SWP_NOSIZE -bor [AiBatteryNative]::SWP_NOACTIVATE
  # WinForms and PowerShell leave hidden parking/console HWNDs in the Z-order.
  # Treating one of those as the terminal's visible neighbour made every timer
  # tick issue SWP_SHOWWINDOW for an already-visible HUD, which flashed when
  # Windows committed the terminal's final frame on mouse release.
  $previous = Get-DockNearestVisibleWindowAbove $Target
  $insertAfter = if ($previous -eq [IntPtr]::Zero) { [AiBatteryNative]::HWND_TOP } else { $previous }
  $formVisible = [AiBatteryNative]::IsWindowVisible($formHandle)
  if (-not $formVisible) {
    [AiBatteryNative]::ShowWindow($formHandle, [AiBatteryNative]::SW_SHOWNOACTIVATE) | Out-Null
  }
  if ($previous -ne $formHandle -or -not $formVisible) {
    [AiBatteryNative]::SetWindowPos($formHandle, $insertAfter, 0, 0, 0, 0, $zFlags) | Out-Null
    Write-HudDockDebug "dock z-order sync target=$([Int64]$Target) previous=$([Int64]$previous)"
  }
  if ($hitHandle -ne [IntPtr]::Zero -and [AiBatteryNative]::IsWindowVisible($hitHandle)) {
    $aboveForm = Get-DockNearestVisibleWindowAbove $formHandle
    if ($aboveForm -ne $hitHandle) {
      $hitInsertAfter = if ($aboveForm -eq [IntPtr]::Zero) { [AiBatteryNative]::HWND_TOP } else { $aboveForm }
      [AiBatteryNative]::SetWindowPos($hitHandle, $hitInsertAfter, 0, 0, 0, 0, $zFlags) | Out-Null
    }
  }
}

$script:dockResizeDragActive = $false
$script:dockResizeDragEdge = ""
$script:dockResizeDragStart = [System.Drawing.Point]::Empty
$script:dockResizeDragRect = $null

function Get-HudDockResizeEdge([System.Drawing.Point]$ScreenPoint) {
  if (-not (Test-DockBottomPlacement) -or -not $form -or $form.IsDisposed) { return "" }
  $bottomGrip = [math]::Max(4, (Scale-HudValue 6))
  if ($ScreenPoint.Y -lt ($form.Bottom - $bottomGrip)) { return "" }
  $cornerGrip = [math]::Max(12, (Scale-HudValue 18))
  if ($ScreenPoint.X -le ($form.Left + $cornerGrip)) { return "bottom-left" }
  if ($ScreenPoint.X -ge ($form.Right - $cornerGrip)) { return "bottom-right" }
  return "bottom"
}

function Set-HudDockResizeCursor($Control, [string]$Edge) {
  if (-not $Control) { return }
  if ($Edge -eq "bottom-left") {
    $Control.Cursor = [System.Windows.Forms.Cursors]::SizeNESW
  } elseif ($Edge -eq "bottom-right") {
    $Control.Cursor = [System.Windows.Forms.Cursors]::SizeNWSE
  } elseif ($Edge -eq "bottom") {
    $Control.Cursor = [System.Windows.Forms.Cursors]::SizeNS
  } else {
    $Control.Cursor = [System.Windows.Forms.Cursors]::Default
  }
}

function Initialize-HudDockResizeGrip {
  if (-not $script:dockTuiStatusline) { return }
  $mouseDown = {
    param($sender, $event)
    if ($event.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
    $point = [System.Windows.Forms.Cursor]::Position
    $edge = Get-HudDockResizeEdge $point
    if (-not $edge) { return }
    $rect = New-Object AiBatteryRect
    if (-not [AiBatteryNative]::GetWindowRect($script:dockTargetHandle, [ref]$rect)) { return }
    $script:dockResizeDragActive = $true
    $script:dockResizeDragEdge = $edge
    $script:dockResizeDragStart = $point
    $script:dockResizeDragRect = [PSCustomObject]@{
      Left = [int]$rect.Left
      Top = [int]$rect.Top
      Right = [int]$rect.Right
      Bottom = [int]$rect.Bottom
    }
    $sender.Capture = $true
  }
  $mouseMove = {
    param($sender, $event)
    $point = [System.Windows.Forms.Cursor]::Position
    if (-not $script:dockResizeDragActive -or -not $script:dockResizeDragRect) {
      Set-HudDockResizeCursor $sender (Get-HudDockResizeEdge $point)
      return
    }
    $start = $script:dockResizeDragRect
    $dx = $point.X - $script:dockResizeDragStart.X
    $dy = $point.Y - $script:dockResizeDragStart.Y
    $left = [int]$start.Left
    $top = [int]$start.Top
    $right = [int]$start.Right
    $bottom = [int]($start.Bottom + $dy)
    if ($script:dockResizeDragEdge -eq "bottom-left") {
      $left = [int]($start.Left + $dx)
    } elseif ($script:dockResizeDragEdge -eq "bottom-right") {
      $right = [int]($start.Right + $dx)
    }
    $minimumWidth = [math]::Max(240, (Scale-HudValue 320))
    $minimumHeight = [math]::Max(120, (Scale-HudValue 180))
    if (($right - $left) -lt $minimumWidth) {
      if ($script:dockResizeDragEdge -eq "bottom-left") {
        $left = $right - $minimumWidth
      } else {
        $right = $left + $minimumWidth
      }
    }
    if (($bottom - $top) -lt $minimumHeight) { $bottom = $top + $minimumHeight }
    $work = Get-DockMonitorWorkArea $script:dockTargetHandle
    if ($work -and $bottom -gt $work.Bottom) { $bottom = $work.Bottom }
    [AiBatteryNative]::SetWindowPos(
      $script:dockTargetHandle,
      [AiBatteryNative]::HWND_TOP,
      $left,
      $top,
      ($right - $left),
      ($bottom - $top),
      ([AiBatteryNative]::SWP_NOZORDER -bor [AiBatteryNative]::SWP_NOACTIVATE)
    ) | Out-Null
    $script:dockLastPlacement = $null
    Update-HudDockPlacement
  }
  $mouseUp = {
    param($sender, $event)
    if (-not $script:dockResizeDragActive) { return }
    $script:dockResizeDragActive = $false
    $script:dockResizeDragEdge = ""
    $script:dockResizeDragRect = $null
    $sender.Capture = $false
    Set-HudDockResizeCursor $sender ""
    Update-HudDockPlacement
  }
  foreach ($control in @($form, $panel, $script:dockTuiPaintPanel)) {
    if (-not $control) { continue }
    $control.add_MouseDown($mouseDown)
    $control.add_MouseMove($mouseMove)
    $control.add_MouseUp($mouseUp)
    $control.add_MouseLeave({
      param($sender, $event)
      if (-not $script:dockResizeDragActive) { Set-HudDockResizeCursor $sender "" }
    })
  }
}

function Update-HudDockRequest {
  $path = Get-HudDockRequestPath
  if (-not (Test-Path -LiteralPath $path)) { return }
  try {
    $write = (Get-Item -LiteralPath $path).LastWriteTimeUtc
    if ($write -le $script:dockRequestLastWriteUtc) { return }
    $script:dockRequestLastWriteUtc = $write
    $request = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if ($request.stop) {
      if (([datetime]::UtcNow - $write).TotalSeconds -le 30) {
        $form.Close()
      }
      return
    }
    if ($request.detach) {
      $requestSession = if ($null -ne $request.session) { [Int64]$request.session } else { 0 }
      $requestProvider = if ($request.provider) { [string]$request.provider } else { "" }
      Remove-DockSession $requestSession $requestProvider
      Write-HudDockDebug "dock session detached session=$requestSession provider=$requestProvider"
      $currentSessions = Get-DockSessionsForTarget ([Int64]$script:dockTargetHandle)
      if ($currentSessions.Count -eq 0) {
        Select-DockTargetFromActiveSessions "last terminal session detached"
      } elseif ($requestSession -eq $script:dockSession) {
        $replacement = @($currentSessions | Sort-Object AttachedAt -Descending | Select-Object -First 1)
        if ($replacement.Count -gt 0) {
          $script:dockSession = [Int64]$replacement[0].Session
        }
      }
      return
    }
    $hwnd = [Int64]$request.hwnd
    if ($hwnd -ne 0 -and [AiBatteryNative]::IsWindow([IntPtr]::new($hwnd))) {
      if ($request.placement) {
        Set-DockPlacementMode ([string]$request.placement)
      }
      $requestSession = if ($null -ne $request.session) { [Int64]$request.session } else { 0 }
      $requestOwnerPid = if ($null -ne $request.ownerPid) { [int]$request.ownerPid } else { 0 }
      $requestProvider = if ($request.provider) { [string]$request.provider } else { "" }
      $requestMarkerPath = if ($request.markerPath) { [string]$request.markerPath } else { "" }
      Add-DockSession $hwnd $requestSession $requestOwnerPid $requestProvider $requestMarkerPath
      if ([IntPtr]::new($hwnd) -ne $script:dockTargetHandle) {
        Restore-DockTargetSpace
      }
      $script:dockTargetHandle = [IntPtr]::new($hwnd)
      $script:dockSession = $requestSession
      $script:dockLastPlacement = $null
      $script:dockObservedFrameDragActive = $false
      $script:dockObservedRawRectKey = ""
      Update-HudDockPlacement
    }
  } catch {
    # A malformed request is discarded on the next write.
  }
}
