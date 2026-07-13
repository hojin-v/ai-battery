function Get-HudDpi {
  try {
    if ($form -and -not $form.IsDisposed -and $form.Handle -ne [IntPtr]::Zero) {
      $windowDpi = [AiBatteryNative]::GetDpiForWindow($form.Handle)
      if ($windowDpi -gt 0) { return [int]$windowDpi }
    }
  } catch {
    # Fall back to the desktop graphics DPI below.
  }

  $graphics = $null
  try {
    $graphics = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
    if ($graphics.DpiX -gt 0) { return [int][math]::Round($graphics.DpiX) }
  } catch {
    # Use the WinForms baseline when the desktop DPI cannot be queried.
  } finally {
    if ($graphics) { $graphics.Dispose() }
  }

  return 96
}

function Update-HudDpiScale {
  $dpi = [math]::Max(96, (Get-HudDpi))
  $script:hudDpi = [int]$dpi
  $script:hudScale = [double]$script:hudDpi / 96.0
}

function Scale-HudValue([double]$Value) {
  if ($Value -eq 0) { return 0 }
  $scaled = [int][math]::Round($Value * $script:hudScale)
  if ($Value -gt 0) { return [math]::Max(1, $scaled) }
  return $scaled
}

function New-HudPadding([int]$Left, [int]$Top, [int]$Right, [int]$Bottom) {
  return [System.Windows.Forms.Padding]::new(
    (Scale-HudValue $Left),
    (Scale-HudValue $Top),
    (Scale-HudValue $Right),
    (Scale-HudValue $Bottom)
  )
}

function New-HudBitmapSurface([int]$Width, [int]$Height) {
  $scale = [math]::Max(1.0, [double]$script:hudScale)
  $bitmapWidth = [math]::Max(1, [int][math]::Round($Width * $scale))
  $bitmapHeight = [math]::Max(1, [int][math]::Round($Height * $scale))
  $bitmap = [System.Drawing.Bitmap]::new($bitmapWidth, $bitmapHeight)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  if ([math]::Abs($scale - 1.0) -gt 0.001) {
    $graphics.ScaleTransform([single]$scale, [single]$scale)
  }
  return @{
    Bitmap = $bitmap
    Graphics = $graphics
  }
}

function Test-HudTransparentSurface {
  $value = $Transparent
  if (-not $value) { $value = $env:AI_BATTERY_HUD_TRANSPARENT }
  if (-not $value) { $value = $env:CLAUDEX_BATTERY_HUD_TRANSPARENT }
  if (-not $value) { return $true }
  $normalized = ([string]$value).Trim().ToLowerInvariant()
  return -not (@("0", "false", "no", "off", "solid") -contains $normalized)
}

function Test-HudContrastBackdrop {
  $normalized = ([string]$Backdrop).Trim().ToLowerInvariant()
  if (-not $normalized) { $normalized = "off" }
  return @("1", "true", "yes", "on", "solid", "backdrop") -contains $normalized
}

Update-HudDpiScale
$script:hudDarkText = Test-HudDarkText

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

  $outlineColor = [System.Drawing.Color]::FromArgb(170, 170, 170)
  $mutedColor = [System.Drawing.Color]::FromArgb(120, 120, 120)
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

  $outlineColor = [System.Drawing.Color]::FromArgb(170, 170, 170)
  $mutedColor = [System.Drawing.Color]::FromArgb(120, 120, 120)
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

