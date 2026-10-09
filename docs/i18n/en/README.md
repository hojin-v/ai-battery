# AI Battery

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

For Codex, it reads `rate_limits` events from local session logs. For Claude Code, it caches the rate-limit payload delivered by the `statusLine` hook. When Claude records an actual 429 rate-limit hit, that limit is shown as 0% until the corresponding reset time. The default output stays compact on one line: running tools are shown in white, inactive tools in gray, and only the battery bar changes color based on remaining usage: green, orange, or red.

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
| Codex terminal row | Provides a PTY wrapper that pins a dedicated usage row under Codex. |
| Claude statusLine | Reads Claude rate-limit state from Claude Code's built-in statusLine hook and actual 429 hit logs. |
| HUD / menu bar | Provides a floating HUD on Windows native/WSL and a menu bar status item on macOS. |
| npm execution | Can be run with `npm install -g` or `npx`. |

## Platform Support

| Mode | Windows native | WSL | Linux | macOS | Note |
| --- | --- | --- | --- | --- | --- |
| `ai-battery` | Supported | Supported | Supported | Supported | Requires Node.js 18 or newer. |
| `ai-battery --watch` | Supported | Supported | Supported | Supported | Refreshes periodically inside the terminal. |
| Claude statusLine | Supported | Supported | Supported | Supported | Saves a `node <script>` command to Claude Code `statusLine`. |
| Codex terminal row | Supported | Supported | Supported | Supported | On Windows, the default VT compositor renders the child ConPTY into an isolated `rows - 1` screen, then composes it with the status row. If the compositor is unavailable, Codex runs safely without the injected row. WSL/Linux/macOS use POSIX PTY and `python3`. |
| `ai-battery setup codex` | Supported | Supported | Supported | Supported | Configures Codex `[tui].status_line` and installs a `codex.cmd` wrapper on Windows or a POSIX shell wrapper on WSL/Linux/macOS. |
| `ai-battery hud` | Supported | Supported | Unsupported | Supported | Windows/WSL use a PowerShell/WinForms HUD; macOS uses a menu bar status item. |

Runtime detection uses `/proc` on Linux/WSL, `ps` on macOS, and PowerShell process listings on Windows. Text output uses white/gray, while the macOS HUD highlights only running items with colored battery bars and shows inactive items in muted gray.

## Install

```bash
npm install -g ai-battery
```

You can also run it immediately without installing.

```bash
npx ai-battery
```

The previous command names, `claudex-battery`, `claudex-battery-run`, and `claudex-battery-hud`, are still provided as compatibility aliases.

## Quick Start

1. Install the package.

   ```bash
   npm install -g ai-battery
   ```

2. Set up automatic display for Claude and Codex.

   ```bash
   ai-battery setup
   ```

3. After that, keep using the original commands as usual.

   ```bash
   claude
   codex
   ```

4. Start the desktop HUD or macOS menu bar display when you need it.

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
| `--provider all\|codex\|claude` | Chooses which provider to show. |
| `--watch [seconds]` | Refreshes periodically on the same line. |
| `--json` | Outputs JSON that is convenient for HUDs or other tools. |
| `--bar-width N` | Adjusts the terminal battery bar width. |
| `--show-paths` | Shows log file paths and data observation timestamps. |
| `-v`, `--version` | Prints the installed `ai-battery` version. |

`doctor` checks the installation state and the latest npm version. If the network is unavailable, only the version check is skipped and the rest of the diagnostics are still shown.

## Uninstall

`off` only hides the display. `uninstall` removes the integration points created by `setup` and HUD autostart.

```bash
ai-battery uninstall
```

You can remove only part of the integration as well.

```bash
ai-battery uninstall codex
ai-battery uninstall claude
ai-battery uninstall hud
```

This command cleans up the Codex wrapper managed by AI Battery, Codex `[tui].status_line`, Claude `statusLine`, HUD/menu bar autostart, and any running HUD. It does not touch a `codex` file created by another tool or a Claude `statusLine` created elsewhere. If the Codex config was edited by the user after setup, it is left intact. If older versions or `--force` created backups, the command restores the original file or symlink when possible. The terminal row in a Codex session that is already running inside the AI Battery wrapper disappears only after that session exits.

Modern npm does not run the package uninstall lifecycle, so `npm uninstall ai-battery` or `npm uninstall -g ai-battery` alone cannot automatically clean up external integration points. To remove everything, run this before deleting the npm package.

