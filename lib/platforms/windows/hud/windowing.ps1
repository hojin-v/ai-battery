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

function Test-RectIsSubstantialOnMonitor($WindowRect, $MonitorRect) {
  if (-not $WindowRect -or -not $MonitorRect) { return $false }
  $left = [math]::Max([int]$WindowRect.Left, [int]$MonitorRect.Left)
  $top = [math]::Max([int]$WindowRect.Top, [int]$MonitorRect.Top)
  $right = [math]::Min([int]$WindowRect.Right, [int]$MonitorRect.Right)
  $bottom = [math]::Min([int]$WindowRect.Bottom, [int]$MonitorRect.Bottom)
  $width = [math]::Max(0, $right - $left)
  $height = [math]::Max(0, $bottom - $top)
  $monitorArea = [math]::Max(1, [int]$MonitorRect.Width * [int]$MonitorRect.Height)
  $windowArea = $width * $height
  return (($windowArea / $monitorArea) -ge 0.20)
}

function Test-HudWindowHandle([IntPtr]$Handle) {
  if ($Handle -eq [IntPtr]::Zero) { return $false }
  if ($form -and -not $form.IsDisposed -and $Handle -eq $form.Handle) { return $true }
  if ($hitForm -and -not $hitForm.IsDisposed -and $Handle -eq $hitForm.Handle) { return $true }
  return $false
}

function Get-WindowClassName([IntPtr]$Handle) {
  if ($Handle -eq [IntPtr]::Zero) { return "" }
  $builder = New-Object System.Text.StringBuilder 256
  [AiBatteryNative]::GetClassName($Handle, $builder, $builder.Capacity) | Out-Null
  return $builder.ToString()
}

function Test-WindowCloaked([IntPtr]$Handle) {
  if ($Handle -eq [IntPtr]::Zero) { return $false }
  $value = 0
  try {
    $hr = [AiBatteryNative]::DwmGetWindowAttribute($Handle, [AiBatteryNative]::DWMWA_CLOAKED, [ref]$value, 4)
  } catch {
    return $false
  }
  if ($hr -ne 0) { return $false }
  return ($value -ne 0)
}

# Desktop and shell surfaces span the monitor but must never hide the HUD.
$script:hudSkipWindowClasses = @(
  "Shell_TrayWnd",
  "Shell_SecondaryTrayWnd",
  "NotifyIconOverflowWindow",
  "Progman",
  "WorkerW"
)

function Test-FullscreenOnHudMonitor {
  if (-not $form -or $form.IsDisposed) { return $false }
  $hudMonitor = [AiBatteryNative]::MonitorFromWindow($form.Handle, [AiBatteryNative]::MONITOR_DEFAULTTONEAREST)
  if ($hudMonitor -eq [IntPtr]::Zero) { return $false }
  $monitorRect = Get-MonitorRectObject $hudMonitor
  if (-not $monitorRect) { return $false }

  # Walk the Z-order from the top down. Small transient overlays (volume, IME,
  # Game Bar, browser controls) are ignored so we can still see the fullscreen
  # window beneath them. A substantial normal window stops the search: any
  # fullscreen window below it is not the visible fullscreen surface.
  $handle = [AiBatteryNative]::GetTopWindow([IntPtr]::Zero)
  for ($scanned = 0; $scanned -lt 400 -and $handle -ne [IntPtr]::Zero; $scanned += 1) {
    $next = [AiBatteryNative]::GetWindow($handle, [AiBatteryNative]::GW_HWNDNEXT)
    # Filter cheapest-first: most windows live on another monitor, so skip the
    # DWM cloak and class-name lookups until a window is on the HUD monitor.
    if ((-not (Test-HudWindowHandle $handle)) -and
        [AiBatteryNative]::IsWindowVisible($handle) -and
        ([AiBatteryNative]::MonitorFromWindow($handle, [AiBatteryNative]::MONITOR_DEFAULTTONEAREST) -eq $hudMonitor) -and
        (-not (Test-WindowCloaked $handle)) -and
        ($script:hudSkipWindowClasses -notcontains (Get-WindowClassName $handle))) {
      $windowRect = Get-WindowRectObject $handle
      if ($windowRect -and $windowRect.Width -gt 0 -and $windowRect.Height -gt 0) {
        if (Test-RectCoversMonitor $windowRect $monitorRect) {
          return $true
        }
        if (Test-RectIsSubstantialOnMonitor $windowRect $monitorRect) {
          return $false
        }
      }
    }
    $handle = $next
  }

  return $false
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
  if ($DockWindowHandle -ne 0) {
    Update-HudDockPlacement
    return
  }
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
  if ($script:hudHiddenForFullscreen -or $script:hudHiddenForDock) { return }
  if ($null -ne $script:dockTargetHandle -and $script:dockTargetHandle -ne [IntPtr]::Zero) {
    # Docked HUDs are z-ordered against the terminal window instead of the
    # topmost band; Sync-HudDockZOrder maintains that on every placement tick.
    return
  }
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

$script:hudHiddenForDock = $false

function Apply-HudHiddenState {
  $hidden = $script:hudHiddenForFullscreen -or $script:hudHiddenForDock
  if ($env:AI_BATTERY_HUD_DEBUG_LOG) {
    try { Add-Content $env:AI_BATTERY_HUD_DEBUG_LOG "apply hidden=$hidden fullscreen=$($script:hudHiddenForFullscreen) dock=$($script:hudHiddenForDock) formVisible=$($form -and -not $form.IsDisposed -and $form.Visible)" } catch { }
  }
  if ($hidden) {
    Hide-HudMenu
    if ($hitForm -and -not $hitForm.IsDisposed -and $hitForm.Visible) {
      [AiBatteryNative]::ShowWindow($hitForm.Handle, [AiBatteryNative]::SW_HIDE) | Out-Null
      $hitForm.Hide()
    }
    if ($form -and -not $form.IsDisposed -and $form.Visible) {
      [AiBatteryNative]::ShowWindow($form.Handle, [AiBatteryNative]::SW_HIDE) | Out-Null
      $form.Hide()
    }
    return
  }

  if ($form -and -not $form.IsDisposed) {
    if (-not $form.Visible) { $form.Show() }
    # Always issue the native show: the managed Visible flag reports true even
    # when the first Show() was suppressed by an SW_HIDE STARTUPINFO.
    [AiBatteryNative]::ShowWindow($form.Handle, [AiBatteryNative]::SW_SHOWNOACTIVATE) | Out-Null
  }
  Show-HitForm
  Sync-HitFormBounds
}

function Set-HudHiddenForFullscreen([bool]$Hidden) {
  if ($script:hudHiddenForFullscreen -eq $Hidden) { return }
  $script:hudHiddenForFullscreen = $Hidden
  Apply-HudHiddenState
}

function Set-HudHiddenForDock([bool]$Hidden) {
  if ($script:hudHiddenForDock -eq $Hidden) { return }
  $script:hudHiddenForDock = $Hidden
  Apply-HudHiddenState
}

# --- Terminal-docked placement -------------------------------------------
# When -DockWindowHandle is given, the terminal is shortened by one status
# row and a borderless HUD strip occupies the released pixels immediately
# below it. Codex keeps its native status line and owns its viewport directly;
# the HUD supplies only the second AI Battery row.