function New-BatteryImage([Nullable[int]]$Percent, [bool]$Running = $true, [int]$Width = 36, [int]$Height = 16, [bool]$DrawText = $true) {
  $surface = New-HudBitmapSurface $Width $Height
  $bitmap = $surface.Bitmap
  $graphics = $surface.Graphics
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $outlineColor = [System.Drawing.Color]::FromArgb(170, 170, 170)
  $mutedColor = [System.Drawing.Color]::FromArgb(120, 120, 120)
  if ($script:hudDarkText) {
    $outlineColor = [System.Drawing.Color]::FromArgb(58, 58, 58)
    $mutedColor = [System.Drawing.Color]::FromArgb(98, 98, 98)
  }
  $activeOutlineColor = if ($Running) { $outlineColor } else { $mutedColor }
  # The fill always keeps its charge color (matching the terminal bar);
  # running state is signalled by the outline and text colors instead.
  $fillColor = Get-PercentColor $Percent
  $outlinePen = [System.Drawing.Pen]::new($(if ($null -eq $Percent) { $mutedColor } else { $activeOutlineColor }), 1.0)
  $fillBrush = [System.Drawing.SolidBrush]::new($fillColor)
  $interiorColor = if ($script:hudDarkText) {
    [System.Drawing.Color]::FromArgb(246, 246, 246)
  } else {
    # A solid dark interior keeps the desktop from bleeding through the empty
    # part of the battery, so the percent text stays readable on any wallpaper.
    [System.Drawing.Color]::FromArgb(46, 46, 46)
  }
  $interiorBrush = [System.Drawing.SolidBrush]::new($interiorColor)
  $terminalBrush = [System.Drawing.SolidBrush]::new($(if ($null -eq $Percent) { $mutedColor } else { $activeOutlineColor }))
  $textBrush = [System.Drawing.SolidBrush]::new((Get-HudBatteryTextColor $Running))
  $batteryText = if ($null -eq $Percent) { "--" } else { [string][int]$Percent }
  $fontSize = if ($batteryText.Length -ge 3) { 4.4 } elseif ($batteryText.Length -ge 2) { 5.1 } else { 5.8 }
  $batteryFont = $null
  $centerFormat = [System.Drawing.StringFormat]::new()
  $centerFormat.Alignment = [System.Drawing.StringAlignment]::Center
  $centerFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
  $centerFormat.Trimming = [System.Drawing.StringTrimming]::None
  $centerFormat.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap

  try {
    $bodyX = 1
    $bodyY = 3
    $bodyW = $Width - 6
    $bodyH = $Height - 6
    $capW = 2
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
    if ($DrawText) {
      $textRect = [System.Drawing.RectangleF]::new($bodyX + 3, $bodyY + 2.5, $bodyW - 6, $bodyH - 4)
      do {
        if ($batteryFont) { $batteryFont.Dispose() }
        $fontFamily = if ($font) { $font.FontFamily.Name } else { "Segoe UI" }
        $batteryFont = [System.Drawing.Font]::new($fontFamily, $fontSize, [System.Drawing.FontStyle]::Regular)
        $textSize = $graphics.MeasureString($batteryText, $batteryFont)
        if ($textSize.Width -le ($textRect.Width + 1) -or $fontSize -le 4.0) { break }
        $fontSize -= 0.4
      } while ($true)

      $graphics.DrawString($batteryText, $batteryFont, $textBrush, $textRect, $centerFormat)
    }
  } finally {
    $outlinePen.Dispose()
    $fillBrush.Dispose()
    $interiorBrush.Dispose()
    $terminalBrush.Dispose()
    $textBrush.Dispose()
    if ($batteryFont) { $batteryFont.Dispose() }
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
  $panel.Width = 276
  $panel.Height = 22
  $panel.FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
  $panel.WrapContents = $false
  $panel.Margin = [System.Windows.Forms.Padding]::new(0)
  $panel.Padding = [System.Windows.Forms.Padding]::new(4, 1, 4, 1)
  $panel.BackColor = [System.Drawing.SystemColors]::Menu

  $name = New-StatusMenuLabel $Font 44
  $icon = New-Object System.Windows.Forms.PictureBox
  $icon.Width = 40
  $icon.Height = 20
  $icon.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
  $icon.Margin = [System.Windows.Forms.Padding]::new(0)
  $icon.BackColor = [System.Drawing.SystemColors]::Menu
  $percent = New-StatusMenuLabel $Font 0 ([System.Drawing.ContentAlignment]::MiddleRight)
  $reset = New-StatusMenuLabel $Font 66
  $week = New-StatusMenuLabel $Font 56
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