```bash
ai-battery uninstall
npm uninstall -g ai-battery
```

If you already removed the npm package first, install it again and run `ai-battery uninstall`, or manually check and remove these items: the Codex wrapper created by AI Battery, the `# >>> ai-battery setup >>>` block in shell rc files, Codex `~/.codex/config.toml` `[tui].status_line`, Claude `statusLine`, and HUD/menu bar autostart.

## Setup

Run `setup` once. It installs a statusLine hook for Claude Code and sets up Codex with a default status line plus a platform wrapper, so you can keep launching the original commands afterward.

```bash
ai-battery setup
```

You can configure only one side if needed.

```bash
ai-battery setup claude
ai-battery setup codex
```

Codex setup configures `model-with-reasoning`, `current-dir`, and `git-branch` status line entries under `[tui]` in `~/.codex/config.toml`. Existing values are backed up for uninstall recovery. The Codex wrapper does not directly overwrite the existing `codex` command. If `~/.local/bin` already appears before the original `codex` on PATH and `~/.local/bin/codex` is empty or managed by AI Battery, the wrapper is placed there so it is picked up immediately. Otherwise, a managed wrapper is created at `~/.local/share/ai-battery/bin/codex`, and this directory is prepended to PATH in shell configuration when needed. If a shared location such as `~/.local/bin/codex` already contains another file, it is not overwritten. New terminals will automatically run `codex` with the AI Battery bottom row. If you already ran `codex` in the same terminal, the shell command cache may require one `hash -r`; if PATH needs to be updated, run the `source ...` command printed by `setup`.

On Windows native `cmd`/PowerShell, the `codex.cmd` wrapper runs the Windows runner. The default `auto`/`composite` layout does not pass the child ConPTY output straight through to the physical console. It first interprets the output in an isolated `rows - 1` VT screen provided by `@xterm/headless`, then composes that screen and the dedicated AI Battery bottom row onto the terminal. This keeps Codex alternate-screen switches, screen clears, scroll regions, and cursor queries separate from the status row's terminal state. The child ConPTY and both screens are resized together when the window changes size.

If `@xterm/headless` or the optional `node-pty` module cannot be loaded, or input/output is not a TTY, automatic mode safely launches plain Codex without an injected row instead of drawing over the same console. Reinstall and run `ai-battery doctor` to check the compositor dependencies. The former raw relay and same-console paths remain explicit compatibility/debugging opt-ins only: `AI_BATTERY_WIN_LAYOUT=rowpty`, `reserve`, or `overlay`; use `plain` to disable the row intentionally. `rowpty` requires a separately installed `rowpty.exe`; `setup` no longer compiles it. Claude statusLine appears only inside Claude Code, not in a regular `cmd`/PowerShell prompt.

To verify the Windows compositor, run `npm run smoke:win` in a native Windows terminal, or `npm run smoke:wsl-win` from WSL to open and test a real Windows console. These commands exercise `cmd.exe` and `powershell.exe` children, delayed output, status-row isolation, and alternate-screen restoration, then save `rowpty-smoke-report.json`. To test a long response and duplicate-frame detection with real Codex, run `npm run smoke:codex-win` or `npm run smoke:codex-wsl-win`, respectively. This E2E requires a working Codex login and network connection and writes `codex-compositor-e2e-report.json`.

Codex `/tui` fullscreen can show the combined row without a separate HUD when the runner's Node supports VT raw input. Real Windows Codex 0.161.0 with Node 24.21.0 passed the `/tui` picker, long streamed responses, Korean output, shrink/grow, Backspace, a second prompt and terminal restoration. Node 22.15.1 reproduced a word-deletion bug on ordinary Backspace. The updated runner checks the TTY's `rawMode` capability rather than guessing from version numbers, explains missing support and launches plain Codex without the extra row. On existing 0.1.18 installations that default to native fullscreen plus a HUD, select `AI_BATTERY_WIN_LAYOUT=composite` under a Node with VT input support. No global Node installation or Codex settings are changed automatically. The check covers real ConPTY output, keyboard input, resize and restoration; mouse selection/copy and IME require separate verification.

For Codex usage alone, select `five-hour-limit` and `weekly-limit` in Codex's `/statusline`. These built-in items need no external HUD. Use AI Battery's combined row to display Codex and Claude usage together.

