# AI Battery

0.1.28: Restored automatic Codex terminal display with plain setup, including after reset and upgrades. Doctor separates visibility, integration readiness and the current session, with specific recovery actions. The original executable, settings and sessions remain preserved.

0.1.27: Fixed duplicate usage rows accumulating in Codex when Korean status text wrapped at the bottom of the terminal. POSIX rendering now clips by screen cells without space padding. Unavailable providers use compact labels such as `Claude --%` in bounded rows.

0.1.26: Setup now preserves and refreshes existing Codex wrappers, PATH, status lines and tmux integration without deleting paths cached by running shells. tmux setup distinguishes configured from active. The HUD popup has no bright border, and the main example is `ai-battery setup tmux`.

0.1.25: Ubuntu/Linux now has a panel HUD with the same logos, battery bars and percentages as macOS. Help, diagnostics, setup results and errors use concise Korean/English messages. Running without a command opens help; `show` has been removed. Restore integrations with `ai-battery reset`; the previous `reset settings` and `reset config` forms remain supported.

[한국어](../../../README.md) · [English](../en/) · [日本語](../ja/) · [中文](../zh/) · [Español](../es/)

Codex and Claude Usage Battery Meter

A terminal status display tool that shows the remaining Codex and Claude Code usage like a battery.

![npm](https://img.shields.io/npm/v/ai-battery)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20WSL%20%7C%20Linux%20%7C%20macOS-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[Install](#install) · [Features](#features) · [Quick Start](#quick-start) · [Claude StatusLine](#claude-statusline) · [Desktop HUD](#desktop-hud) · [Caution](#caution)

## Overview

`ai-battery` is a small status display tool for keeping an eye on remaining usage and reset times while using Codex and Claude Code.

For Codex, it reads `rate_limits` events from local session logs. For Claude Code, it caches the rate-limit payload delivered by the `statusLine` hook. When Claude records an actual 429 rate-limit hit, that limit is shown as 0% until the corresponding reset time. The usage display stays compact on one line: running tools are shown in white, inactive tools in gray, and only the battery bar changes color based on remaining usage: green, orange, or red.

<img src="../../terminal-preview.svg" alt="AI Battery terminal preview showing green and red battery bars" width="940">

The Markdown text fallback omits the bar to avoid renderer-specific differences in block character height. In a real terminal, ANSI colors and block bars are rendered together.

```text
Codex 86% │ 5h 18:09 │ 7d 82%  ┃  Claude 4% │ 5h 18:10 │ 7d 71%
```

| Provider | Source | Shows |
| --- | --- | --- |
| Codex | `~/.codex/sessions/**/*.jsonl` | 5h remaining, 5h reset time, 7d remaining |
| Claude Code | Claude `statusLine` payload cache + 429 hit logs | 5h remaining, 5h reset time, 7d remaining |
| Claude fallback | `~/.claude/projects/**/*.jsonl` | Recent turn token usage |

## Features

| Feature | Description |
| --- | --- |
| Shared usage display | Shows Codex and Claude Code usage in the same format. |
| Reset time display | Shows `5h` and `7d` window labels and values. |
| Color thresholds | Highlights only the battery: green above 40%, orange from 21-40%, and red at 20% or below. |
| Codex terminal row | Keeps Codex direct on Windows and docks an external row; WSL/Linux/macOS use a PTY wrapper. |
| Claude statusLine | Reads Claude rate-limit state from Claude Code's built-in statusLine hook and actual 429 hit logs. |
| HUD / menu bar | Provides Windows/WSL floating HUDs and matching macOS menu bar / Ubuntu/Linux panel displays. |
| npm execution | Can be run with `npm install -g` or `npx`. |

## Platform Support

| Mode | Windows native | WSL | Linux | macOS | Note |
| --- | --- | --- | --- | --- | --- |
| `ai-battery` | Supported | Supported | Supported | Supported | Requires Node.js 18 or newer. |
| `ai-battery --watch` | Supported | Supported | Supported | Supported | Refreshes periodically inside the terminal. |
| Claude statusLine | Supported | Supported | Supported | Supported | Saves a `node <script>` command to Claude Code `statusLine`. |
| Codex fullscreen | Supported | Supported | Supported | Supported | Windows: fullscreen PTY composition; WSL/Linux/macOS: POSIX PTY and Python 3. |
| `ai-battery setup codex` | Supported | Supported | Supported | Supported | Preserves and refreshes existing integrations. New wrappers and Codex setting changes require explicit flags. |
| `ai-battery hud` | Supported | Supported | Supported | Supported | Ubuntu GNOME uses a dedicated panel display; other Linux desktops use a StatusNotifier host. |

Runtime detection uses `/proc` on Linux/WSL, `ps` on macOS, and PowerShell process listings on Windows. Text output uses white/gray, while the macOS and Linux HUDs highlight only running items with colored battery bars and show inactive items in muted gray.

## Install

```bash
npm install -g ai-battery
```

You can also run it immediately without installing.

```bash
npx ai-battery
```

The previous command names, `claudex-battery`, `claudex-battery-run`, and `claudex-battery-hud`, are still provided as compatibility aliases.

Run `ai-battery -h` for the main commands, or `ai-battery setup --help`, `ai-battery hud --help`, or `ai-battery --watch --help` for detailed options. Help, diagnostics, setup/reset results and errors follow `LANGUAGE`, `LC_ALL`, `LC_MESSAGES`, then `LANG`, with Korean and English supported and English as the fallback. Technical terms, commands, paths and external tool errors remain unchanged. Use `LANGUAGE=ko ai-battery -h` to select Korean explicitly.

## Quick Start

1. Install the package.

   ```bash
   npm install -g ai-battery
   ```

2. Refresh existing integrations and configure the Claude statusLine. Previously selected Codex wrappers and tmux integration stay enabled.

   ```bash
   ai-battery setup
   ```

3. After that, keep using the original commands as usual.

   ```bash
   claude
   codex
   ```

4. View Codex usage with `ai-battery --watch 2` in another terminal, or start the Windows/WSL/macOS HUD.

   ```bash
   ai-battery hud
   ```

## CLI

Running `ai-battery` without arguments opens help. Keep usage visible through an integrated status line, the HUD, or `--watch`.

```bash
ai-battery setup
ai-battery hud
ai-battery on codex
ai-battery off codex
ai-battery reset
ai-battery doctor
ai-battery --watch 10
ai-battery --help
ai-battery --version
```

| Option | Description |
| --- | --- |
| `--provider all\|codex\|claude` | Chooses which provider to show. |
| `--watch [seconds]` | Refreshes periodically on the same line. |
| `--json` | Outputs JSON that is convenient for HUDs or other tools. |
| `--bar-width N` | Adjusts the terminal battery bar width. |
| `--show-paths` | Shows log file paths and data observation timestamps. |
| `-v`, `--version` | Prints the installed `ai-battery` version. |

`doctor` summarizes installation, integration and npm update status. Optional Codex wrappers and status lines are not reported as setup errors. Use `ai-battery doctor --json` for full paths, recovery records and diagnostic details. If the network is unavailable, only the version check is skipped and the rest of the diagnostics are still shown.

<a id="uninstall"></a>
## Reset Settings

`ai-battery reset` restores settings changed by AI Battery and cleans its verified caches, private runtimes and generated files. It preserves unrelated Codex/Claude settings, npm packages and package commands. It does not reset all Codex or Claude settings to defaults.

```bash
ai-battery reset
```

The previous `ai-battery reset settings` and `ai-battery reset config` forms remain supported. Select a target to restore only that integration and retain shared caches:

```bash
ai-battery reset codex
ai-battery reset claude
ai-battery reset hud
ai-battery reset tmux
```

Edited managed values or blocks are preserved with recovery records, and reset exits with status 1. Unrelated settings, user-added files, unknown files and edits outside managed shell/tmux blocks are preserved. Recovery records are cleared only after successful restoration or safe removal.

To remove the package, restore settings successfully first, then use npm. For a local installation use `npm uninstall ai-battery`; for a global installation:

```bash
ai-battery reset && npm uninstall -g ai-battery
hash -r  # Existing Bash terminal; zsh: rehash
```

The CLI never runs npm uninstall automatically. `teardown` and `uninstall` remain compatibility aliases for settings reset. `off` only hides the display. Run separately for Windows, WSL and each Node installation. If npm was removed first, reinstall AI Battery and reset its integrations before removing it again.

A child CLI cannot clear its parent shell's cached command paths. Opening a new terminal also resets them. A running wrapped session retains its terminal row until that session exits.

## Setup

`setup` preserves and refreshes existing Codex wrappers, PATH, status lines and tmux integration, and configures the Claude statusLine hook. It never removes cached command paths or recovery backups. Fresh installs and setup after reset enable the managed PATH wrapper while preserving the original Codex executable, configuration and session history. Use `reset` to remove integrations.

```bash
ai-battery setup
```

You can configure only one side if needed.

```bash
ai-battery setup tmux
ai-battery setup codex
```

`setup` and `setup codex` enable the PATH wrapper by default. `--wrap-codex` remains supported; `--no-wrap-codex` skips wrapper setup without removing existing integrations. Use `reset codex` to detach. Changing Codex `[tui].status_line` still requires `--configure-codex-statusline`. Recovery metadata is recorded before managed changes and restored by `reset`.

In tmux, reserving a bottom row in every pane would duplicate the same global battery as many times as there are panes. Instead, you can show it once per session in the tmux status bar.

```bash
ai-battery setup tmux
```

This adds a managed block to `~/.tmux.conf`, displays the battery in `status-right` with a 10-second refresh interval, and lets `codex` inside tmux use the full pane instead of adding a per-pane battery row. Claude statusLine also collapses the battery row in the same environment and shows only the header row (model, directory, branch), because the battery is already in the tmux bar. Setup inside tmux also updates the running server immediately. Outside tmux it prints `Start: tmux`; enter a tmux session to see the bar. Existing status-right text is retained. New tmux integration is opt-in; an existing integration is refreshed by later `setup` and `setup all` calls. Remove it with `ai-battery reset tmux`; set `AI_BATTERY_TMUX=row` if you want to keep per-pane rows inside tmux. Claude statusLine is part of the Claude Code internal UI, so it is displayed regardless of tmux.

Run diagnostics if the Codex bottom row does not appear.

```bash
ai-battery doctor
```

Use the short on/off commands to choose which providers are shown.

```bash
ai-battery off codex
ai-battery on codex
ai-battery off claude
ai-battery on claude
ai-battery off all
ai-battery on all
```

This setting applies to the CLI, Claude statusLine, Codex wrapper, and HUD together.

## Codex Terminal Row

After setup, plain `codex` in a new terminal displays the usage row. Doctor separates `Visibility` (on/off preference), `TUI` (readiness for the next launch) and `Session` (current attachment). The on command changes visibility without installing an integration. Use `ai-battery --watch 2` or a supported desktop HUD to view usage separately. Add a row for one session explicitly:

```bash
ai-battery-run --provider all -- codex       # WSL/Linux/macOS
ai-battery-run-win --provider all -- codex   # Windows cmd/PowerShell
```

Use `--interval` to reduce the refresh interval.

```bash
ai-battery-run --interval 1 --provider all codex
```

The default Windows `composite` mode and the WSL/Linux/macOS status row poll usage in the background every 2 seconds by default. Terminal input and output continue during slow queries, and each poll can take up to 10 seconds. Failed polls retry after 1 second, with longer delays after consecutive failures. The previous reading is marked `[stale]` until a poll succeeds; failures before any successful reading display `AI Battery unavailable`.

New or changed Codex usage logs invalidate the parsing cache for the next poll, even before its normal expiry. Values reflect the latest reading provided by local Codex logs and Claude statusLine, rather than a live server query. Delayed source updates can still delay the display. Use `ai-battery --watch --show-paths` to inspect the data's observation time and source.

### Windows runner

Windows runners support the `composite` terminal row and native HUD layouts. These apply when explicitly launching `ai-battery-run-win` or opting into a wrapper. Default setup never installs a `codex.cmd` shim or changes Windows user PATH.

## Claude StatusLine

Claude Code provides rate-limit usage and reset times through the built-in `statusLine` hook. AI Battery combines that with actual 429 rate-limit hit records from Claude JSONL. After installation, Claude renders two lines.

<img src="../../claude-statusline-preview.svg" alt="Claude statusLine preview showing colored AI Battery bars" width="940">

```text
Opus high · ~/Projects · main                               83% context left
Codex 71% │ 5h 00:47 │ 7d 90%  Claude 76% │ 5h 00:47 │ 7d 59%
```

The first line shows the model, reasoning level, workspace root, and git branch, with remaining Claude context pinned to the right edge. The second line shows Codex and Claude usage in the same format.

Setup:

```bash
ai-battery setup claude
```

Remove:

```bash
ai-battery reset claude
```

Claude must deliver a statusLine payload at least once before the Claude usage cache is created. Until then, the Claude local log fallback is shown.

## Desktop HUD

Drawing a status line safely over a normal terminal from an external process is not reliable. AI Battery therefore provides a floating overlay on Windows and a top menu bar status item on macOS. On Windows native, it runs directly through PowerShell/WinForms without WSL; from WSL, it launches the same HUD through `powershell.exe`. On macOS, it displays Codex and Claude logos, compact meters, and percentages as a small SVG image with a transparent background. Click it to see detailed status.

```bash
ai-battery hud
```

The HUD runs in the background and immediately returns control to the terminal. The Windows HUD can be moved by dragging, and the saved position is reused on the next launch. The macOS item appears on the right of the menu bar; Ubuntu/Linux uses the desktop panel.

### Ubuntu / Linux

On Ubuntu GNOME, both the panel and its click menu use the same SVGs as macOS. The detail view retains the provider names, graphical battery bars, percentages, 5h reset times and 7d remaining usage at the same size and alignment, followed by Refresh and Quit. Provider visibility follows `ai-battery on/off`. The HUD reconnects after screen unlock or panel restart.

On GNOME 45–50, the first start installs and enables the display extension under `~/.local/share/gnome-shell/extensions/ai-battery@hnode.dev`, respecting `XDG_DATA_HOME`. Sign out and back in once for GNOME to discover the new extension. Until then, or on other desktops, the standard StatusNotifier menu remains available. Disabling the extension restores the standard tray icon.

GJS, libdbusmenu and a StatusNotifier host are required. The tested Ubuntu environment already provides them. If needed, install the components below and enable the Ubuntu AppIndicators extension:

```bash
sudo apt install gjs gir1.2-dbusmenu-glib-0.4
ai-battery hud
```

`ai-battery hud autostart on` creates `~/.config/autostart/ai-battery-hud.desktop`, respecting `XDG_CONFIG_HOME`. A normal start does not enable autostart. `ai-battery reset hud` stops the HUD and removes its owned autostart entry and GNOME display extension.

Run `npm run smoke:linux` to verify the menu in an isolated Wayland session. Results and an actual menu screenshot are saved under `.cache/linux-gnome-menu/`.

```text
Codex  [battery:88] │ 5h 00:47 │ 7d 93%
Claude [battery:76] │ 5h 00:47 │ 7d 59%
```

| Command | Role |
| --- | --- |
| `ai-battery hud` / `ai-battery hud start` | Starts the Windows HUD or macOS/Linux panel display. |
| `ai-battery hud stop` | Stops the running HUD/menu bar item. (`--stop` is the same.) |
| `ai-battery hud status` | Shows whether the HUD/menu bar item is running and whether autostart is registered. |
| `ai-battery hud autostart on` | Registers automatic startup at desktop login. |
| `ai-battery hud autostart off` | Removes automatic startup registration. |
| `ai-battery hud autostart status` | Shows only autostart registration status. |
| `ai-battery hud -Foreground` | Runs attached to the terminal for debugging. |
| `ai-battery hud -Once` | Prints once in the console. |
| `ai-battery hud -Interval 2` | Changes the refresh interval. |
| `ai-battery hud -Mode tray` | Runs in Windows tray icon mode. macOS/Linux use the panel by default. |
| `ai-battery hud light` / `ai-battery hud dark` | Switches the Windows floating HUD to black text for a light taskbar or white text for a dark taskbar. |
| `ai-battery hud black` / `ai-battery hud white` | Sets the text color directly to black or white. |
| `ai-battery hud --backdrop` / `ai-battery hud --no-backdrop` | Enables or disables the dark backing behind Windows floating HUD text. |

The Windows floating HUD defaults to bright text on a transparent background. Use `ai-battery hud light` for a light taskbar or `ai-battery hud dark` for a dark taskbar. To pick the text color directly, use `ai-battery hud black` or `ai-battery hud white`. Add the same mode when saving login autostart, such as `ai-battery hud autostart on light`.

Windows autostart is registered per user under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. On Windows native it runs directly without WSL, and when registered from WSL a copy of the HUD script is placed under `%LOCALAPPDATA%\ai-battery`. macOS autostart is registered as `~/Library/LaunchAgents/com.ai-battery.hud.plist`. After updating ai-battery, run `ai-battery hud autostart on` again to refresh the registered path.

## Shell Prompt

You can also add it to your shell prompt.

```bash
export PS1='$(ai-battery --provider codex) '"$PS1"
```

The prompt method refreshes every time a command runs. Use `ai-battery setup` or `ai-battery hud` if you want a persistent display.

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

Codex looks for `rate_limits` events in recent session logs. Claude Code provides usage and reset times through the statusLine payload, and actual 429 rate-limit hit logs are reflected as 0% until reset. In fallback mode, only recent token usage can be checked.

## Tech Stack

| Layer | Technology | Role |
| --- | --- | --- |
| CLI | Node.js | Log parsing, Claude cache, ANSI/statusLine output |
| PTY row | Python 3 | Reserved terminal row for running Codex |
| HUD launcher | Node.js / Bash compatibility wrapper | Launches the Windows native/WSL PowerShell HUD and macOS menu bar |
| HUD UI | PowerShell WinForms / AppleScriptObjC | Windows floating overlay, tray icon, macOS menu bar item |
| Linux HUD | GJS / StatusNotifierItem / libdbusmenu | Shared macOS panel artwork and Linux detail menu |
| Data | JSONL logs, statusLine JSON | Codex/Claude usage sources |

## Source Environment

The default CLI runs on Windows native, WSL, Linux, and macOS when Node.js 18 or newer is available. Windows runs Codex directly and uses a PowerShell/WinForms docked HUD by default; rowpty and same-console overlays are used only by explicitly selected compatibility layouts. On WSL/Linux/macOS, `ai-battery-run` uses Python 3 and POSIX PTY. macOS uses built-in `osascript` with AppleScriptObjC for its menu bar HUD.

Codex data is read from the `sessions` directory in the `CODEX_HOME` actually used by Codex (default: `~/.codex`). AI Battery never sets or changes `HOME`, `USERPROFILE`, or `CODEX_HOME`. Changing `CODEX_HOME` also changes Codex's own `/resume` store, so do not use it to combine Windows and WSL paths. Comma-separated homes are not supported.

```bash
CODEX_HOME=/path/to/codex-home ai-battery --watch --provider codex
```

When native Windows and WSL are used together, each environment keeps its own sessions and `/resume` history. Only the account-wide Codex 5h/7d usage is shared through AI Battery's `codex-account-usage.json`; session paths, workspaces, and approval/sandbox modes are never shared. Set `AI_BATTERY_SHARED_USAGE_STATE_DIR` only when the shared usage state itself needs an explicit location.

Claude usage display becomes available after installing the Claude Code statusLine hook.

## Caution

- This tool reads local logs and Claude statusLine payloads. It does not replace the service's official billing or limit screen.
- If Codex rate-limit events have not been created yet or are stale, the display may differ from the latest state.
- Claude statusLine provides only usage and reset times, so actual hit state is combined with 429 rate-limit logs left by Claude.
- The HUD uses PowerShell/WinForms on Windows, a menu bar item on macOS, and GJS with a StatusNotifier panel on Linux. On WSL, it uses both `powershell.exe` and `wsl.exe`.
- `ai-battery-run` is a PTY wrapper. Some full-screen TUIs may briefly disturb the status row because of screen-clearing escape sequences.
