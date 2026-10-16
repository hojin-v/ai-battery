# AI Battery

0.1.24: `ai-battery setup`만으로 Claude와 Codex의 사용량 표시를 자동 연결합니다. 원본 Codex 실행 파일과 기존 설정은 보존합니다. `reset settings`는 AI Battery의 변경을 복원하며 npm 패키지 삭제는 별도로 진행합니다.

[한국어](README.md) · [English](docs/i18n/en/) · [日本語](docs/i18n/ja/) · [中文](docs/i18n/zh/) · [Español](docs/i18n/es/)

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

| Provider        | Source                                           | Shows                          |
| --------------- | ------------------------------------------------ | ------------------------------ |
| Codex           | `~/.codex/sessions/**/*.jsonl`                   | 5h 잔량, 5h 리셋 시각, 7d 잔량 |
| Claude Code     | Claude `statusLine` payload cache + 429 hit logs | 5h 잔량, 5h 리셋 시각, 7d 잔량 |
| Claude fallback | `~/.claude/projects/**/*.jsonl`                  | 최근 턴 토큰 사용량            |

## Features

| Feature            | Description                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 공통 사용량 표시   | Codex와 Claude Code 사용량을 같은 형식으로 표시합니다.                                                                    |
| 리셋 시각 표시     | `5h`, `7d` 창 라벨과 값을 표시합니다.                                                                                     |
| 색상 기준          | 40% 초과 초록, 21-40% 주황, 20% 이하 빨강으로 배터리만 강조합니다.                                                        |
| Codex terminal row | Windows에서는 가상 터미널 화면과 배터리 행을 합성하고, WSL/Linux/macOS에서는 PTY wrapper로 별도 사용량 행을 고정합니다.   |
| Claude statusLine  | Claude Code 내장 statusLine hook과 실제 429 hit 로그로 Claude rate limit 상태를 읽습니다.                                 |
| HUD / menu bar     | Windows native에서는 terminal-docked/floating HUD, WSL에서는 floating HUD, macOS에서는 menu bar status item을 제공합니다. |
| npm 실행           | `npm install -g` 또는 `npx`로 실행할 수 있습니다.                                                                         |

## Platform Support

| Mode                     | Windows native | WSL  | Linux  | macOS | Note                                                                                                                        |
| ------------------------ | -------------- | ---- | ------ | ----- | --------------------------------------------------------------------------------------------------------------------------- |
| `ai-battery`             | 지원           | 지원 | 지원   | 지원  | Node.js 18 이상이 필요합니다.                                                                                               |
| `ai-battery --watch`     | 지원           | 지원 | 지원   | 지원  | 터미널 안에서 주기적으로 갱신합니다.                                                                                        |
| Claude statusLine        | 지원           | 지원 | 지원   | 지원  | Claude Code `statusLine`에 `node <script>` 명령을 저장합니다.                                                               |
| Codex fullscreen         | 지원           | 지원 | 지원   | 지원  | Windows 기본값은 Fullscreen PTY 화면과 터미널 배터리 행을 합성합니다. WSL/Linux/macOS는 POSIX PTY와 `python3`를 사용합니다. |
| `ai-battery setup codex` | 지원 | 지원 | 지원 | 지원 | 원본 실행 파일을 보존하는 관리형 wrapper로 Codex 사용량을 자동 표시합니다. |
| `ai-battery hud`         | 지원           | 지원 | 미지원 | 지원  | Windows/WSL은 PowerShell/WinForms HUD, macOS는 menu bar status item입니다.                                                  |

실행 중 감지는 Linux/WSL은 `/proc`, macOS는 `ps`, Windows는 PowerShell 프로세스 목록을 사용합니다. 텍스트 출력은 흰색/회색으로, macOS HUD는 실행 중인 항목만 색상 배터리바로 강조하고 비실행 항목은 흐린 회색 계열로 표시합니다.

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

2. Claude statusLine과 Codex 자동 표시를 설정합니다.

   ```bash
   ai-battery setup
   ```

3. 새 터미널을 열거나 setup이 안내한 셸 갱신 명령을 실행한 뒤, 원래 명령을 그대로 사용합니다.

   ```bash
   claude
   codex
   ```

