#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_PATH="${AI_BATTERY_SMOKE_REPORT:-$ROOT/rowpty-smoke-report.json}"
TIMEOUT_SECONDS="${AI_BATTERY_SMOKE_TIMEOUT_SECONDS:-12}"

if ! command -v powershell.exe >/dev/null 2>&1; then
  echo "FAIL: powershell.exe was not found. Run this from WSL with Windows interop enabled." >&2
  exit 1
fi

if ! command -v wslpath >/dev/null 2>&1; then
  echo "FAIL: wslpath was not found." >&2
  exit 1
fi

PS_SCRIPT_WIN="$(wslpath -w "$ROOT/scripts/windows-rowpty-smoke.ps1")"
REPORT_WIN="$(wslpath -w "$REPORT_PATH")"
LAUNCHER="$(mktemp --suffix=.ps1)"
LAUNCHER_WIN="$(wslpath -w "$LAUNCHER")"

cleanup() {
  rm -f "$LAUNCHER"
}
trap cleanup EXIT

cat >"$LAUNCHER" <<'PS1'
param(
  [string]$SmokeScript,
  [string]$ReportPath,
  [string]$TimeoutSeconds
)

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

$childArgs = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", $SmokeScript,
  "-ReportPath", $ReportPath,
  "-TimeoutSeconds", $TimeoutSeconds
)
$argumentLine = Join-WindowsArgs -Values $childArgs
$process = Start-Process -FilePath "powershell.exe" -ArgumentList $argumentLine -Wait -PassThru
exit $process.ExitCode
PS1

rm -f "$REPORT_PATH"

echo "[ai-battery smoke] Opening a native Windows PowerShell console for rowpty smoke testing..."
echo "[ai-battery smoke] Report will be written to: $REPORT_PATH"

set +e
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$LAUNCHER_WIN" \
  -SmokeScript "$PS_SCRIPT_WIN" \
  -ReportPath "$REPORT_WIN" \
  -TimeoutSeconds "$TIMEOUT_SECONDS"
STATUS=$?
set -e

if [[ ! -f "$REPORT_PATH" ]]; then
  echo "FAIL: Windows smoke test did not produce a report at $REPORT_PATH" >&2
  exit "${STATUS:-1}"
fi

echo "[ai-battery smoke] Windows smoke report:"
cat "$REPORT_PATH"
echo

exit "$STATUS"
