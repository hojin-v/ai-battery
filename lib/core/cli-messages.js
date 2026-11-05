import { cliLanguage } from "./cli-help.js";

// Translate at the display boundary. JSON reports keep their original values.
// Placeholders preserve paths, commands and external tool output verbatim.
const messages = [
  ["AI Battery config is invalid and was left untouched: {path}", "AI Battery config JSON이 올바르지 않습니다. 파일 유지: {path}", "Invalid AI Battery config JSON. File preserved: {path}"],
  ["AI Battery config ownership could not be verified; file was left untouched: {path}", "AI Battery config의 소유권을 확인할 수 없습니다. 파일 유지: {path}", "Unverified AI Battery config. File preserved: {path}"],
  ["AI Battery config providers must be a JSON object: {path}", "config의 providers는 JSON object여야 합니다. 파일 유지: {path}"],
  ["Integration symlink target changed; left untouched: {path}", "연동 파일의 symlink 대상이 변경됐습니다. 파일 유지: {path}", "Integration symlink changed. File preserved: {path}"],
  ["AI Battery integration block was edited; kept the file and recovery record: {path}", "연동 설정이 수정됐습니다. 파일·복구 기록 유지: {path}", "Integration was edited. File and recovery record preserved: {path}"],
  ["Cannot record an empty integration block: {path}", "빈 연동 설정은 저장할 수 없습니다: {path}"],
  ["Unrestored integration files remain; kept recovery metadata", "복원하지 못한 연동 파일이 남아 있습니다. 복구 기록을 유지합니다.", "Unrestored integrations remain. Recovery records preserved."],
  ["Refusing to clean a shared, protected, or symlinked directory", "공유·보호 경로 또는 symlink 디렉터리는 정리하지 않습니다."],
  ["Refusing to clean a symlinked runtime directory: {path}", "symlink runtime 디렉터리는 정리하지 않습니다: {path}"],
  ["Refusing to replace dangling symlink: {path}", "대상이 없는 symlink는 교체하지 않습니다: {path}"],
  ["LaunchAgent ownership could not be verified; left untouched: {path}", "LaunchAgent 소유권을 확인할 수 없습니다. 파일 유지: {path}"],
  ["Linux autostart ownership could not be verified; left untouched: {path}", "Linux 자동 실행 파일의 소유권을 확인할 수 없습니다. 파일 유지: {path}"],
  ["Linux HUD is still stopping; retry shortly", "Linux HUD를 종료 중입니다. 잠시 후 다시 실행하세요."],
  ["GNOME HUD extension ownership could not be verified; left untouched: {path}", "GNOME HUD 확장의 소유권을 확인할 수 없습니다. 파일 유지: {path}"],
  ["Could not read Windows user PATH; leaving it unchanged", "Windows 사용자 PATH를 읽지 못했습니다. 기존 값을 유지합니다."],
  ["Could not remove the AI Battery entry from Windows user PATH; kept the recovery record", "Windows PATH에서 AI Battery를 제거하지 못했습니다. 복구 기록을 유지합니다."],
  ["Skipped Windows user PATH update for {path}", "Windows PATH 갱신을 건너뛰었습니다: {path}"],
  ["Could not update the Windows user PATH. Add {path} before the original codex manually.", "Windows PATH를 갱신하지 못했습니다. 원본 codex보다 앞에 추가하세요: {path}", "Windows PATH update failed. Add before the original codex: {path}"],
  ["Could not read {label}: {detail}", "파일을 읽지 못했습니다: {label}\n{detail}"],
  ["{label} must contain a JSON object", "JSON object가 필요합니다: {label}"],
  ["Could not parse {label}; the file was left untouched: {detail}", "JSON을 읽지 못했습니다. 파일 유지: {label}\n{detail}", "Invalid JSON. File preserved: {label}\n{detail}"],
  ["Claude settings at {path}", "Claude settings · {path}", "Claude settings · {path}"],
  ["Claude settings were not changed: {detail}", "Claude 설정을 유지했습니다: {detail}"],
  ["A restorable Claude statusLine backup already belongs to {path}; refusing to modify a different HOME", "다른 HOME의 Claude 복구 기록이 있습니다. 설정 유지: {path}"],
  ["A restorable Codex status_line backup already belongs to {path}; refusing to modify a different CODEX_HOME", "다른 CODEX_HOME의 Codex 복구 기록이 있습니다. 설정 유지: {path}"],
  ["Claude statusLine backup belongs to {path}; refusing to alter a different HOME", "다른 HOME의 Claude 복구 기록이 있습니다. 설정 유지: {path}"],
  ["Claude statusLine exists but does not look like AI Battery's command: {command}", "다른 도구의 Claude statusLine을 유지합니다: {command}"],
  ["Claude statusLine is already configured by another tool. Re-run with --force to replace it with a restorable backup.", "다른 도구의 statusLine을 유지합니다. 교체: ai-battery setup claude --force", "Existing statusLine preserved. Replace: ai-battery setup claude --force"],
  ["Claude statusLine is configured by another tool", "다른 도구의 statusLine을 유지합니다.", "Existing statusLine preserved."],
  ["Claude settings already match the pre-setup snapshot", "Claude 설정이 이미 복원돼 있습니다.", "Claude settings already restored."],
  ["No Claude statusLine is configured", "Claude statusLine: not configured", "Claude statusLine: not configured"],
  ["No Codex status_line backup found", "Codex status_line: no backup", "Codex status_line: no backup"],
  ["Codex config file is already missing", "Codex config: not found", "Codex config: not found"],
  ["Codex status_line already matches the pre-setup snapshot", "Codex status_line이 이미 복원돼 있습니다.", "Codex status_line already restored."],
  ["Codex config changed after AI Battery setup; left it untouched", "Codex 설정이 수정됐습니다. 파일·복구 기록을 유지합니다.", "Codex config was edited. File and recovery record preserved."],
  ["Configured Codex wrapper changed after setup; kept its PATH and recovery record", "Codex wrapper가 수정됐습니다. PATH·복구 기록을 유지합니다.", "Codex wrapper was edited. PATH and recovery record preserved."],
  ["Managed wrapper is outside AI Battery-owned paths and no backup is available for restore", "복구 파일이 없는 외부 Codex wrapper를 유지합니다.", "External Codex wrapper preserved: no restore backup."],
  ["Managed Codex wrapper found but left untouched because no restore backup was available", "복구 파일이 없는 Codex wrapper를 유지합니다.", "Codex wrapper preserved: no restore backup."],
  ["No managed Codex wrapper found", "Codex wrapper: not installed", "Codex wrapper: not installed"],
  ["codex command was not found on PATH", "PATH에서 codex를 찾을 수 없습니다.", "codex not found on PATH."],
  ["Refusing to replace the original codex command at {path}", "원본 codex 명령을 유지합니다: {path}"],
  ["Refusing to replace unmanaged codex command at {path}. Set AI_BATTERY_SHIM_DIR to an empty AI Battery-owned directory.", "기존 codex 명령을 유지합니다: {path}\nAI_BATTERY_SHIM_DIR에 비어 있는 전용 디렉터리를 지정하세요."],
  ["Could not safely detach the legacy Codex integration; kept recovery metadata. Run ai-battery reset codex for details.", "이전 Codex 연동을 복원하지 못했습니다. 복구 기록을 유지합니다. 확인: ai-battery reset codex", "Legacy Codex restore failed. Recovery records preserved. Run: ai-battery reset codex"],
  ["tmux status integration applies to WSL/Linux/macOS", "tmux 연동은 WSL·Linux·macOS에서 지원합니다."],
  ["Desktop HUD is not supported on this platform", "이 환경에서는 데스크톱 HUD를 지원하지 않습니다."],
  ["rowpty host is Windows-only", "rowpty는 Windows에서 사용합니다."],
  ["vendored rowpty source not found: {path}", "rowpty source를 찾을 수 없습니다: {path}"],
  [".NET Framework csc.exe not found under %WINDIR%\\Microsoft.NET", "%WINDIR%\\Microsoft.NET에서 csc.exe를 찾을 수 없습니다."],
  ["csc.exe failed to compile rowpty: {detail}", "rowpty build 실패: {detail}"],
  ["capture-claude expected Claude statusline JSON on stdin", "Claude statusLine JSON을 표준 입력으로 전달하세요."],
  ["capture-claude received invalid JSON", "Claude statusLine JSON이 올바르지 않습니다."],
  ["Could not write macOS menu bar image", "macOS 메뉴 막대 이미지를 저장하지 못했습니다."],
  ["Could not write macOS menu detail image", "macOS 메뉴 상세 이미지를 저장하지 못했습니다."],
  ["wslpath failed while resolving the HUD PowerShell script path", "HUD 경로를 변환하지 못했습니다. wslpath를 확인하세요."],
  ["{option} must be one of: {choices}", "{option} 값은 {choices} 중에서 선택하세요."],
  ["ConPTY input pipe cannot be configured safely", "ConPTY 입력 파이프를 설정할 수 없습니다."],
  ["ConPTY blocking input configuration failed: {code}", "ConPTY 입력 설정 실패: {code}"],
  ["Cannot safely pass shell metacharacters through legacy batch command {path}. Use an .exe/.js entrypoint or an npm-generated .cmd shim instead.", "batch 명령에 특수문자를 전달할 수 없습니다: {path}\n.exe·.js 또는 npm이 생성한 .cmd를 사용하세요."],
  ["Private runtime does not expose VT raw input", "전용 Node runtime에서 VT raw input을 사용할 수 없습니다."],
  ["Private runtime is unavailable and automatic download is disabled", "전용 Node runtime이 없고 자동 다운로드가 꺼져 있습니다."],
  ["Windows PTY runtime does not support architecture {arch}", "Windows PTY runtime이 {arch} 아키텍처를 지원하지 않습니다."],
  ["Node runtime SHA256 verification failed", "Node runtime SHA256 검증에 실패했습니다."],
  ["Another terminal is preparing the Node runtime; retry after it finishes", "다른 터미널에서 Node runtime을 준비 중입니다. 완료 후 다시 실행하세요."],
  ["Runtime extraction failed: {detail}", "Node runtime 압축 해제 실패: {detail}"],
  ["Downloaded runtime failed its version check", "다운로드한 Node runtime의 버전을 확인할 수 없습니다."],
  ["CODEX_HOME is set. Codex /resume and AI Battery both use: {path}", "CODEX_HOME · /resume: {path}", "CODEX_HOME · /resume: {path}"],
  ["CODEX_HOME contains a comma and the literal path does not exist. Multiple homes are not supported; correct CODEX_HOME before using /resume.", "CODEX_HOME에 존재하는 경로 하나를 지정하세요. 쉼표로 여러 경로를 지정할 수 없습니다.", "Set CODEX_HOME to one existing directory; comma-separated paths are unsupported."],
  ["Codex session directory was not found: {path}", "Codex 로그를 찾을 수 없습니다: {path}", "Codex logs not found: {path}"],
  ["Codex provider is hidden. Run: ai-battery on codex", "Codex 사용량 표시 켜기: ai-battery on codex", "Show Codex usage: ai-battery on codex"],
  ["Plain \"codex\" still resolves to an AI Battery wrapper outside the configured shim. Run: ai-battery reset codex", "이전 Codex wrapper가 남아 있습니다. 복원: ai-battery reset codex", "Legacy Codex wrapper detected. Restore: ai-battery reset codex"],
  ["A Codex backup is available for restore: {path}", "Codex 복구 파일: {path}", "Codex restore backup: {path}"],
  ["Plain \"codex\" does not resolve to the AI Battery wrapper in this shell. Ensure {path} is before the original codex on PATH, then {action}.", "PATH에서 원본 codex보다 앞에 배치하세요: {path}\n{action}", "Place before the original codex on PATH: {path}\n{action}"],
  ["open a new terminal or run \"hash -r\" in the parent shell", "새 터미널을 열거나 현재 셸에서 hash -r을 실행하세요.", "Open a new terminal or run hash -r."],
  ["open a new cmd/PowerShell, or run: {command}", "새 cmd/PowerShell을 열거나 실행하세요: {command}", "Open a new cmd/PowerShell, or run: {command}"],
  ["AI Battery runner is missing or not executable: {path}", "AI Battery runner를 실행할 수 없습니다: {path}", "AI Battery runner unavailable: {path}"],
  ["Codex wrapper needs python3 for the POSIX PTY row. Install Python 3, then run plain \"codex\" again.", "Codex 상태줄에 python3가 필요합니다. Python 3 설치 후 codex를 다시 실행하세요.", "Install Python 3 for the Codex terminal row, then restart codex."],
  ["Original codex path saved by setup no longer exists: {path}", "저장된 원본 codex 경로를 찾을 수 없습니다: {path}"],
  ["Codex wrapper pins installation paths. Run: ai-battery setup codex", "Codex wrapper 갱신: ai-battery setup codex --wrap-codex", "Refresh Codex wrapper: ai-battery setup codex --wrap-codex"],
  ["Original codex was not found on PATH.", "PATH에서 원본 codex를 찾을 수 없습니다."],
  ["Current Codex was not started through AI Battery. Exit this Codex session and run plain \"codex\" again from a normal terminal.", "변경 사항을 적용하려면 Codex를 종료하고 터미널에서 다시 실행하세요.", "Restart Codex from your terminal to apply the changes."],
  ["Claude statusLine is not configured. Run: ai-battery setup claude", "Claude 사용량 연동: ai-battery setup claude", "Configure Claude usage: ai-battery setup claude"],
  ["Claude statusLine belongs to another tool. AI Battery will not replace it without --force.", "다른 도구의 Claude statusLine을 유지합니다. 교체: ai-battery setup claude --force", "Existing Claude statusLine preserved. Replace: ai-battery setup claude --force"],
  ["Claude statusLine is managed by an older AI Battery setup. Run: ai-battery setup claude", "Claude 연동 갱신: ai-battery setup claude", "Refresh Claude integration: ai-battery setup claude"],
  ["Windows Codex uses the PTY compositor with a private VT-capable Node runtime when needed.", "Windows layout: composite", "Windows layout: composite"],
  ["Windows compositor dependencies are missing; Codex uses the native HUD fallback.", "compositor 의존성이 없어 HUD로 표시합니다.", "Compositor dependencies missing; using the native HUD."],
  ["Windows Codex is configured for native fullscreen mode with the docked TUI battery HUD. Codex owns scrolling, input, and its built-in status line directly.", "Windows layout: fullscreen · docked HUD", "Windows layout: fullscreen · docked HUD"],
  ["Windows Codex uses native fullscreen mode with the docked TUI battery HUD. Codex owns scrolling, input, and its built-in status line directly.", "Windows layout: fullscreen · docked HUD", "Windows layout: fullscreen · docked HUD"],
  ["Windows Codex is configured with no AI Battery terminal display.", "Windows layout: plain", "Windows layout: plain"],
  ["Windows Codex is configured for the experimental inline terminal row. It uses no ConPTY/HUD, but cannot reserve terminal space.", "Windows layout: inline (experimental)", "Windows layout: inline (experimental)"],
  ["Windows Codex is configured for the docked HUD.", "Windows layout: docked HUD", "Windows layout: docked HUD"],
  ["Windows Codex is configured for the same-console overlay row.", "Windows layout: overlay", "Windows layout: overlay"],
  ["rowpty.exe not found, so the Windows Codex TUI uses the overlay fallback. Run: ai-battery setup codex (compiles it locally with the in-box csc.exe).", "rowpty가 없어 overlay로 표시합니다. 설치: ai-battery setup codex --wrap-codex", "rowpty missing; using overlay. Install: ai-battery setup codex --wrap-codex"],
  ["conpty.dll is not next to rowpty.exe, so the OS in-box ConPTY is used and Codex history rendering degrades (ghost frames, reordered text). Run: ai-battery setup codex with the node-pty package installed.", "conpty.dll이 없어 OS ConPTY를 사용합니다. node-pty 설치 후 Codex 연동을 갱신하세요.", "conpty.dll missing; using OS ConPTY. Install node-pty and refresh the Codex integration."],
  ["No Codex session logs found", "Codex 로그가 없습니다."],
  ["No Codex rate-limit event found in recent logs", "최근 Codex 로그에 사용량 정보가 없습니다."],
  ["No Claude Code project logs found", "Claude Code 로그가 없습니다."],
  ["No Claude usage event found in recent logs", "최근 Claude 로그에 사용량 정보가 없습니다."],
  ["Found a matching line but could not parse it", "사용량 로그를 해석할 수 없습니다."],
  ["Found a Claude rate-limit line but could not parse it", "Claude rate-limit 로그를 해석할 수 없습니다."],
  ["invalid JSON from npm registry", "npm registry의 JSON 응답이 올바르지 않습니다."],
  ["npm registry response did not include a version", "npm registry 응답에 버전 정보가 없습니다."],
  ["timeout", "응답 시간이 초과됐습니다."]
];