4. 별도 데스크톱 표시가 필요하면 Windows/WSL/macOS HUD를 실행합니다.

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
ai-battery reset settings
ai-battery doctor
ai-battery hud
ai-battery off codex
ai-battery on codex
```

| Option                          | Description                                          |
| ------------------------------- | ---------------------------------------------------- |
| `--provider all\|codex\|claude` | 표시할 provider를 선택합니다.                        |
| `--watch [seconds]`             | 같은 줄에서 주기적으로 갱신합니다.                   |
| `--json`                        | HUD나 다른 도구에서 쓰기 좋은 JSON을 출력합니다.     |
| `--bar-width N`                 | 터미널 배터리 바 길이를 조정합니다.                  |
| `--show-paths`                  | 로그 파일 경로와 데이터 관측 시각을 함께 표시합니다. |
| `-v`, `--version`               | 설치된 `ai-battery` 버전을 출력합니다.               |

`doctor`는 설치 상태와 함께 npm latest 버전을 확인합니다. 네트워크가 막혀 있으면 버전 확인만 건너뛰고 나머지 진단은 계속 표시합니다.

<a id="uninstall"></a>

## Reset Settings

`ai-battery reset settings`는 AI Battery가 추가한 통합 설정을 원래 값으로 복원하고, 소유권을 확인한 AI Battery 캐시·전용 런타임·생성 파일을 정리합니다. Codex·Claude의 관련 없는 설정과 npm 패키지·실행 명령은 유지합니다. Codex나 Claude의 설정 전체를 기본값으로 초기화하는 명령은 아닙니다.

```bash
ai-battery reset settings
```

`ai-battery reset config`도 같은 동작입니다. 일부 통합만 복원하려면 대상을 지정합니다. 대상 지정 시 다른 통합과 공통 캐시는 유지합니다.

```bash
ai-battery reset settings codex
ai-battery reset settings claude
ai-battery reset settings hud
ai-battery reset settings tmux
```

관리 중인 status line이나 설정 블록이 사용자에 의해 변경됐다면 덮어쓰지 않고 복구 기록을 보존하며 종료 코드 1로 알립니다. 관련 없는 Codex·Claude 설정, 사용자 추가 파일, 확인할 수 없는 파일은 보존합니다. 셸·tmux의 사용자 수정도 관리 블록 밖의 내용은 유지합니다. 복구 기록은 해당 항목이 복원되거나 안전하게 제거된 뒤에만 지워집니다.

패키지까지 삭제하려면 설정 복원이 성공한 다음 npm으로 제거합니다. 로컬 설치는 `npm uninstall ai-battery`, 전역 설치는 아래 명령을 사용합니다. Windows와 WSL, Node 버전별 설치는 각각 진행하세요.

```bash
ai-battery reset settings && npm uninstall -g ai-battery
hash -r  # Bash: 기존 터미널의 삭제된 wrapper 경로 캐시 해제 (zsh: rehash)
```

CLI는 npm 제거를 자동 실행하지 않습니다. `teardown`과 `uninstall`은 호환용 별칭으로 남아 있으며, 동일하게 설정과 생성 파일만 정리합니다. `off`는 표시만 숨깁니다. 이미 npm 패키지를 먼저 지웠다면 다시 설치하고 `reset settings`로 통합부터 복원하세요.

자식 프로세스인 CLI는 부모 셸의 명령 캐시를 지울 수 없습니다. 새 터미널을 열어도 캐시는 초기화됩니다. 이미 wrapper로 시작한 Codex 세션의 하단 행은 해당 세션을 종료해야 사라집니다.

## Setup

`setup`은 Claude Code의 statusLine hook과 Codex 자동 표시를 한 번에 설정합니다. 이후에는 `claude`, `codex`를 평소처럼 실행하면 됩니다. Codex는 별도 경로의 관리형 wrapper를 사용하며 원본 실행 파일은 교체하지 않습니다. 기존 Codex 설정과 세션 기록도 유지합니다.

```bash
ai-battery setup
```

한 도구만 설정하려면 `ai-battery setup codex` 또는 `ai-battery setup claude`를 사용합니다. 기존 터미널에는 setup 출력의 `source ...` 안내를 적용하고 `hash -r`을 실행하거나, 새 터미널을 여세요. Windows에서는 새 cmd/PowerShell을 엽니다.

AI Battery 사용량 표시에는 Codex `[tui].status_line` 변경이 필요하지 않습니다. Codex 자체의 모델·디렉터리·브랜치 행도 변경하고 싶을 때만 `--configure-codex-statusline`을 추가합니다. 기존 값은 복원용으로 먼저 기록합니다.

Codex 자동 연동을 사용하지 않으려면 `ai-battery setup codex --no-wrap-codex`로 해제합니다. 별도 표시에는 `ai-battery --watch 2`나 `ai-battery hud`를, 세션 하나에만 표시하려면 `ai-battery-run -- codex`(POSIX) 또는 `ai-battery-run-win -- codex`(Windows)를 사용합니다.

Windows와 WSL은 각각 설치한 환경에서 setup을 실행합니다. 아래 Windows runner 설명은 기본 Codex 자동 연동에도 적용됩니다.

Windows native `cmd`/PowerShell에서는 `codex.cmd` wrapper가 현재 PATH에서 원본 Codex를 매번 찾고, 기본 `composite` runner로 실행합니다. Codex Fullscreen 화면은 `node-pty`의 bundled ConPTY와 `@xterm/headless` 안에서 해석한 뒤, 터미널 최하단의 AI Battery 1행과 합성합니다. Codex의 기본 상태·단축키 행은 본문 스크롤 이동에서 제외하며, 바뀐 화면만 다시 그립니다. 시스템 Node와 Codex 설치는 변경하지 않습니다.

Windows dock 위치는 `AI_BATTERY_WIN_DOCK_POSITION`으로 선택합니다. 기본값 `bottom`은 터미널 하단에 결합하고, `tabs`는 같은 compact 사용량 행을 상단 탭 바 오른쪽에 고정합니다. PowerShell에서는 `$env:AI_BATTERY_WIN_DOCK_POSITION="tabs"`, cmd에서는 `set AI_BATTERY_WIN_DOCK_POSITION=tabs`를 설정한 뒤 `codex`를 실행합니다. launcher를 직접 확인하려면 `ai-battery hud --dock-console --dock-position tabs`를 사용합니다.

Windows의 현재 Node가 VT raw 입력을 지원하지 않으면 사용자 데이터 디렉터리의 전용 Node 24.21.0을 사용합니다. 첫 실행에서 공식 Node 배포본을 내려받아 SHA256 검증 후 `node.exe`만 설치하며, PATH는 변경하지 않습니다. 런타임 준비나 PTY 의존성 로드가 실패하면 기존 native HUD로 전환합니다. `AI_BATTERY_RUNTIME_DOWNLOAD=0`은 자동 다운로드를 끕니다. `AI_BATTERY_WIN_LAYOUT=fullscreen` 또는 `hud`는 HUD 방식, `plain`은 추가 표시 없는 직접 실행, `tui`, `reserve`, `overlay`, `inline`은 이전 구현을 확인하기 위한 명시적 모드입니다. `auto`는 기본 `composite`를 선택합니다.

기본 compositor 검사는 `npm run smoke:composite`, 실제 Codex Fullscreen 검사는 `npm run smoke:codex-fullscreen-win`, native HUD 경로 검사는 `npm run smoke:fullscreen`으로 실행합니다.

Windows rowpty 문제를 재현할 때는 말로 설명하지 말고 smoke report를 남기는 쪽이 가장 빠릅니다. WSL에서는 `npm run smoke:wsl-win`을 실행하면 새 Windows PowerShell 콘솔을 열어 실제 Windows 콘솔 핸들에서 테스트하고, `rowpty-smoke-report.json`을 repo 루트에 저장합니다. Windows native 터미널에서는 `npm run smoke:win`을 바로 실행하면 됩니다. smoke test는 `cmd.exe` child와 `powershell.exe` child를 모두 rowpty 안에서 실행합니다. report에는 rowpty 사용 여부, overlay/node-pty fallback 여부, 키 입력 없이 delayed output이 화면 버퍼에 나타났는지, status row가 보였는지, `CSI 3J` 이후 scrollback sentinel이 남았는지가 case별로 기록됩니다.

tmux에서는 pane마다 하단 행을 예약하면 같은 전역 배터리가 pane 수만큼 중복 표시됩니다. 대신 tmux의 status bar에 세션당 한 번만 표시할 수 있습니다.

```bash
ai-battery setup tmux
```

`~/.tmux.conf`에 관리 블록을 추가해 status-right에 배터리를 표시하고(10초 간격 갱신), 이 tmux 안에서 실행되는 `codex`는 pane별 배터리 행을 생략하고 pane 전체를 사용합니다. Claude statusLine도 같은 환경에서는 배터리 행을 접고 header(모델·디렉터리·브랜치) 1행만 표시합니다 — 배터리는 tmux bar에 이미 있기 때문입니다. 적용하려면 `tmux source-file ~/.tmux.conf` 후 새 pane을 여세요. 이 블록은 기존 `status-right` 설정을 덮어쓰므로 `setup all`에 포함되지 않는 opt-in입니다. 해제는 `ai-battery reset settings tmux`, tmux 안에서도 pane별 행을 유지하려면 `AI_BATTERY_TMUX=row`를 설정합니다.

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

`ai-battery setup` 후에는 평소처럼 `codex`를 실행하면 하단에 AI Battery 사용량 행이 표시됩니다. 기존 셸은 setup의 안내에 따라 갱신하거나 새 터미널을 여세요.

세션 하나에 하단 행을 추가하려면 명시적으로 실행합니다.

```bash
ai-battery-run --provider all -- codex       # WSL/Linux/macOS
ai-battery-run-win --provider all -- codex   # Windows cmd/PowerShell
```

갱신 주기를 줄이려면 `--interval`을 사용합니다.

```bash
ai-battery-run --interval 1 --provider all codex
```

Windows 기본 `composite` 모드와 WSL/Linux/macOS 상태줄은 기본 2초 간격으로 사용량을 백그라운드에서 조회합니다. 조회가 느려져도 터미널 입력과 출력은 계속 전달되며, 각 조회는 최대 10초까지 기다립니다. 실패하면 1초 뒤부터 다시 시도하고, 연속 실패 시 재시도 간격을 늘립니다. 이전 정상 값에는 `[stale]`을 붙여 갱신 실패를 알리고, 다음 조회가 성공하면 새 값으로 바꿉니다. 첫 정상 값을 얻기 전에 조회가 실패하면 `AI Battery unavailable`을 표시합니다.

Codex 사용량 로그가 추가·변경되면 기존 캐시의 유효 시간이 남아 있어도 다음 조회에서 다시 읽습니다. 표시되는 값은 로컬 Codex 로그와 Claude statusLine이 마지막으로 제공한 사용량이며, 서버를 직접 조회하는 실시간 사용량은 아닙니다. 로그나 statusLine 자체가 늦게 갱신되면 표시도 늦어질 수 있습니다. `ai-battery --show-paths`로 데이터 관측 시각과 출처를 확인할 수 있습니다.

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

분할창에서 pane마다 같은 사용량 줄이 반복되는 게 싫다면 Claude statusLine을 header 전용으로 설치할 수 있습니다. 1행의 모델·workspace·context는 각 pane 안에 남고, 공통 사용량은 tmux status bar나 Windows HUD에 한 번만 표시하는 방식입니다.

```bash
ai-battery setup claude --no-usage-row
```

tmux에서는 `ai-battery setup tmux`가 통합 하단 줄 역할을 합니다. Windows Terminal native split pane은 각 pane이 별도 ConPTY라 하나의 터미널 행을 여러 pane에 걸쳐 그릴 수 없습니다. 이 경우에는 Claude 2행을 접고 Windows HUD를 하나 띄우는 방식을 사용하세요.

```bash
ai-battery hud -Mode statusline -Position bottomcenter
```

제거:

```bash
ai-battery reset settings claude
```

Claude가 한 번 이상 statusLine payload를 전달해야 Claude의 사용량 캐시가 생성됩니다. 그 전에는 Claude 로컬 로그 기반 fallback이 표시됩니다.

## Desktop HUD

일반 터미널 위에 외부 프로세스가 안전하게 status line을 덧그리는 방식은 안정적이지 않습니다. 그래서 Windows에서는 floating overlay를, macOS에서는 상단 menu bar status item을 제공합니다. Windows native에서는 WSL 없이 PowerShell/WinForms로 바로 실행되고, WSL에서는 `powershell.exe`를 통해 같은 HUD를 띄웁니다. Windows와 WSL은 같은 데스크톱 화면을 공유하므로 HUD의 실행 중 감지는 Windows 프로세스와 실행 중인 WSL distro의 프로세스를 함께 확인합니다. macOS에서는 투명 배경의 작은 SVG 이미지로 Codex와 Claude 로고, 짧은 미터, 퍼센트를 표시하고, 클릭하면 자세한 상태를 볼 수 있습니다.

```bash
ai-battery hud
```

HUD는 백그라운드에서 실행되고 터미널을 바로 돌려줍니다. Windows HUD는 위치를 드래그로 옮길 수 있으며, 다음 실행 때 저장된 위치를 재사용합니다. macOS menu bar item은 시스템 메뉴바 오른쪽 영역에 표시됩니다.

```text
Codex  [battery:88] │ 5h 00:47 │ 7d 93%
Claude [battery:76] │ 5h 00:47 │ 7d 59%
```

| Command                                                      | Role                                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `ai-battery hud` / `ai-battery hud start`                    | Windows floating HUD 또는 macOS menu bar item을 시작합니다.                                     |
| `ai-battery hud stop`                                        | 실행 중인 HUD/menu bar item을 종료합니다. (`--stop`도 동일)                                     |
| `ai-battery hud status`                                      | HUD/menu bar 실행 여부와 autostart 등록 상태를 보여줍니다.                                      |
| `ai-battery hud autostart on`                                | Windows 로그인 또는 macOS 로그인 시 자동 실행을 등록합니다.                                     |
| `ai-battery hud autostart off`                               | 자동 실행 등록을 해제합니다.                                                                    |
| `ai-battery hud autostart status`                            | 자동 실행 등록 상태만 보여줍니다.                                                               |
| `ai-battery hud -Foreground`                                 | 디버깅용으로 터미널에 붙여 실행합니다.                                                          |
| `ai-battery hud -Once`                                       | 콘솔에서 한 번만 출력합니다.                                                                    |
| `ai-battery hud -Interval 2`                                 | 갱신 주기를 바꿉니다.                                                                           |
| `ai-battery hud -Mode tray`                                  | Windows tray icon 모드로 실행합니다. macOS에서는 menu bar item이 기본입니다.                    |
| `ai-battery hud light` / `ai-battery hud dark`               | Windows floating HUD를 밝은 작업표시줄용 검은 글자 또는 어두운 작업표시줄용 흰 글자로 바꿉니다. |
| `ai-battery hud black` / `ai-battery hud white`              | 글자색을 직접 검은색 또는 흰색으로 바꿉니다.                                                    |
| `ai-battery hud --backdrop` / `ai-battery hud --no-backdrop` | Windows floating HUD 글자 뒤 어두운 backing을 켜거나 끕니다.                                    |

Windows floating HUD는 기본적으로 투명 배경에 밝은 글자로 표시합니다. 밝은 작업표시줄에서는 `ai-battery hud light`, 어두운 작업표시줄에서는 `ai-battery hud dark`를 쓰면 됩니다. 글자색으로 직접 고르려면 `ai-battery hud black` 또는 `ai-battery hud white`를 쓰세요. 로그인 자동 실행에도 같은 모드를 저장하려면 `ai-battery hud autostart on light`처럼 붙이면 됩니다.

Windows autostart는 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`의 `AiBatteryHud` 값에 사용자 단위로 등록됩니다. Windows native와 WSL에서 등록해도 같은 Run 항목을 쓰므로 둘 다 켜지는 것이 아니라 마지막으로 실행한 `ai-battery hud autostart on`이 이전 launcher를 교체합니다. HUD 프로세스도 같은 `Local\AiBatteryHud` mutex를 사용해 중복 실행을 막습니다. Windows native에서는 WSL 없이 바로 실행되고, WSL에서 등록한 경우에는 HUD 스크립트 사본을 `%LOCALAPPDATA%\ai-battery`에 둡니다. macOS autostart는 `~/Library/LaunchAgents/com.ai-battery.hud.plist`로 등록됩니다. ai-battery를 업데이트한 뒤에는 `ai-battery hud autostart on`을 다시 실행해 등록 경로를 갱신하세요.

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

