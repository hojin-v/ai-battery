# AI Battery

0.1.22：默认 Codex 设置不修改执行命令、PATH 或配置。`reset settings` 恢复 AI Battery 集成并清理生成文件，保留 npm 包。包删除由 npm 单独完成。

[한국어](../../../README.md) · [English](../en/) · [日本語](../ja/) · [中文](../zh/) · [Español](../es/)

Codex 和 Claude 使用量电量计

一个终端状态显示工具，可以像电池一样查看 Codex 和 Claude Code 的剩余使用量。

![npm](https://img.shields.io/npm/v/ai-battery)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20WSL%20%7C%20Linux%20%7C%20macOS-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[安装](#install) · [功能](#features) · [快速开始](#quick-start) · [Claude StatusLine](#claude-statusline) · [桌面 HUD](#desktop-hud) · [注意事项](#caution)

<a id="overview"></a>
## 概览

`ai-battery` 是一个小型状态显示工具，用于在使用 Codex 和 Claude Code 时持续查看剩余使用量和重置时间。

Codex 会读取本地会话日志中的 `rate_limits` 事件；Claude Code 会缓存 `statusLine` hook 传入的 rate-limit payload。如果 Claude 记录了真实的 429 rate-limit hit，则在对应 reset 之前将该限制显示为 0%。默认输出保持为紧凑的一行：正在运行的工具显示为白色，未运行的工具显示为灰色，只有电量条会根据余量变为绿色、橙色或红色。

<img src="../../terminal-preview.svg" alt="AI Battery terminal preview showing green and red battery bars" width="940">

Markdown 的文本 fallback 会省略电量条，以避免不同渲染器中块字符高度差异带来的问题。在真实终端中，ANSI 颜色和块状电量条会一起渲染。

```text
Codex 86% │ 5h 18:09 │ 7d 82%  ┃  Claude 4% │ 5h 18:10 │ 7d 71%
```

| Provider | 来源 | 显示内容 |
| --- | --- | --- |
| Codex | `~/.codex/sessions/**/*.jsonl` | 5h 余量、5h 重置时间、7d 余量 |
| Claude Code | Claude `statusLine` payload cache + 429 hit logs | 5h 余量、5h 重置时间、7d 余量 |
| Claude fallback | `~/.claude/projects/**/*.jsonl` | 最近一轮 token 使用量 |

<a id="features"></a>
## 功能

| 功能 | 说明 |
| --- | --- |
| 统一使用量显示 | 以相同格式显示 Codex 和 Claude Code 的使用量。 |
| 重置时间显示 | 显示 `5h`、`7d` 窗口标签和值。 |
| 颜色规则 | 仅突出电量条：40% 以上为绿色，21-40% 为橙色，20% 以下为红色。 |
| Codex terminal row | 提供 PTY wrapper，在 Codex 下方固定一行专用使用量显示。 |
| Claude statusLine | 通过 Claude Code 内置 statusLine hook 和真实 429 hit 日志读取 Claude rate limit 状态。 |
| HUD / menu bar | Windows 原生/WSL 提供 floating HUD，macOS 提供 menu bar status item。 |
| npm 运行 | 可以通过 `npm install -g` 或 `npx` 运行。 |

<a id="platform-support"></a>
## 平台支持

| 模式 | Windows native | WSL | Linux | macOS | 备注 |
| --- | --- | --- | --- | --- | --- |
| `ai-battery` | 支持 | 支持 | 支持 | 支持 | 需要 Node.js 18 或更高版本。 |
| `ai-battery --watch` | 支持 | 支持 | 支持 | 支持 | 在终端内周期性刷新。 |
| Claude statusLine | 支持 | 支持 | 支持 | 支持 | 将 `node <script>` 命令保存到 Claude Code `statusLine`。 |
| Codex terminal row | 支持 | 支持 | 支持 | 支持 | Windows: fullscreen PTY composition; WSL/Linux/macOS: POSIX PTY and Python 3. |
| `ai-battery setup codex` | 支持 | 支持 | 支持 | 支持 | 解除旧 AI Battery wrapper。新 wrapper 和 Codex 配置修改需要显式选项。 |
| `ai-battery hud` | 支持 | 支持 | 不支持 | 支持 | Windows/WSL 使用 PowerShell/WinForms HUD，macOS 使用 menu bar status item。 |

运行中检测在 Linux/WSL 上使用 `/proc`，在 macOS 上使用 `ps`，在 Windows 上使用 PowerShell 进程列表。文本输出使用白色/灰色；macOS HUD 只用彩色电量条突出正在运行的项目，未运行项目则使用淡灰色显示。

<a id="install"></a>
## 安装

```bash
npm install -g ai-battery
```

也可以不安装，直接运行。

```bash
npx ai-battery
```

旧名称 `claudex-battery`、`claudex-battery-run`、`claudex-battery-hud` 仍作为兼容 alias 一并提供。

<a id="quick-start"></a>
## 快速开始

1. 安装包。

   ```bash
   npm install -g ai-battery
   ```

2. 配置 Claude statusLine，并解除旧 Codex wrapper。

   ```bash
   ai-battery setup
   ```

3. 之后继续照常使用原来的命令。

   ```bash
   claude
   codex
   ```

4. 使用 `ai-battery --watch 2` 或支持平台上的 HUD 查看 Codex 用量。

   ```bash
   ai-battery hud
   ```

<a id="cli"></a>
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

| 选项 | 说明 |
| --- | --- |
| `--provider all\|codex\|claude` | 选择要显示的 provider。 |
| `--watch [seconds]` | 在同一行周期性刷新。 |
| `--json` | 输出便于 HUD 或其他工具使用的 JSON。 |
| `--bar-width N` | 调整终端电量条长度。 |
| `--show-paths` | 同时显示日志文件路径和数据观测时间。 |
| `-v`, `--version` | 输出已安装的 `ai-battery` 版本。 |

`doctor` 会检查安装状态以及 npm latest 版本。如果网络不可用，只会跳过版本检查，其余诊断仍会继续显示。

<a id="uninstall"></a>
## Reset Settings

`ai-battery reset settings` 恢复 AI Battery 修改的设置，并清理归属明确的缓存、专用运行时和生成文件。其他 Codex/Claude 设置与 npm 包会保留。它不会将 Codex/Claude 全部设置重置为默认值。`reset config` 为同义命令。

```bash
ai-battery reset settings
```

只恢复部分集成时使用 `ai-battery reset settings codex` / `claude` / `hud` / `tmux`。已修改或归属未知的文件和未完成的恢复记录会保留。

设置恢复成功后再通过 npm 删除包。本地安装使用 `npm uninstall ai-battery`。`uninstall` 与 `teardown` 是设置恢复的兼容别名，不调用 npm。Windows 与 WSL 请分别运行。Bash 命令缓存用 `hash -r` 清除，zsh 用 `rehash`。

```bash
ai-battery reset settings && npm uninstall -g ai-battery
```

<a id="setup"></a>
## 设置

`setup` 配置 Claude statusLine hook。Codex 默认独立运行，只恢复旧 AI Battery wrapper 和受管理配置。使用 `ai-battery --watch 2` 或支持平台上的 `ai-battery hud` 查看用量。

```bash
ai-battery setup
ai-battery setup codex
```

只有 `ai-battery setup codex --wrap-codex` 才安装 PATH wrapper。修改 Codex `[tui].status_line` 还需要 `--configure-codex-statusline`。Windows runner 的 composite/HUD 仅适用于直接运行 runner 或显式选择 wrapper 的情况。

在 tmux 中，如果每个 pane 都预留下方一行，同一个全局电量状态会按 pane 数量重复显示。可以改为在 tmux status bar 中每个 session 只显示一次。

```bash
ai-battery setup tmux
```

这会向 `~/.tmux.conf` 添加受管理 block，在 status-right 中显示电量状态（每 10 秒刷新一次）；在该 tmux 内运行的 `codex` 会省略每个 pane 的电量行，使用完整 pane。Claude statusLine 在同一环境中也会折叠电量行，只显示 header（模型、目录、分支）一行，因为电量已经显示在 tmux bar 中。要应用配置，请运行 `tmux source-file ~/.tmux.conf` 后打开新的 pane。此 block 会覆盖现有 `status-right` 设置，因此它是 opt-in，不包含在 `setup all` 中。用 `ai-battery reset settings tmux` 可解除；如果希望在 tmux 内仍保留每个 pane 的状态行，请设置 `AI_BATTERY_TMUX=row`。Claude statusLine 属于 Claude Code 内部 UI，因此无论是否使用 tmux 都会显示。

如果看不到 Codex 下方状态行，请运行诊断。

```bash
ai-battery doctor
```

显示哪些 provider 可以用简短的 on/off 命令切换。

```bash
ai-battery off codex
ai-battery on codex
ai-battery off claude
ai-battery on claude
ai-battery off all
ai-battery on all
```

此设置会同时应用于 CLI、Claude statusLine、Codex wrapper 和 HUD。

<a id="codex-terminal-row"></a>
## Codex 终端行

普通 `codex` 不经过 AI Battery。仅为一个会话添加下方状态行时运行：

```bash
ai-battery-run --provider all -- codex       # WSL/Linux/macOS
ai-battery-run-win --provider all -- codex   # Windows cmd/PowerShell
```

<a id="claude-statusline"></a>
## Claude StatusLine

Claude Code 通过内置 `statusLine` hook 提供 rate-limit 使用率和 reset 时间。AI Battery 会将其与 Claude JSONL 中真实的 429 rate-limit hit 记录一起反映。安装后，Claude 会渲染两行。

<img src="../../claude-statusline-preview.svg" alt="Claude statusLine preview showing colored AI Battery bars" width="940">

```text
Opus high · ~/Projects · main                               83% context left
Codex 71% │ 5h 00:47 │ 7d 90%  Claude 76% │ 5h 00:47 │ 7d 59%
```

第一行显示模型、推理等级、workspace root、git branch，并在右端固定显示 Claude context 余量。第二行以相同格式显示 Codex 和 Claude 的使用量。

设置：

```bash
ai-battery setup claude
```

移除：

```bash
ai-battery reset settings claude
```

Claude 至少传递一次 statusLine payload 后，Claude 使用量缓存才会生成。在此之前，会显示基于 Claude 本地日志的 fallback。

<a id="desktop-hud"></a>
## 桌面 HUD

让外部进程安全地在普通终端上绘制 status line 并不稳定。因此 Windows 上提供 floating overlay，macOS 上提供顶部 menu bar status item。Windows 原生环境无需 WSL，直接通过 PowerShell/WinForms 运行；WSL 中则通过 `powershell.exe` 启动同一个 HUD。macOS 上会用透明背景的小型 SVG 图像显示 Codex 和 Claude logo、短 meter 和百分比，点击即可查看详细状态。

```bash
ai-battery hud
```

HUD 会在后台运行，并立即把终端还给你。Windows HUD 可以拖拽移动位置，并在下次启动时复用保存的位置。macOS menu bar item 会显示在系统菜单栏右侧区域。

```text
Codex  [battery:88] │ 5h 00:47 │ 7d 93%
Claude [battery:76] │ 5h 00:47 │ 7d 59%
```

| 命令 | 作用 |
| --- | --- |
| `ai-battery hud` / `ai-battery hud start` | 启动 Windows floating HUD 或 macOS menu bar item。 |
| `ai-battery hud stop` | 停止正在运行的 HUD/menu bar item。（`--stop` 相同。） |
| `ai-battery hud status` | 显示 HUD/menu bar 运行状态和 autostart 注册状态。 |
| `ai-battery hud autostart on` | 注册 Windows 登录或 macOS 登录时自动运行。 |
| `ai-battery hud autostart off` | 取消自动运行注册。 |
| `ai-battery hud autostart status` | 仅显示自动运行注册状态。 |
| `ai-battery hud -Foreground` | 以调试方式附着在终端中运行。 |
| `ai-battery hud -Once` | 在控制台中只输出一次。 |
| `ai-battery hud -Interval 2` | 修改刷新周期。 |
| `ai-battery hud -Mode tray` | 以 Windows tray icon 模式运行。macOS 默认使用 menu bar item。 |
| `ai-battery hud light` / `ai-battery hud dark` | 将 Windows floating HUD 切换为适合亮色任务栏的黑字，或适合暗色任务栏的白字。 |
| `ai-battery hud black` / `ai-battery hud white` | 直接将文字颜色改为黑色或白色。 |
| `ai-battery hud --backdrop` / `ai-battery hud --no-backdrop` | 开启或关闭 Windows floating HUD 文字背后的深色 backing。 |

Windows floating HUD 默认以透明背景上的亮色文字显示。亮色任务栏可用 `ai-battery hud light`，暗色任务栏可用 `ai-battery hud dark`。如果要直接选择文字颜色，请使用 `ai-battery hud black` 或 `ai-battery hud white`。要把同样模式保存到登录自动运行中，可以写成 `ai-battery hud autostart on light`。

Windows autostart 会按用户注册到 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`。Windows 原生环境无需 WSL 即可直接运行；从 WSL 注册时，会把 HUD 脚本副本放到 `%LOCALAPPDATA%\ai-battery`。macOS autostart 注册为 `~/Library/LaunchAgents/com.ai-battery.hud.plist`。更新 ai-battery 后，请重新运行 `ai-battery hud autostart on` 来刷新注册路径。

<a id="shell-prompt"></a>
## Shell Prompt

也可以放入 shell prompt。

```bash
export PS1='$(ai-battery --provider codex) '"$PS1"
```

prompt 方式会在每次执行命令时刷新。如果需要持续显示，请使用 `ai-battery setup` 或 `ai-battery hud`。

<a id="how-it-works"></a>
## 工作原理

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

Codex 会在最近的会话日志中查找 `rate_limits` 事件。Claude Code 通过 statusLine payload 提供使用率和重置时间，如果存在真实的 429 rate-limit hit 日志，则在 reset 前反映为 0%。fallback 模式下只能查看最近 token 使用量。

<a id="tech-stack"></a>
## 技术栈

| 层 | 技术 | 作用 |
| --- | --- | --- |
| CLI | Node.js | 日志解析、Claude cache、ANSI/statusLine 输出 |
| PTY row | Python 3 | Codex 运行用 reserved terminal row |
| HUD launcher | Node.js / Bash compatibility wrapper | 启动 Windows 原生/WSL PowerShell HUD 和 macOS menu bar |
| HUD UI | PowerShell WinForms / AppleScriptObjC | Windows floating overlay、tray icon、macOS menu bar item |
| Data | JSONL logs, statusLine JSON | Codex/Claude 使用量来源 |

<a id="source-environment"></a>
## 源环境

Node.js 18+ supports the CLI. Windows defaults to `composite`: PATH-selected Codex runs in bundled ConPTY, and `@xterm/headless` composes its fullscreen display above one battery row. If Windows VT raw input is unavailable, a private SHA256-verified Node 24.21.0 is installed without changing system Node or PATH. Runtime/dependency failure falls back to the native HUD. `auto` selects composite; `fullscreen`/`hud` explicitly select the HUD. `plain` disables the display. Legacy rowpty modes remain opt-in. WSL/Linux/macOS use Python 3 and POSIX PTY.

Codex 数据从 Codex 实际使用的 `CODEX_HOME`（默认 `~/.codex`）中的 `sessions` 读取。AI Battery 不会设置或修改 `HOME`、`USERPROFILE` 或 `CODEX_HOME`。修改 `CODEX_HOME` 也会改变 Codex 自身的 `/resume` 存储位置，因此不要用它合并 Windows 与 WSL 路径。不支持以逗号分隔多个 home。

```bash
CODEX_HOME=/path/to/codex-home ai-battery --provider codex
```

同时使用 Windows native 与 WSL 时，两边的 session 和 `/resume` 历史仍各自独立。仅通过 AI Battery 专用的 `codex-account-usage.json` 共享账号级 Codex 5h/7d 使用量；session 路径、workspace 以及 approval/sandbox mode 不会共享。

Claude 使用量显示从安装 Claude Code statusLine hook 后开始可用。

<a id="caution"></a>
## 注意事项

- 此工具读取本地日志和 Claude statusLine payload，不能替代服务的官方计费/限制页面。
- 如果 Codex rate limit 事件尚未生成或已经过旧，显示结果可能与最新状态存在差异。
- Claude statusLine 只提供使用率和 reset 时间，因此真实 hit 状态会结合 Claude 留下的 429 rate-limit 日志一起反映。
- HUD 在 Windows 上基于 PowerShell/WinForms，在 macOS 上基于 menu bar status item。WSL 中会同时使用 `powershell.exe` 和 `wsl.exe`。
- `ai-battery-run` 是 PTY wrapper。一些全屏 TUI 可能会因为清屏 escape sequence 让 status row 短暂晃动。