Run `npm run smoke:codex-fullscreen-win` on Windows to check the current fullscreen without account quota. It uses actual Windows Codex and ConPTY, isolated temporary `CODEX_HOME` and project directories, and a loopback Responses fixture. Results go to `codex-fullscreen-check-report.json`. Use `node scripts/windows-codex-fullscreen-check.mjs --native` for direct Codex or `--expect-plain` to verify safe fallback on legacy Node. `--runner <path>` selects another runner; `--report <path>` selects the report path. Unsupported compositor environments fail the default check and record the reason.

In tmux, reserving a bottom row in every pane would duplicate the same global battery as many times as there are panes. Instead, you can show it once per session in the tmux status bar.

```bash
ai-battery setup tmux
```

This adds a managed block to `~/.tmux.conf`, displays the battery in `status-right` with a 10-second refresh interval, and lets `codex` inside tmux use the full pane instead of adding a per-pane battery row. Claude statusLine also collapses the battery row in the same environment and shows only the header row (model, directory, branch), because the battery is already in the tmux bar. To apply it, run `tmux source-file ~/.tmux.conf` and open a new pane. This block overwrites the existing `status-right` setting, so it is opt-in and not included in `setup all`. Remove it with `ai-battery uninstall tmux`; set `AI_BATTERY_TMUX=row` if you want to keep per-pane rows inside tmux. Claude statusLine is part of the Claude Code internal UI, so it is displayed regardless of tmux.

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

The Codex wrapper runs **the first Codex on the caller's PATH, excluding AI Battery wrappers**. npm, Homebrew, and standalone installations follow the same PATH order. It does not reuse a saved Codex path, search other nvm versions, or discover installations outside PATH.

After `nvm use`, a Codex installed under the selected Node runs when it comes first on PATH. If no original Codex is on PATH, the wrapper exits with `codex: command not found on PATH`, as in an ordinary npm environment. Install Codex or adjust PATH yourself if needed. Installing through both npm and Homebrew does not change this selection rule.

The wrapper preserves Codex's shebang, PATH, npm prefix, update notices, and update commands. It does not intercept `codex update` or suppress update prompts. HOME, `CODEX_HOME`, the working directory, and resume arguments are unchanged. AI Battery may use its own installed Node for usage polling only; it does not force Codex to use that runtime. If the runner is unavailable, the selected Codex runs without the usage row.

Refresh older wrappers that pin paths or manage installations by running `ai-battery setup codex` once with the updated package. With the new wrapper ahead of originals on PATH, Node changes do not require repeated setup. Use `ai-battery doctor` to inspect the PATH command, launch target, and whether the installed wrapper uses PATH only.

`ai-battery setup` configures Codex's own status line as `model/reasoning effort · workspace · git branch`. Usage display is handled by a separate `codex` wrapper, so users can type `codex` as usual. On Windows, an isolated VT screen compositor places the AI Battery row below Codex; on WSL/Linux/macOS, Codex runs in a POSIX PTY that is one line shorter.

```bash
codex
```

Advanced users who need to run the wrapper directly can use this command.

```bash
ai-battery-run --provider all codex
```

Use `--interval` to reduce the refresh interval.

```bash
ai-battery-run --interval 1 --provider all codex
```

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
ai-battery uninstall-claude-statusline
```

Claude must deliver a statusLine payload at least once before the Claude usage cache is created. Until then, the Claude local log fallback is shown.

## Desktop HUD

Drawing a status line safely over a normal terminal from an external process is not reliable. AI Battery therefore provides a floating overlay on Windows and a top menu bar status item on macOS. On Windows native, it runs directly through PowerShell/WinForms without WSL; from WSL, it launches the same HUD through `powershell.exe`. On macOS, it displays Codex and Claude logos, compact meters, and percentages as a small SVG image with a transparent background. Click it to see detailed status.

```bash
ai-battery hud
```

The HUD runs in the background and immediately returns control to the terminal. The Windows HUD can be moved by dragging, and the saved position is reused on the next launch. The macOS menu bar item appears in the right side of the system menu bar.

```text
Codex  [battery:88] │ 5h 00:47 │ 7d 93%
Claude [battery:76] │ 5h 00:47 │ 7d 59%
```

| Command | Role |
| --- | --- |
| `ai-battery hud` / `ai-battery hud start` | Starts the Windows floating HUD or macOS menu bar item. |
| `ai-battery hud stop` | Stops the running HUD/menu bar item. (`--stop` is the same.) |
| `ai-battery hud status` | Shows whether the HUD/menu bar item is running and whether autostart is registered. |
| `ai-battery hud autostart on` | Registers automatic startup on Windows login or macOS login. |
| `ai-battery hud autostart off` | Removes automatic startup registration. |
| `ai-battery hud autostart status` | Shows only autostart registration status. |
| `ai-battery hud -Foreground` | Runs attached to the terminal for debugging. |
| `ai-battery hud -Once` | Prints once in the console. |
| `ai-battery hud -Interval 2` | Changes the refresh interval. |
| `ai-battery hud -Mode tray` | Runs in Windows tray icon mode. On macOS, the menu bar item is the default. |
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
    R --> P[Codex terminal row]
    P --> W[Windows: ConPTY → headless VT → composed screen]
    P --> U[WSL/Linux/macOS: POSIX PTY]
    R --> H[Desktop HUD / menu bar]
```

