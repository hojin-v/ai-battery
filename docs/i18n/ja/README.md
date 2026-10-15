# AI Battery

0.1.22: Codex の既定セットアップは実行コマンド・PATH・設定を変更しません。`reset settings` は AI Battery の統合を復元して生成ファイルを整理します。npm パッケージは保持し、削除は npm で別途行います。

[한국어](../../../README.md) · [English](../en/) · [日本語](../ja/) · [中文](../zh/) · [Español](../es/)

Codex と Claude の使用量バッテリーメーター

Codex と Claude Code の残り使用量を、バッテリーのように確認できるターミナル用ステータス表示ツールです。

![npm](https://img.shields.io/npm/v/ai-battery)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20WSL%20%7C%20Linux%20%7C%20macOS-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[インストール](#install) · [機能](#features) · [クイックスタート](#quick-start) · [Claude StatusLine](#claude-statusline) · [Desktop HUD](#desktop-hud) · [注意](#caution)

<a id="overview"></a>
## 概要

`ai-battery` は、Codex と Claude Code を使いながら残り使用量とリセット時刻を継続的に確認するための小さなステータス表示ツールです。

Codex については、ローカルセッションログの `rate_limits` イベントを読み取ります。Claude Code については、`statusLine` hook が渡す rate-limit payload をキャッシュして使います。Claude が実際の 429 rate-limit hit を記録した場合は、該当する reset までその制限を 0% として反映します。デフォルト出力は小さな 1 行に保たれ、実行中のツールは白、実行中でないツールはグレーで表示されます。バッテリーバーだけが残量に応じて緑、オレンジ、赤に変わります。

<img src="../../terminal-preview.svg" alt="AI Battery terminal preview showing green and red battery bars" width="940">

Markdown のテキスト fallback では、レンダラーごとのブロック文字の高さの違いを避けるためにバーを省略しています。実際のターミナルでは ANSI カラーとブロックバーが一緒にレンダリングされます。

```text
Codex 86% │ 5h 18:09 │ 7d 82%  ┃  Claude 4% │ 5h 18:10 │ 7d 71%
```

| プロバイダー | ソース | 表示内容 |
| --- | --- | --- |
| Codex | `~/.codex/sessions/**/*.jsonl` | 5h 残量、5h リセット時刻、7d 残量 |
| Claude Code | Claude `statusLine` payload cache + 429 hit logs | 5h 残量、5h リセット時刻、7d 残量 |
| Claude fallback | `~/.claude/projects/**/*.jsonl` | 直近ターンのトークン使用量 |

<a id="features"></a>
## 機能

| 機能 | 説明 |
| --- | --- |
| 共通の使用量表示 | Codex と Claude Code の使用量を同じ形式で表示します。 |
| リセット時刻表示 | `5h`、`7d` のウィンドウラベルと値を表示します。 |
| 色の基準 | 40% 超は緑、21-40% はオレンジ、20% 以下は赤で、バッテリーだけを強調します。 |
| Codex terminal row | Codex の下に専用の使用量行を固定する PTY wrapper を提供します。 |
| Claude statusLine | Claude Code 内蔵の statusLine hook と実際の 429 hit ログから Claude の rate limit 状態を読み取ります。 |
| HUD / menu bar | Windows native/WSL では floating HUD、macOS では menu bar status item を提供します。 |
| npm 実行 | `npm install -g` または `npx` で実行できます。 |

<a id="platform-support"></a>
## プラットフォーム対応

| モード | Windows native | WSL | Linux | macOS | 備考 |
| --- | --- | --- | --- | --- | --- |
| `ai-battery` | 対応 | 対応 | 対応 | 対応 | Node.js 18 以上が必要です。 |
| `ai-battery --watch` | 対応 | 対応 | 対応 | 対応 | ターミナル内で定期的に更新します。 |
| Claude statusLine | 対応 | 対応 | 対応 | 対応 | Claude Code `statusLine` に `node <script>` コマンドを保存します。 |
| Codex terminal row | 対応 | 対応 | 対応 | 対応 | Windows: fullscreen PTY composition; WSL/Linux/macOS: POSIX PTY and Python 3. |
| `ai-battery setup codex` | 対応 | 対応 | 対応 | 対応 | 既存の AI Battery wrapper を解除します。新しい wrapper と Codex 設定変更は明示的なオプションが必要です。 |
| `ai-battery hud` | 対応 | 対応 | 未対応 | 対応 | Windows/WSL は PowerShell/WinForms HUD、macOS は menu bar status item です。 |

実行中の検出には、Linux/WSL では `/proc`、macOS では `ps`、Windows では PowerShell のプロセス一覧を使います。テキスト出力は白/グレーで、macOS HUD では実行中の項目だけを色付きバッテリーバーで強調し、実行中でない項目は淡いグレー系で表示します。

<a id="install"></a>
## インストール

```bash
npm install -g ai-battery
```

インストールせずにすぐ実行することもできます。

```bash
npx ai-battery
```

以前の名前である `claudex-battery`、`claudex-battery-run`、`claudex-battery-hud` コマンドも、互換 alias として引き続き提供されます。

<a id="quick-start"></a>
## クイックスタート

1. パッケージをインストールします。

   ```bash
   npm install -g ai-battery
   ```

2. Claude statusLine を設定し、旧 Codex wrapper を解除します。

   ```bash
   ai-battery setup
   ```

3. 以降は元のコマンドをそのまま使います。

   ```bash
   claude
   codex
   ```

4. Codex の使用量は `ai-battery --watch 2` または対応 OS の HUD で確認します。

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

| オプション | 説明 |
| --- | --- |
| `--provider all\|codex\|claude` | 表示する provider を選択します。 |
| `--watch [seconds]` | 同じ行で定期的に更新します。 |
| `--json` | HUD や他のツールで使いやすい JSON を出力します。 |
| `--bar-width N` | ターミナルのバッテリーバーの長さを調整します。 |
| `--show-paths` | ログファイルパスとデータ観測時刻を一緒に表示します。 |
| `-v`, `--version` | インストール済みの `ai-battery` バージョンを出力します。 |

`doctor` はインストール状態と npm latest バージョンを確認します。ネットワークが使えない場合はバージョン確認だけをスキップし、その他の診断は続けて表示します。

<a id="uninstall"></a>
## Reset Settings

`ai-battery reset settings` は AI Battery が変更した設定を元に戻し、所有権を確認したキャッシュ・専用ランタイム・生成ファイルを整理します。他の Codex/Claude 設定と npm パッケージは保持します。Codex/Claude の設定全体を初期化するコマンドではありません。`reset config` も同じ動作です。

```bash
ai-battery reset settings
```

一部だけを復元する場合は `ai-battery reset settings codex` / `claude` / `hud` / `tmux` を使います。編集済み・所有権不明のファイルと未解決の復旧記録は保持します。

パッケージの削除は設定復元に成功してから npm で行います。ローカルインストールは `npm uninstall ai-battery` を使います。`uninstall` と `teardown` は設定復元の互換別名で、npm は実行しません。Windows と WSL はそれぞれ実行してください。Bash のキャッシュは `hash -r`、zsh は `rehash` で消去できます。

```bash
ai-battery reset settings && npm uninstall -g ai-battery
```

<a id="setup"></a>
## セットアップ

`setup` は Claude statusLine hook を設定します。Codex は独立して実行され、旧 AI Battery wrapper と管理設定だけを復元します。使用量は `ai-battery --watch 2` または対応 OS の `ai-battery hud` で確認できます。

```bash
ai-battery setup
ai-battery setup codex
```

`ai-battery setup codex --wrap-codex` だけが PATH wrapper をインストールします。Codex `[tui].status_line` の変更には `--configure-codex-statusline` も必要です。Windows runner の composite/HUD は runner を直接実行するか wrapper を選んだ場合に適用されます。

tmux では pane ごとに下部行を予約すると、同じグローバルバッテリーが pane の数だけ重複表示されます。代わりに tmux の status bar にセッションごと 1 回だけ表示できます。

```bash
ai-battery setup tmux
```

`~/.tmux.conf` に管理ブロックを追加し、status-right にバッテリーを表示します（10 秒間隔で更新）。この tmux 内で実行される `codex` は pane ごとのバッテリー行を省略し、pane 全体を使います。Claude statusLine も同じ環境ではバッテリー行を折りたたみ、ヘッダー（モデル、ディレクトリ、ブランチ）1 行だけを表示します。バッテリーはすでに tmux bar にあるためです。適用するには `tmux source-file ~/.tmux.conf` を実行し、新しい pane を開いてください。このブロックは既存の `status-right` 設定を上書きするため、`setup all` には含まれない opt-in です。解除は `ai-battery reset settings tmux`、tmux 内でも pane ごとの行を維持したい場合は `AI_BATTERY_TMUX=row` を設定します。Claude statusLine は Claude Code 内部 UI なので、tmux かどうかに関係なく表示されます。

Codex の下部行が表示されない場合は診断を実行します。

```bash
ai-battery doctor
```

表示する provider は短い on/off コマンドで変更します。

```bash
ai-battery off codex
ai-battery on codex
ai-battery off claude
ai-battery on claude
ai-battery off all
ai-battery on all
```

この設定は CLI、Claude statusLine、Codex wrapper、HUD にまとめて適用されます。

<a id="codex-terminal-row"></a>
## Codex ターミナル行

通常の `codex` は AI Battery を経由しません。1 セッションだけ下部行を追加する場合は次を実行します。

```bash
ai-battery-run --provider all -- codex       # WSL/Linux/macOS
ai-battery-run-win --provider all -- codex   # Windows cmd/PowerShell
```

<a id="claude-statusline"></a>
## Claude StatusLine

Claude Code は内蔵の `statusLine` hook を通じて rate-limit 使用率と reset 時刻を提供します。AI Battery はそこに Claude JSONL の実際の 429 rate-limit hit 記録を合わせて反映します。インストール後、Claude は 2 行をレンダリングします。

<img src="../../claude-statusline-preview.svg" alt="Claude statusLine preview showing colored AI Battery bars" width="940">

```text
Opus high · ~/Projects · main                               83% context left
Codex 71% │ 5h 00:47 │ 7d 90%  Claude 76% │ 5h 00:47 │ 7d 59%
```

1 行目はモデル、推論レベル、workspace root、git branch を表示し、右端に Claude context 残量を固定します。2 行目は Codex と Claude の使用量を同じ形式で表示します。

設定:

```bash
ai-battery setup claude
```

削除:

```bash
ai-battery reset settings claude
```

Claude が少なくとも一度 statusLine payload を渡すまで、Claude の使用量キャッシュは作成されません。それまでは Claude ローカルログベースの fallback が表示されます。

<a id="desktop-hud"></a>
## Desktop HUD

通常のターミナルの上に外部プロセスが安全に status line を描画する方法は安定していません。そのため Windows では floating overlay、macOS では上部 menu bar status item を提供します。Windows native では WSL なしで PowerShell/WinForms により直接実行され、WSL では `powershell.exe` を通じて同じ HUD を起動します。macOS では透明背景の小さな SVG 画像で Codex と Claude のロゴ、短いメーター、パーセントを表示し、クリックすると詳細な状態を確認できます。

```bash
ai-battery hud
```

HUD はバックグラウンドで実行され、ターミナルをすぐに返します。Windows HUD はドラッグで位置を移動でき、次回起動時に保存済み位置を再利用します。macOS menu bar item はシステムメニューバーの右側領域に表示されます。

```text
Codex  [battery:88] │ 5h 00:47 │ 7d 93%
Claude [battery:76] │ 5h 00:47 │ 7d 59%
```

| コマンド | 役割 |
| --- | --- |
| `ai-battery hud` / `ai-battery hud start` | Windows floating HUD または macOS menu bar item を開始します。 |
| `ai-battery hud stop` | 実行中の HUD/menu bar item を終了します。(`--stop` も同じです。) |
| `ai-battery hud status` | HUD/menu bar の実行状態と autostart 登録状態を表示します。 |
| `ai-battery hud autostart on` | Windows ログインまたは macOS ログイン時の自動実行を登録します。 |
| `ai-battery hud autostart off` | 自動実行登録を解除します。 |
| `ai-battery hud autostart status` | 自動実行登録状態だけを表示します。 |
| `ai-battery hud -Foreground` | デバッグ用にターミナルに接続して実行します。 |
| `ai-battery hud -Once` | コンソールに一度だけ出力します。 |
| `ai-battery hud -Interval 2` | 更新間隔を変更します。 |
| `ai-battery hud -Mode tray` | Windows tray icon モードで実行します。macOS では menu bar item がデフォルトです。 |
| `ai-battery hud light` / `ai-battery hud dark` | Windows floating HUD を、明るいタスクバー用の黒文字または暗いタスクバー用の白文字に切り替えます。 |
| `ai-battery hud black` / `ai-battery hud white` | 文字色を直接黒または白に変更します。 |
| `ai-battery hud --backdrop` / `ai-battery hud --no-backdrop` | Windows floating HUD の文字背後にある暗い backing をオン/オフします。 |

Windows floating HUD はデフォルトで透明背景に明るい文字で表示します。明るいタスクバーでは `ai-battery hud light`、暗いタスクバーでは `ai-battery hud dark` を使ってください。文字色を直接選ぶ場合は `ai-battery hud black` または `ai-battery hud white` を使います。ログイン自動実行にも同じモードを保存するには、`ai-battery hud autostart on light` のように指定します。

Windows autostart は `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` にユーザー単位で登録されます。Windows native では WSL なしで直接実行され、WSL から登録した場合は HUD スクリプトのコピーを `%LOCALAPPDATA%\ai-battery` に置きます。macOS autostart は `~/Library/LaunchAgents/com.ai-battery.hud.plist` として登録されます。ai-battery を更新した後は、`ai-battery hud autostart on` を再実行して登録パスを更新してください。

<a id="shell-prompt"></a>
## シェルプロンプト

シェルプロンプトに入れることもできます。

```bash
export PS1='$(ai-battery --provider codex) '"$PS1"
```

プロンプト方式はコマンドを実行するたびに更新されます。常に表示したい場合は `ai-battery setup` または `ai-battery hud` を使ってください。

<a id="how-it-works"></a>
## 仕組み

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

Codex は直近のセッションログから `rate_limits` イベントを探します。Claude Code は statusLine payload で使用率とリセット時刻を提供し、実際の 429 rate-limit hit ログがある場合は reset まで 0% として反映します。fallback モードでは直近のトークン使用量だけを確認できます。

<a id="tech-stack"></a>
## 技術スタック

| レイヤー | 技術 | 役割 |
| --- | --- | --- |
| CLI | Node.js | ログ解析、Claude cache、ANSI/statusLine 出力 |
| PTY row | Python 3 | Codex 実行用の reserved terminal row |
| HUD launcher | Node.js / Bash compatibility wrapper | Windows native/WSL PowerShell HUD と macOS menu bar の起動 |
| HUD UI | PowerShell WinForms / AppleScriptObjC | Windows floating overlay、tray icon、macOS menu bar item |
| Data | JSONL logs, statusLine JSON | Codex/Claude 使用量ソース |

<a id="source-environment"></a>
## ソース環境

Node.js 18+ supports the CLI. Windows defaults to `composite`: PATH-selected Codex runs in bundled ConPTY, and `@xterm/headless` composes its fullscreen display above one battery row. If Windows VT raw input is unavailable, a private SHA256-verified Node 24.21.0 is installed without changing system Node or PATH. Runtime/dependency failure falls back to the native HUD. `auto` selects composite; `fullscreen`/`hud` explicitly select the HUD. `plain` disables the display. Legacy rowpty modes remain opt-in. WSL/Linux/macOS use Python 3 and POSIX PTY.

Codex データは、Codex が実際に使用する `CODEX_HOME`（既定値 `~/.codex`）内の `sessions` を読みます。AI Battery は `HOME`、`USERPROFILE`、`CODEX_HOME` を設定・変更しません。`CODEX_HOME` を変更すると Codex 自身の `/resume` 保存先も変わるため、Windows と WSL のパス統合には使用しないでください。カンマ区切りの複数 home はサポートされません。

```bash
CODEX_HOME=/path/to/codex-home ai-battery --provider codex
```

Windows native と WSL を併用する場合も、各環境の session と `/resume` 履歴は独立して維持されます。共有されるのは AI Battery 専用 `codex-account-usage.json` に保存されるアカウント共通の Codex 5h/7d 使用量だけで、session path、workspace、approval/sandbox mode は共有されません。

Claude の使用量表示は、Claude Code statusLine hook をインストールした後から利用できます。

<a id="caution"></a>
## 注意

- このツールはローカルログと Claude statusLine payload を読み取ります。サービスの公式課金/制限画面の代わりにはなりません。
- Codex rate limit イベントがまだ生成されていない、または古い場合、最新状態と差が出ることがあります。
- Claude statusLine は使用率と reset 時刻だけを提供するため、実際の hit 状態は Claude が残した 429 rate-limit ログと合わせて反映します。
- HUD は Windows では PowerShell/WinForms ベース、macOS では menu bar status item ベースです。WSL では `powershell.exe` と `wsl.exe` を一緒に使います。
- `ai-battery-run` は PTY wrapper です。一部の全画面 TUI では画面を消去する escape sequence のため、status row が一時的に揺れることがあります。