| Layer        | Technology                            | Role                                                     |
| ------------ | ------------------------------------- | -------------------------------------------------------- |
| CLI          | Node.js                               | 로그 파싱, Claude cache, ANSI/statusLine 출력            |
| PTY row      | Python 3                              | Codex 실행용 reserved terminal row                       |
| HUD launcher | Node.js / Bash compatibility wrapper  | Windows native/WSL PowerShell HUD와 macOS menu bar 실행  |
| HUD UI       | PowerShell WinForms / AppleScriptObjC | Windows floating overlay, tray icon, macOS menu bar item |
| Data         | JSONL logs, statusLine JSON           | Codex/Claude 사용량 소스                                 |

## Source Environment

기본 CLI는 Node.js 18 이상에서 실행됩니다. Windows 기본 compositor는 VT raw 입력을 지원하는 전용 런타임을 필요할 때 준비합니다. WSL/Linux/macOS는 Python 3와 POSIX PTY를 사용합니다. 전용 런타임이나 의존성을 준비할 수 없으면 native HUD로 전환합니다.

Codex 데이터는 Codex가 실제로 사용하는 `CODEX_HOME`(기본값 `~/.codex`)의 `sessions`를 읽습니다. AI Battery는 `HOME`, `USERPROFILE`, `CODEX_HOME`을 설정하거나 변경하지 않습니다. `CODEX_HOME`을 바꾸면 Codex 자체의 `/resume` 저장소도 바뀌므로 Windows와 WSL의 경로를 합치는 용도로 사용하지 마세요. 쉼표로 여러 경로를 지정하는 방식도 지원하지 않습니다.

