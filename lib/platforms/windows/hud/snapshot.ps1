function Invoke-AiBatteryJson {
  if ($UseWsl) {
    $output = & wsl.exe bash -lc "$BatteryCommand 2>/dev/null"
  } else {
    $output = Invoke-LocalBatteryCommandOutput $BatteryCommand
  }
  $text = ($output -join "`n").Trim()
  if (-not $text) { throw "ai-battery produced no output" }
  return $text | ConvertFrom-Json
}

function Invoke-LocalBatteryCommandOutput([string]$Command) {
  try {
    return Invoke-Expression "$Command 2>`$null"
  } catch {
    $trimmed = $Command.TrimStart()
    if ($trimmed.StartsWith("&")) { throw }
    return Invoke-Expression "& $Command 2>`$null"
  }
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

function Test-HudDarkText {
  $normalized = ([string]$Text).Trim().ToLowerInvariant()
  return @("dark", "black", "ink", "light-taskbar", "lightbar") -contains $normalized
}

function Get-HudActiveTextColor {
  if ($script:hudDarkText) { return [System.Drawing.Color]::FromArgb(28, 28, 28) }
  return [System.Drawing.Color]::FromArgb(235, 235, 235)
}

function Get-HudMutedTextColor {
  if ($script:hudDarkText) { return [System.Drawing.Color]::FromArgb(88, 88, 88) }
  return [System.Drawing.Color]::FromArgb(145, 145, 145)
}

function Get-HudDividerColor {
  if ($script:hudDarkText) { return [System.Drawing.Color]::FromArgb(100, 100, 100) }
  return [System.Drawing.Color]::FromArgb(132, 132, 132)
}

function Get-HudBatteryTextColor([bool]$Running) {
  if ($script:hudDarkText) {
    if ($Running) { return [System.Drawing.Color]::FromArgb(20, 20, 20) }
    return [System.Drawing.Color]::FromArgb(78, 78, 78)
  }
  if ($Running) { return [System.Drawing.Color]::FromArgb(255, 255, 255) }
  return [System.Drawing.Color]::FromArgb(235, 235, 235)
}

function Get-ActivityColor($Result) {
  if ($Result -and $Result.running) { return Get-HudActiveTextColor }
  return Get-HudMutedTextColor
}

function Get-DividerColor {
  return Get-HudDividerColor
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
        try {
          $output = Invoke-Expression "$Command 2>`$null"
        } catch {
          $trimmed = $Command.TrimStart()
          if ($trimmed.StartsWith("&")) { throw }
          $output = Invoke-Expression "& $Command 2>`$null"
        }
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