const rules = messages.map(([source, korean, english = source]) => {
  const keys = [];
  const parts = source.split(/(\{\w+\})/).map((part) => {
    if (/^\{\w+\}$/.test(part)) { keys.push(part.slice(1, -1)); return "([\\s\\S]+?)"; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { pattern: new RegExp(`^${parts.join("")}$`), keys, korean, english };
});

export function messageText(value, env = process.env) {
  const text = String(value ?? "");
  for (const rule of rules) {
    const match = text.match(rule.pattern);
    if (!match) continue;
    const values = Object.fromEntries(rule.keys.map((key, index) => [key, match[index + 1]]));
    const template = cliLanguage(env) === "ko" ? rule.korean : rule.english;
    return template.replace(/\{(\w+)\}/g, (_, key) => ["detail", "label", "action"].includes(key)
      ? messageText(values[key], env) : values[key]);
  }
  return text;
}

export function errorText(error, env = process.env) {
  const raw = error?.message ?? String(error);
  const text = messageText(raw, env);
  const code = error?.code || raw.match(/^([A-Z][A-Z_]+):/)?.[1];
  const hints = {
    EACCES: ["Check file permissions.", "파일 접근 권한을 확인하세요."],
    EPERM: ["Check permissions and whether the file is in use.", "권한 또는 파일 사용 여부를 확인하세요."],
    ENOENT: ["Check the file or command path.", "파일 또는 명령 경로를 확인하세요."],
    EBUSY: ["Close the program using this file and retry.", "파일을 사용하는 프로그램을 종료한 뒤 다시 실행하세요."],
    EROFS: ["Choose a writable directory.", "쓸 수 있는 디렉터리를 지정하세요."]
  };
  if (text === raw && hints[code]) return `${text}\n${hints[code][cliLanguage(env) === "ko" ? 1 : 0]}`;
  return text;
}
