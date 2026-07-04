# AI Battery

Codex and Claude Usage Battery Meter

Codex와 Claude Code의 남은 사용량을 배터리처럼 확인하는 터미널 상태 표시 도구입니다.

![npm](https://img.shields.io/npm/v/ai-battery)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20WSL%20%7C%20Linux%20%7C%20macOS-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[Install](#install) · [Features](#features) · [Quick Start](#quick-start) · [Claude StatusLine](#claude-statusline) · [Desktop HUD](#desktop-hud) · [Caution](#caution)

## Overview

`ai-battery`는 Codex와 Claude Code를 사용하면서 남은 사용량과 리셋 시간을 계속 확인하기 위한 작은 상태 표시 도구입니다.

Codex는 로컬 세션 로그의 `rate_limits` 이벤트를 읽고, Claude Code는 `statusLine` hook이 전달하는 rate-limit payload를 캐시해서 사용합니다. Claude가 실제 429 rate-limit hit를 기록한 경우에는 해당 reset 전까지 그 제한을 0%로 반영합니다. 기본 출력은 한 줄로 작게 유지되며, 실행 중인 도구는 흰색, 실행 중이지 않은 도구는 회색으로 표시합니다. 배터리 바 색상만 잔량에 따라 초록, 주황, 빨강으로 바뀝니다.

<img src="docs/terminal-preview.svg" alt="AI Battery terminal preview showing green and red battery bars" width="940">

Markdown의 텍스트 fallback은 렌더러별 블록 문자 높이 차이를 피하려고 바를 생략합니다. 실제 터미널에서는 ANSI 색상과 블록 바가 함께 렌더링됩니다.

```text
Codex 86% │ 5h 18:09 │ 7d 82%  ┃  Claude 4% │ 5h 18:10 │ 7d 71%
```

| Provider | Source | Shows |
| --- | --- | --- |
| Codex | `~/.codex/sessions/**/*.jsonl` | 5h 잔량, 5h 리셋 시각, 7d 잔량 |
| Claude Code | Claude `statusLine` payload cache + 429 hit logs | 5h 잔량, 5h 리셋 시각, 7d 잔량 |
| Claude fallback | `~/.claude/projects/**/*.jsonl` | 최근 턴 토큰 사용량 |

## Features

| Feature | Description |
| --- | --- |
| 공통 사용량 표시 | Codex와 Claude Code 사용량을 같은 형식으로 표시합니다. |
| 리셋 시각 표시 | `5h`, `7d` 창 라벨과 값을 표시합니다. |
| 색상 기준 | 40% 초과 초록, 21-40% 주황, 20% 이하 빨강으로 배터리만 강조합니다. |
| Codex terminal row | Codex 아래에 별도 사용량 행을 고정하는 PTY wrapper를 제공합니다. |
| Claude statusLine | Claude Code 내장 statusLine hook과 실제 429 hit 로그로 Claude rate limit 상태를 읽습니다. |
| HUD / menu bar | Windows native/WSL에서는 floating HUD, macOS에서는 menu bar status item을 제공합니다. |
| npm 실행 | `npm install -g` 또는 `npx`로 실행할 수 있습니다. |

## Platform Support

| Mode | Windows native | WSL | Linux | macOS | Note |
| --- | --- | --- | --- | --- | --- |
| `ai-battery` | 지원 | 지원 | 지원 | 지원 | Node.js 18 이상이 필요합니다. |
| `ai-battery --watch` | 지원 | 지원 | 지원 | 지원 | 터미널 안에서 주기적으로 갱신합니다. |
| Claude statusLine | 지원 | 지원 | 지원 | 지원 | Claude Code `statusLine`에 `node <script>` 명령을 저장합니다. |
| Codex terminal row | 지원 | 지원 | 지원 | 지원 | Windows는 `node-pty`/ConPTY가 있으면 reserved row, 없으면 overlay fallback을 사용합니다. WSL/Linux/macOS는 POSIX PTY와 `python3`를 사용합니다. |
| `ai-battery setup codex` | 지원 | 지원 | 지원 | 지원 | Windows는 `codex.cmd` wrapper, WSL/Linux/macOS는 POSIX shell wrapper를 설치합니다. |
| `ai-battery hud` | 지원 | 지원 | 미지원 | 지원 | Windows/WSL은 PowerShell/WinForms HUD, macOS는 menu bar status item입니다. |

실행 중 감지(흰색/회색 표시)는 Linux/WSL은 `/proc`, macOS는 `ps`, Windows는 PowerShell 프로세스 목록을 사용합니다.

## Install

```bash
npm install -g ai-battery
```

설치하지 않고 바로 실행할 수도 있습니다.

```bash
npx ai-battery
```

이전 이름인 `claudex-battery`, `claudex-battery-run`, `claudex-battery-hud` 명령도 호환 alias로 함께 제공됩니다.

## Quick Start

1. 패키지를 설치합니다.

   ```bash
   npm install -g ai-battery
   ```

2. Claude와 Codex 자동 표시를 설정합니다.

   ```bash
   ai-battery setup
   ```

3. 이후에는 원래 명령을 그대로 사용합니다.

   ```bash
   claude
   codex
   ```

4. 데스크톱 HUD나 macOS menu bar 표시가 필요하면 실행합니다.

   ```bash
   ai-battery hud
   ```

## CLI

```bash
ai-battery
ai-battery --watch 10
ai-battery --json
ai-battery --version
ai-battery --provider codex
ai-battery --provider claude
ai-battery setup
ai-battery uninstall
ai-battery doctor
ai-battery hud
ai-battery off codex
ai-battery on codex
```

| Option | Description |
| --- | --- |
| `--provider all\|codex\|claude` | 표시할 provider를 선택합니다. |
| `--watch [seconds]` | 같은 줄에서 주기적으로 갱신합니다. |
| `--json` | HUD나 다른 도구에서 쓰기 좋은 JSON을 출력합니다. |
| `--bar-width N` | 터미널 배터리 바 길이를 조정합니다. |
| `--show-paths` | 로그 파일 경로와 데이터 관측 시각을 함께 표시합니다. |
| `-v`, `--version` | 설치된 `ai-battery` 버전을 출력합니다. |

`doctor`는 설치 상태와 함께 npm latest 버전을 확인합니다. 네트워크가 막혀 있으면 버전 확인만 건너뛰고 나머지 진단은 계속 표시합니다.

## Uninstall

`off`는 표시만 숨기는 설정이고, `uninstall`은 `setup`과 HUD autostart가 만든 통합 지점을 제거합니다.

```bash
ai-battery uninstall
```

일부만 제거할 수도 있습니다.

```bash
ai-battery uninstall codex
ai-battery uninstall claude
ai-battery uninstall hud
```

이 명령은 AI Battery가 관리 마커를 넣은 Codex wrapper, Claude `statusLine`, HUD/menu bar autostart와 실행 중인 HUD를 정리합니다. 다른 도구가 만든 `codex` 파일이나 Claude `statusLine`은 건드리지 않습니다. 이전 버전이나 `--force`로 기존 파일을 백업한 경우에는 가능한 한 원래 파일/symlink를 복원합니다. 현재 이미 AI Battery wrapper 안에서 실행 중인 Codex 세션의 terminal row는 그 세션을 종료해야 사라집니다.

최신 npm은 패키지의 uninstall lifecycle을 실행하지 않기 때문에 `npm uninstall ai-battery` 또는 `npm uninstall -g ai-battery`만으로는 외부 통합 지점을 자동 정리할 수 없습니다. 완전히 제거하려면 npm 패키지를 지우기 전에 먼저 실행하세요.

```bash
ai-battery uninstall
npm uninstall -g ai-battery
```

이미 npm 패키지를 먼저 지운 뒤라면, 다시 설치한 다음 `ai-battery uninstall`을 실행하거나 아래 항목을 직접 확인해 제거해야 합니다: AI Battery가 만든 Codex wrapper, shell rc의 `# >>> ai-battery setup >>>` block, Claude `statusLine`, HUD/menu bar autostart.

## Setup

`setup`은 한 번만 실행합니다. Claude Code에는 statusLine hook을 설치하고, Codex에는 platform wrapper를 설치해서 이후에는 추가 명령 없이 원래처럼 실행하게 합니다.

```bash
ai-battery setup
```

일부만 설정할 수도 있습니다.

```bash
ai-battery setup claude
ai-battery setup codex
```

Codex wrapper는 기존 `codex` 명령을 직접 덮어쓰지 않습니다. `~/.local/bin`이 이미 PATH에서 원본 `codex`보다 앞에 있고 `~/.local/bin/codex`가 비어 있거나 AI Battery 관리 파일이면 그 위치에 wrapper를 둬서 바로 잡히게 합니다. 그렇지 않으면 `~/.local/share/ai-battery/bin/codex`에 관리형 wrapper를 만들고, 필요한 경우 셸 설정에 이 디렉터리를 PATH 앞쪽으로 추가합니다. `~/.local/bin/codex` 같은 공용 위치에 이미 다른 파일이 있으면 덮어쓰지 않습니다. 새 터미널부터 `codex`가 자동으로 AI Battery 하단 행과 함께 실행됩니다. 같은 터미널에서 이미 `codex`를 실행한 적이 있으면 셸 캐시 때문에 `hash -r`이 한 번 필요할 수 있고, PATH 추가가 필요한 경우에는 `setup` 출력에 표시되는 `source ...` 명령을 실행하세요.

Windows native `cmd`/PowerShell에서는 `codex.cmd` wrapper가 Windows runner를 실행합니다. `node-pty`가 설치되어 있으면 ConPTY로 Codex 화면을 한 줄 짧게 띄워 하단 row를 예약하고, `node-pty`가 없거나 로드되지 않으면 같은 콘솔의 하단에 overlay row를 다시 그리는 fallback을 사용합니다. Claude statusLine은 일반 `cmd`/PowerShell 프롬프트가 아니라 Claude Code 안에서만 표시됩니다.

Codex 하단 행이 보이지 않으면 진단을 실행합니다.

```bash
ai-battery doctor
```

표시할 provider는 짧은 on/off 명령으로 바꿉니다.

```bash
ai-battery off codex
ai-battery on codex
ai-battery off claude
ai-battery on claude
ai-battery off all
ai-battery on all
```

이 설정은 CLI, Claude statusLine, Codex wrapper, HUD에 함께 적용됩니다.

## Codex Terminal Row

Codex 자체 status line은 수정하지 않습니다. `ai-battery setup`은 `codex` wrapper를 설치해서 사용자가 원래처럼 `codex`만 입력해도 `ai-battery-run`이 내부에서 Codex를 한 줄 짧은 PTY 안에서 실행하도록 합니다.

```bash
codex
```

직접 wrapper를 실행해야 하는 고급 사용자는 아래 명령을 사용할 수 있습니다.

```bash
ai-battery-run --provider all codex
```

갱신 주기를 줄이려면 `--interval`을 사용합니다.

```bash
ai-battery-run --interval 1 --provider all codex
```

## Claude StatusLine

Claude Code는 내장 `statusLine` hook을 통해 rate-limit 사용률과 reset 시각을 제공합니다. AI Battery는 여기에 Claude JSONL의 실제 429 rate-limit hit 기록을 함께 반영합니다. 설치 후 Claude는 두 줄을 렌더링합니다.

<img src="docs/claude-statusline-preview.svg" alt="Claude statusLine preview showing colored AI Battery bars" width="940">

```text
Opus high · ~/Projects · main                               83% context left
Codex 71% │ 5h 00:47 │ 7d 90%  Claude 76% │ 5h 00:47 │ 7d 59%
```

첫 줄은 모델, 추론 레벨, workspace root, git branch를 표시하고, 오른쪽 끝에 Claude context 잔량을 고정합니다. 두 번째 줄은 Codex와 Claude의 사용량을 같은 형식으로 표시합니다.

설정:

```bash
ai-battery setup claude
```

제거:

```bash
ai-battery uninstall-claude-statusline
```

Claude가 한 번 이상 statusLine payload를 전달해야 Claude의 사용량 캐시가 생성됩니다. 그 전에는 Claude 로컬 로그 기반 fallback이 표시됩니다.

## Desktop HUD

일반 터미널 위에 외부 프로세스가 안전하게 status line을 덧그리는 방식은 안정적이지 않습니다. 그래서 Windows에서는 floating overlay를, macOS에서는 상단 menu bar status item을 제공합니다. Windows native에서는 WSL 없이 PowerShell/WinForms로 바로 실행되고, WSL에서는 `powershell.exe`를 통해 같은 HUD를 띄웁니다. macOS에서는 투명 배경의 작은 SVG 이미지로 Codex와 Claude 로고, 짧은 미터, 퍼센트만 표시하고, 클릭하면 자세한 상태를 볼 수 있습니다.

```bash
ai-battery hud
```

HUD는 백그라운드에서 실행되고 터미널을 바로 돌려줍니다. Windows HUD는 위치를 드래그로 옮길 수 있으며, 다음 실행 때 저장된 위치를 재사용합니다. macOS menu bar item은 시스템 메뉴바 오른쪽 영역에 표시됩니다.

```text
Codex  [battery:88] │ 5h 00:47 │ 7d 93%
Claude [battery:76] │ 5h 00:47 │ 7d 59%
```

| Command | Role |
| --- | --- |
| `ai-battery hud` / `ai-battery hud start` | Windows floating HUD 또는 macOS menu bar item을 시작합니다. |
| `ai-battery hud stop` | 실행 중인 HUD/menu bar item을 종료합니다. (`--stop`도 동일) |
| `ai-battery hud status` | HUD/menu bar 실행 여부와 autostart 등록 상태를 보여줍니다. |
| `ai-battery hud autostart on` | Windows 로그인 또는 macOS 로그인 시 자동 실행을 등록합니다. |
| `ai-battery hud autostart off` | 자동 실행 등록을 해제합니다. |
| `ai-battery hud autostart status` | 자동 실행 등록 상태만 보여줍니다. |
| `ai-battery hud -Foreground` | 디버깅용으로 터미널에 붙여 실행합니다. |
| `ai-battery hud -Once` | 콘솔에서 한 번만 출력합니다. |
| `ai-battery hud -Interval 2` | 갱신 주기를 바꿉니다. |
| `ai-battery hud -Mode tray` | Windows tray icon 모드로 실행합니다. macOS에서는 menu bar item이 기본입니다. |

Windows autostart는 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`에 사용자 단위로 등록됩니다. Windows native에서는 WSL 없이 바로 실행되고, WSL에서 등록한 경우에는 HUD 스크립트 사본을 `%LOCALAPPDATA%\ai-battery`에 둡니다. macOS autostart는 `~/Library/LaunchAgents/com.ai-battery.hud.plist`로 등록됩니다. ai-battery를 업데이트한 뒤에는 `ai-battery hud autostart on`을 다시 실행해 등록 경로를 갱신하세요.

## Shell Prompt

쉘 프롬프트에 넣을 수도 있습니다.

```bash
export PS1='$(ai-battery --provider codex) '"$PS1"
```

프롬프트 방식은 명령을 실행할 때마다 갱신됩니다. 계속 떠 있는 표시가 필요하면 `ai-battery setup` 또는 `ai-battery hud`를 사용하세요.

## How It Works

```mermaid
flowchart LR
    C[Codex session logs] --> R[ai-battery reader]
    S[Claude statusLine payload] --> K[Claude cache]
    K --> R
    L[Claude local logs] --> F[Fallback token view]
    F --> R
    R --> T[Terminal output]
    R --> P[PTY reserved row]
    R --> H[Desktop HUD / menu bar]
```

Codex는 최근 세션 로그에서 `rate_limits` 이벤트를 찾습니다. Claude Code는 statusLine payload로 사용률과 리셋 시각을 제공하고, 실제 429 rate-limit hit 로그가 있으면 reset 전까지 0%로 반영합니다. fallback 모드에서는 최근 토큰 사용량만 확인할 수 있습니다.

## Tech Stack

| Layer | Technology | Role |
| --- | --- | --- |
| CLI | Node.js | 로그 파싱, Claude cache, ANSI/statusLine 출력 |
| PTY row | Python 3 | Codex 실행용 reserved terminal row |
| HUD launcher | Node.js / Bash compatibility wrapper | Windows native/WSL PowerShell HUD와 macOS menu bar 실행 |
| HUD UI | PowerShell WinForms / AppleScriptObjC | Windows floating overlay, tray icon, macOS menu bar item |
| Data | JSONL logs, statusLine JSON | Codex/Claude 사용량 소스 |

## Source Environment

기본 CLI는 Node.js 18 이상이 있으면 Windows native, WSL, Linux, macOS에서 실행됩니다. Windows native의 Codex terminal row는 Node runner를 사용하며, optional `node-pty`가 있으면 ConPTY reserved row를 사용하고 없으면 overlay fallback을 사용합니다. WSL/Linux/macOS의 `ai-battery-run`은 Python 3와 POSIX PTY를 사용합니다. HUD는 Windows/WSL에서는 PowerShell/WinForms, macOS에서는 내장 `osascript`와 AppleScriptObjC를 사용합니다.

Codex 데이터는 기본적으로 `~/.codex/sessions`를 읽습니다. 다른 위치를 쓰고 있다면 `CODEX_HOME`을 설정하세요.

```bash
CODEX_HOME=/path/to/codex-home ai-battery --provider codex
```

Claude의 사용량 표시는 Claude Code statusLine hook을 설치한 뒤부터 사용할 수 있습니다.

## Caution

- 이 도구는 로컬 로그와 Claude statusLine payload를 읽습니다. 서비스의 공식 과금/한도 화면을 대체하지 않습니다.
- Codex rate limit 이벤트가 아직 생성되지 않았거나 오래된 경우 최신 상태와 차이가 있을 수 있습니다.
- Claude statusLine은 사용률과 reset 시각만 제공하므로, 실제 hit 상태는 Claude가 남긴 429 rate-limit 로그를 함께 읽어 반영합니다.
- HUD는 Windows에서는 PowerShell/WinForms 기반이고, macOS에서는 menu bar status item 기반입니다. WSL에서는 `powershell.exe`와 `wsl.exe`를 함께 사용합니다.
- `ai-battery-run`은 PTY wrapper입니다. 일부 전체 화면 TUI는 화면을 지우는 escape sequence 때문에 status row가 잠시 흔들릴 수 있습니다.