```bash
CODEX_HOME=/path/to/codex-home ai-battery --provider codex
```

Windows native와 WSL을 함께 쓰면 두 환경의 세션 저장소는 각각 유지되고 `/resume`도 서로 독립적으로 동작합니다. 계정 공통 값인 Codex 5h/7d 사용량만 AI Battery 전용 `codex-account-usage.json`으로 공유하며, 세션 파일 경로, workspace, 승인/샌드박스 모드는 공유하지 않습니다. 공유 상태 위치를 직접 격리해야 할 때만 `AI_BATTERY_SHARED_USAGE_STATE_DIR`을 설정할 수 있습니다.

Claude의 사용량 표시는 Claude Code statusLine hook을 설치한 뒤부터 사용할 수 있습니다.

## Caution

- 이 도구는 로컬 로그와 Claude statusLine payload를 읽습니다. 서비스의 공식 과금/한도 화면을 대체하지 않습니다.
- Codex rate limit 이벤트가 아직 생성되지 않았거나 오래된 경우 최신 상태와 차이가 있을 수 있습니다.
- Claude statusLine은 사용률과 reset 시각만 제공하므로, 실제 hit 상태는 Claude가 남긴 429 rate-limit 로그를 함께 읽어 반영합니다.
- HUD는 Windows에서는 PowerShell/WinForms 기반이고, macOS에서는 menu bar status item 기반입니다. WSL에서는 `powershell.exe`와 `wsl.exe`를 함께 사용합니다.
- `ai-battery-run`은 PTY wrapper입니다. 일부 전체 화면 TUI는 화면을 지우는 escape sequence 때문에 status row가 잠시 흔들릴 수 있습니다.
