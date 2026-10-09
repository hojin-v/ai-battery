#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_PATH="${AI_BATTERY_CODEX_E2E_REPORT:-$ROOT/codex-compositor-e2e-report.json}"
TIMEOUT_SECONDS="${AI_BATTERY_CODEX_E2E_TIMEOUT_SECONDS:-90}"
PS_SCRIPT_WIN="$(wslpath -w "$ROOT/scripts/windows-codex-compositor-e2e.ps1")"
LAUNCHER_WIN="$(wslpath -w "$ROOT/scripts/launch-windows-codex-compositor-e2e.ps1")"
REPORT_WIN="$(wslpath -w "$REPORT_PATH")"

rm -f "$REPORT_PATH"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$LAUNCHER_WIN" \
  -SmokeScript "$PS_SCRIPT_WIN" \
  -ReportPath "$REPORT_WIN" \
  -TimeoutSeconds "$TIMEOUT_SECONDS"

if [[ ! -f "$REPORT_PATH" ]]; then
  echo "FAIL: no report at $REPORT_PATH" >&2
  exit 1
fi
cat "$REPORT_PATH"