Codex looks for `rate_limits` events in recent session logs. Claude Code provides usage and reset times through the statusLine payload, and actual 429 rate-limit hit logs are reflected as 0% until reset. In fallback mode, only recent token usage can be checked.

Codex displays the latest valid percentage from the base `codex` limit. Separate buckets such as `premium`, or events without percentages, do not overwrite it after exhaustion. A reported 100% used remains 0% remaining; unavailable percentages display `--%`. A last reported value of 99% is preserved rather than changed to 100%.

## Tech Stack

| Layer | Technology | Role |
| --- | --- | --- |
| CLI | Node.js | Log parsing, Claude cache, ANSI/statusLine output |
| Windows terminal row | `node-pty` / ConPTY, `@xterm/headless` | Interprets child VT in an isolated screen and composes the Codex screen with the status row |
| POSIX terminal row | Python 3 / POSIX PTY | Reserves the Codex bottom row on WSL/Linux/macOS |
| HUD launcher | Node.js / Bash compatibility wrapper | Launches the Windows native/WSL PowerShell HUD and macOS menu bar |
| HUD UI | PowerShell WinForms / AppleScriptObjC | Windows floating overlay, tray icon, macOS menu bar item |
| Data | JSONL logs, statusLine JSON | Codex/Claude usage sources |

## Source Environment

The default CLI runs on Windows native, WSL, Linux, and macOS when Node.js 18 or newer is available. On Windows native, the Codex terminal row is provided by a VT compositor built on `node-pty`/ConPTY and `@xterm/headless`. If a required compositor component is unavailable, it safely falls back to plain execution without a status row; raw `rowpty`, `reserve`, and `overlay` layouts are never selected automatically. On WSL/Linux/macOS, `ai-battery-run` uses Python 3 and POSIX PTY. The HUD uses PowerShell/WinForms on Windows/WSL and built-in `osascript` with AppleScriptObjC on macOS.

Codex data is read from `~/.codex/sessions` by default. Set `CODEX_HOME` if you use a different location.

```bash
CODEX_HOME=/path/to/codex-home ai-battery --provider codex
```

Claude usage display becomes available after installing the Claude Code statusLine hook.

## Caution

- This tool reads local logs and Claude statusLine payloads. It does not replace the service's official billing or limit screen.
- If Codex rate-limit events have not been created yet or are stale, the display may differ from the latest state.
- Claude statusLine provides only usage and reset times, so actual hit state is combined with 429 rate-limit logs left by Claude.
- The HUD is based on PowerShell/WinForms on Windows and a menu bar status item on macOS. On WSL, it uses both `powershell.exe` and `wsl.exe`.
- The Windows compositor re-renders child VT output instead of passing it through. Rare nonstandard escape sequences may not look exactly as they do in the host terminal; use `AI_BATTERY_WIN_LAYOUT=plain` as a workaround and attach the smoke report when reporting a problem.
- Because the Windows compositor itself uses the physical terminal's alternate screen, setting Codex `tui.alternate_screen=never` or `--no-alt-screen` does not replay session content into the host scrollback after exit.
- `rowpty`, `reserve`, and `overlay` are legacy opt-ins. Because child VT and the status row share physical terminal state in those modes, they are not recommended as normal defaults.
- On WSL/Linux/macOS, `ai-battery-run` is a POSIX PTY wrapper. Some full-screen TUIs may briefly disturb the status row because of screen-clearing escape sequences.
