param(
  [Parameter(Mandatory = $true)][string]$SmokeScript,
  [Parameter(Mandatory = $true)][string]$ReportPath,
  [string]$TimeoutSeconds = "90"
)

function Quote-WindowsArg($Value) {
  $text = [string]$Value
  if ($text.Length -gt 0 -and $text -notmatch '[\s"]' -and -not $text.StartsWith("\\")) {
    return $text
  }
  return '"' + $text.Replace('"', '\"') + '"'
}

$childArgs = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", $SmokeScript,
  "-ReportPath", $ReportPath,
  "-TimeoutSeconds", $TimeoutSeconds
)
$argumentLine = (($childArgs | ForEach-Object { Quote-WindowsArg $_ }) -join " ")
$process = Start-Process -FilePath "powershell.exe" -ArgumentList $argumentLine -Wait -PassThru
exit $process.ExitCode
