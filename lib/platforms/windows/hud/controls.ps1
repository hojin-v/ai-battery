function Set-HudBatteryImage($Box, [Nullable[int]]$Percent, [bool]$Running) {
  $oldImage = $Box.Image
  $Box.Image = New-BatteryImage $Percent $Running 36 16 $false
  $Box.AccessibleName = if ($null -eq $Percent) { "--" } else { [string][int]$Percent }
  $Box.ForeColor = Get-HudBatteryTextColor $Running
  $Box.Visible = $true
  $Box.Tag = $true
  $Box.Invalidate()
  if ($oldImage) { $oldImage.Dispose() }
}

function New-HudGlyphImage([string]$Kind, [System.Drawing.Color]$Color, [int]$Width = 21, [int]$Height = 18) {
  $surface = New-HudBitmapSurface $Width $Height
  $bitmap = $surface.Bitmap
  $graphics = $surface.Graphics
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
    $Label.Width = if ($null -ne $FixedWidth -and $FixedWidth -gt 0) {
      [int]$FixedWidth
    } else {
      (Get-LabelTextWidth $Label) + (Scale-HudValue 1)
    }
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
    $Divider.Width = Scale-HudValue 1
    $Divider.Tag = $true
  }
}

function Get-HudTextWidth([string]$Value, $Font = $font) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return 0 }
  return [System.Windows.Forms.TextRenderer]::MeasureText(
    $Value,
    $Font,
    [System.Drawing.Size]::new(1000, 1000),
    [System.Windows.Forms.TextFormatFlags]::NoPadding
  ).Width
}

function Get-SharedHudColumnWidth([string[]]$Values, [int]$Minimum = 0) {
  $width = Scale-HudValue $Minimum
  foreach ($value in $Values) {
    $width = [math]::Max($width, (Get-HudTextWidth $value) + (Scale-HudValue 1))
  }
  return [int]$width
}

function Set-HudParts($Parts, $PrefixLabel, $BatteryBox, $Divider1, $ResetLabel, $Divider2, $WeekLabel, $ExtraLabel, [Nullable[int]]$ResetWidth = $null, [Nullable[int]]$WeekWidth = $null) {
  $PrefixLabel.Text = $Parts.Prefix
  $PrefixLabel.ForeColor = $Parts.TextColor
  $PrefixLabel.Width = Scale-HudValue 48
  $PrefixLabel.Visible = $true
  $PrefixLabel.Tag = $true
  Set-HudBatteryImage $BatteryBox $Parts.Percent $Parts.Running
  Set-HudDivider $Divider1 $Parts.ResetValue
  Set-HudMetricLabel $ResetLabel $Parts.ResetValue $Parts.TextColor $ResetWidth
  Set-HudDivider $Divider2 $Parts.WeekValue
  Set-HudMetricLabel $WeekLabel $Parts.WeekValue $Parts.TextColor $WeekWidth
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
  $bothRows = $script:codexRowVisible -and $script:claudeRowVisible
  if ($providerDivider) {
    $providerDivider.Visible = $bothRows
    $providerDivider.Tag = $bothRows
  }
  if ($script:dockTuiStatusline) {
    Set-DockedTuiWindowRegion
    Sync-HitFormBounds
    return
  }
  $contentWidth = [math]::Max($codexWidth, $claudeWidth)
  $desiredWidth = $panel.Padding.Left + $panel.Padding.Right +
    $contentWidth +
    (Scale-HudValue 1)
  $desiredWidth = [math]::Max((Scale-HudValue 150), [int][math]::Ceiling($desiredWidth))

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
  $codexPrefixLabel.ForeColor = Get-HudMutedTextColor
  $codexPrefixLabel.Width = (Get-LabelTextWidth $codexPrefixLabel) + (Scale-HudValue 1)
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
    Invalidate-DockedTuiIfChanged $Snapshot
    Update-HudVisibilityForFullscreen
    return
  }

  try {
    $texts = ConvertTo-HudTexts $Snapshot
    $script:codexRowVisible = [bool]$texts.CodexVisible
    $script:claudeRowVisible = [bool]$texts.ClaudeVisible
    $resetValues = @()
    $weekValues = @()
    if ($texts.CodexVisible) {
      if ($texts.Codex.ResetValue) { $resetValues += $texts.Codex.ResetValue }
      if ($texts.Codex.WeekValue) { $weekValues += $texts.Codex.WeekValue }
    }
    if ($texts.ClaudeVisible) {
      if ($texts.Claude.ResetValue) { $resetValues += $texts.Claude.ResetValue }
      if ($texts.Claude.WeekValue) { $weekValues += $texts.Claude.WeekValue }
    }
    $resetWidth = Get-SharedHudColumnWidth $resetValues
    $weekWidth = Get-SharedHudColumnWidth $weekValues
    if ($texts.CodexVisible) {
      $codexRow.Visible = $true
      Set-HudParts $texts.Codex $codexPrefixLabel $codexIconLabel $codexDivider1 $codexResetLabel $codexDivider2 $codexWeekLabel $codexExtraLabel $resetWidth $weekWidth
    } else {
      $codexRow.Visible = $false
      Set-HudControlsVisible $codexHudControls $false
    }
    if ($texts.ClaudeVisible) {
      $claudeRow.Visible = $true
      Set-HudParts $texts.Claude $claudePrefixLabel $claudeIconLabel $claudeDivider1 $claudeResetLabel $claudeDivider2 $claudeWeekLabel $claudeExtraLabel $resetWidth $weekWidth
    } else {
      $claudeRow.Visible = $false
      Set-HudControlsVisible $claudeHudControls $false
    }
    Resize-HudToContent
  } catch {
    Show-HudMessage "AI Battery unavailable"
  }
  Invalidate-DockedTuiIfChanged $Snapshot
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
# WinEvent hooks wake fullscreen checks immediately on foreground/Z-order/show
# changes. The UI timer is only a fallback for Windows builds or shells that do
# not deliver every event we subscribe to.
$topMostTimer = New-Object System.Windows.Forms.Timer
$topMostTimer.Interval = $script:dockIdleTrackingInterval
$topMostTimer.add_Tick({
  Update-HudVisibilityForFullscreen
  Update-HudDockRequest
  Update-HudDockPlacement
})
$menuAutoHideTimer = New-Object System.Windows.Forms.Timer
$menuAutoHideTimer.Interval = 50
$menuAutoHideTimer.add_Tick({ Update-HudMenuAutoHide })
