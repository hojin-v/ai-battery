#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HeadlessTerminalCompositor, HOST_RESTORE_SEQUENCE } from "./terminal-compositor.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const BIN_DIR = path.join(PROJECT_ROOT, "bin");
const BATTERY_BIN = process.env.AI_BATTERY_BIN
  || process.env.CLAUDEX_BATTERY_BIN
  || path.join(BIN_DIR, "ai-battery.js");
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const DEBUG_LOG = process.env.AI_BATTERY_DEBUG_LOG || process.env.CLAUDEX_BATTERY_DEBUG_LOG || "";
const DEFAULT_COLUMN_GUARD = 4;
const DEFAULT_LEFT_PADDING = 2;
const DEFAULT_CODEX_OVERLAY_BOTTOM_OFFSET = 1;
const DEFAULT_VSCODE_CODEX_OVERLAY_BOTTOM_OFFSET = 2;
const MAX_COMPOSITOR_PENDING_OUTPUT_BYTES = 1024 * 1024;
const RESUME_COMPOSITOR_OUTPUT_BYTES = 256 * 1024;
const UNSAFE_CMD_ARGUMENT_RE = /[\r\n&|<>^%!()]/;
const UNSAFE_CMD_PATH_RE = /[\r\n&|<>^%!]/;

function usage() {
  console.log(`Usage: ai-battery-run-win [--interval SECONDS] [--bar-width N] [--provider auto|all|codex|claude] [--layout fullscreen|hud|plain|tui|inline|auto|composite|reserve|overlay] [--left-padding N] -- COMMAND [ARGS...]

Runs COMMAND with an AI Battery display.
Default layout "fullscreen" launches Codex directly and lets Codex own the host
alternate screen, scrolling, input, and built-in status line. AI Battery stays
in the docked second-row HUD. "auto" is a compatibility alias for
fullscreen. "composite" enables the experimental headless ConPTY compositor.
"plain" runs COMMAND directly without the HUD. "tui", "reserve", and "overlay"
keep the legacy raw terminal-row paths available for compatibility.`);
}

const WINDOWS_LAYOUTS = new Set(["fullscreen", "hud", "plain", "tui", "inline", "auto", "composite", "reserve", "overlay"]);

function normalizeLayout(value) {
  const layout = String(value || "fullscreen").toLowerCase();
  return WINDOWS_LAYOUTS.has(layout) ? layout : "fullscreen";
}

function debugLog(event, details = {}) {
  if (!DEBUG_LOG) return;
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, `${JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...details
    })}\n`);
  } catch {
    // Debug logging must never interfere with launching Codex.
  }
}

function parseArgs(argv) {
  const args = {
    interval: Number(process.env.AI_BATTERY_INTERVAL || process.env.CLAUDEX_BATTERY_INTERVAL || 10),
    barWidth: process.env.AI_BATTERY_BAR_WIDTH || process.env.CLAUDEX_BATTERY_BAR_WIDTH || "10",
    provider: process.env.AI_BATTERY_PROVIDER || process.env.CLAUDEX_BATTERY_PROVIDER || "auto",
    layout: normalizeLayout(process.env.AI_BATTERY_WIN_LAYOUT || process.env.CLAUDEX_BATTERY_WIN_LAYOUT || process.env.AI_BATTERY_LAYOUT),
    leftPadding: Number(process.env.AI_BATTERY_LEFT_PADDING || process.env.CLAUDEX_BATTERY_LEFT_PADDING || DEFAULT_LEFT_PADDING),
    command: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else if (arg === "--interval") {
      args.interval = Math.max(0.5, Number(argv[++i]) || args.interval);
    } else if (arg === "--bar-width") {
      args.barWidth = argv[++i] || args.barWidth;
    } else if (arg === "--provider") {
      args.provider = argv[++i] || args.provider;
      if (!["auto", "all", "codex", "claude"].includes(args.provider)) {
        throw new Error("--provider must be one of: auto, all, codex, claude");
      }
    } else if (arg === "--layout") {
      const layout = String(argv[++i] || args.layout).toLowerCase();
      if (!WINDOWS_LAYOUTS.has(layout)) {
        throw new Error("--layout must be one of: fullscreen, hud, plain, tui, inline, auto, composite, reserve, overlay");
      }
      args.layout = layout;
    } else if (arg === "--left-padding") {
      const value = Number(argv[++i]);
      args.leftPadding = Number.isFinite(value)
        ? Math.max(0, Math.min(20, value))
        : args.leftPadding;
    } else if (arg === "--") {
      args.command = argv.slice(i + 1);
      break;
    } else {
      args.command = argv.slice(i);
      break;
    }
  }

  if (!args.command.length) {
    usage();
    process.exit(2);
  }
  if (!Number.isFinite(args.interval)) args.interval = 10;
  args.layout = normalizeLayout(args.layout);
  return args;
}

function inferProvider(command) {
  const joined = command.join(" ").toLowerCase();
  const names = command.map((part) => path.basename(part).toLowerCase());
  if (names.some((name) => name.includes("codex")) || joined.includes("@openai/codex")) return "codex";
  if (names.some((name) => name.includes("claude")) || joined.includes("@anthropic-ai/claude-code")) return "claude";
  return "all";
}

function termSize() {
  const windowSize = process.stdout.getWindowSize?.();
  const cols = process.stdout.columns || windowSize?.[0] || 80;
  const rows = process.stdout.rows || windowSize?.[1] || 24;
  return {
    cols: Math.max(20, cols),
    rows: Math.max(1, rows)
  };
}

function columnGuard() {
  const raw = process.env.AI_BATTERY_COLUMN_GUARD || process.env.CLAUDEX_BATTERY_COLUMN_GUARD;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(20, Math.floor(value))) : DEFAULT_COLUMN_GUARD;
}

function overlayBottomOffset(activeProvider) {
  const raw = Number(process.env.AI_BATTERY_OVERLAY_BOTTOM_OFFSET || process.env.CLAUDEX_BATTERY_OVERLAY_BOTTOM_OFFSET);
  if (Number.isFinite(raw)) return Math.max(0, Math.min(5, Math.floor(raw)));
  if (activeProvider !== "codex") return 0;
  return isVsCodeTerminal()
    ? DEFAULT_VSCODE_CODEX_OVERLAY_BOTTOM_OFFSET
    : DEFAULT_CODEX_OVERLAY_BOTTOM_OFFSET;
}

function statusRow(rows, bottomOffset = 0) {
  const safeRows = Math.max(1, Number(rows) || 1);
  const safeOffset = Math.max(0, Math.min(5, Math.floor(Number(bottomOffset) || 0)));
  return Math.max(1, safeRows - safeOffset);
}

function isVsCodeTerminal() {
  return String(process.env.TERM_PROGRAM || "").toLowerCase() === "vscode"
    || Boolean(process.env.VSCODE_INJECTION);
}

function stripAnsi(text) {
  return String(text).replace(ANSI_RE, "");
}

function fitAnsi(text, width, pad = true) {
  const plain = stripAnsi(text);
  if (plain.length <= width) return text + (pad ? " ".repeat(width - plain.length) : "");
  const suffix = pad ? " " : "";
  return plain.slice(0, Math.max(0, width - suffix.length)) + suffix;
}

function batteryCommand(args, activeProvider, maxWidth) {
  const command = [
    process.execPath,
    BATTERY_BIN,
    "--muted",
    "--bar-width",
    String(args.barWidth),
    "--max-width",
    String(maxWidth),
    "--left-padding",
    String(args.leftPadding)
  ];
  if (activeProvider === "codex" || activeProvider === "claude") {
    command.push("--active-provider", activeProvider);
  }
  if (args.provider !== "all") {
    command.push("--provider", args.provider);
  }
  return command;
}

function statusOutputText(stdout) {
  return String(stdout || "").replace(/[\r\n]+$/g, "");
}

function rowptyExePath() {
  const explicit = process.env.AI_BATTERY_ROWPTY || process.env.CLAUDEX_BATTERY_ROWPTY;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const candidates = [];
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "ai-battery", "bin", "rowpty.exe"));
  }
  candidates.push(path.join(PROJECT_ROOT, "..", "rowpty", "bin", "rowpty.exe"));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function quoteWindowsCommandLineArg(value) {
  const text = String(value ?? "");
  if (text.length && !/[ \t"]/.test(text)) return text;
  let quoted = "\"";
  let backslashes = 0;
  for (const ch of text) {
    if (ch === "\\") {
      backslashes += 1;
    } else if (ch === "\"") {
      quoted += "\\".repeat(backslashes * 2 + 1) + "\"";
      backslashes = 0;
    } else {
      quoted += "\\".repeat(backslashes) + ch;
      backslashes = 0;
    }
  }
  return quoted + "\\".repeat(backslashes * 2) + "\"";
}

function rowptyStatusCommand(args, activeProvider) {
  // rowpty substitutes {MAXWIDTH} with (cols - 4) before each status run.
  return batteryCommand(args, activeProvider, "{MAXWIDTH}")
    .map(quoteWindowsCommandLineArg)
    .join(" ");
}

function rowptyConptyMode() {
  // Default "auto": rowpty loads the bundled Windows Terminal conpty.dll when
  // it sits next to rowpty.exe. The OS in-box ConPTY re-renders Codex's
  // scroll-region history insertion as viewport repaints (ghost frames,
  // reordered text), so it is opt-in via AI_BATTERY_ROWPTY_CONPTY=os only.
  // The bundled provider's 3s DA1 startup stall is answered by rowpty itself.
  const raw = process.env.AI_BATTERY_ROWPTY_CONPTY ?? process.env.CLAUDEX_BATTERY_ROWPTY_CONPTY ?? "auto";
  const mode = String(raw).toLowerCase();
  if (["bundled", "node-pty", "nodepty"].includes(mode)) return "bundled";
  if (["os", "inbox", "system"].includes(mode)) return "os";
  return "auto";
}

function rowptyPreserveScrollback() {
  const raw = process.env.AI_BATTERY_ROWPTY_PRESERVE_SCROLLBACK
    ?? process.env.CLAUDEX_BATTERY_ROWPTY_PRESERVE_SCROLLBACK
    ?? process.env.ROWPTY_PRESERVE_SCROLLBACK
    ?? "1";
  const value = String(raw).trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

function rowptyFilterAltScreen() {
  const raw = process.env.AI_BATTERY_ROWPTY_FILTER_ALT_SCREEN
    ?? process.env.CLAUDEX_BATTERY_ROWPTY_FILTER_ALT_SCREEN
    ?? process.env.ROWPTY_FILTER_ALT_SCREEN
    ?? "0";
  const value = String(raw).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function rowptySpawnEnv() {
  const env = { ...process.env };
  const explicitMode = process.env.AI_BATTERY_ROWPTY_CONPTY !== undefined ||
    process.env.CLAUDEX_BATTERY_ROWPTY_CONPTY !== undefined;
  const mode = rowptyConptyMode();
  if (mode === "bundled" || (mode === "auto" && explicitMode)) {
    delete env.ROWPTY_NO_CONPTY_DLL;
  } else if (mode === "os" && (explicitMode || (!env.ROWPTY_NO_CONPTY_DLL && !env.ROWPTY_CONPTY_DLL))) {
    env.ROWPTY_NO_CONPTY_DLL = "1";
  }
  env.ROWPTY_PRESERVE_SCROLLBACK = rowptyPreserveScrollback() ? "1" : "0";
  env.ROWPTY_FILTER_ALT_SCREEN = rowptyFilterAltScreen() ? "1" : "0";
  return env;
}

function runRowPty(args, activeProvider) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(null);
  const exe = rowptyExePath();
  if (!exe) {
    debugLog("rowpty:missing");
    return Promise.resolve(null);
  }

  const command = windowsCommand(args.command);
  const hostArgs = [
    "--interval", String(Math.max(0.5, args.interval)),
    "--reserve", "1",
    "--status-cmd", rowptyStatusCommand(args, activeProvider),
    "--", command.file, ...command.args
  ];
  const env = rowptySpawnEnv();
  debugLog("rowpty:start", { exe, hostArgs, size: termSize(), conptyMode: rowptyConptyMode() });
  const child = spawn(exe, hostArgs, {
    stdio: "inherit",
    cwd: process.cwd(),
    env,
    windowsHide: false
  });

  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      debugLog("rowpty:exit", { code, signal });
      resolve(code ?? (signal ? 1 : 0));
    });
    child.on("error", (error) => {
      debugLog("rowpty:error", { error: error.message });
      resolve(null);
    });
  });
}

function conPtyBackspaceMode() {
  // Windows Terminal sends 0x7f for Backspace and 0x08 for Ctrl+Backspace.
  // Rewriting DEL to BS makes TUIs (Codex, Claude Code) treat every
  // Backspace as delete-word, so keys pass through untouched by default.
  const mode = String(process.env.AI_BATTERY_CONPTY_BACKSPACE || process.env.CLAUDEX_BATTERY_CONPTY_BACKSPACE || "passthrough").toLowerCase();
  return ["bs", "del", "passthrough"].includes(mode) ? mode : "passthrough";
}

function normalizeConPtyInput(data, mode = conPtyBackspaceMode()) {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data || "");
  if (mode === "passthrough" || mode === "del") return text;
  return text.replace(/\x7f/g, "\x08");
}

function conPtyRepaintIntervalMs() {
  const raw = Number(process.env.AI_BATTERY_CONPTY_REPAINT_MS || process.env.CLAUDEX_BATTERY_CONPTY_REPAINT_MS);
  if (Number.isFinite(raw)) return Math.max(250, Math.min(5000, Math.floor(raw)));
  return 1000;
}

function statusCommandTimeoutMs() {
  const raw = Number(process.env.AI_BATTERY_STATUS_TIMEOUT_MS || process.env.CLAUDEX_BATTERY_STATUS_TIMEOUT_MS);
  if (Number.isFinite(raw)) return Math.max(1000, Math.min(15000, Math.floor(raw)));
  return 5000;
}

function outputMayClearDisplay(data) {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data || "");
  return /\x1bc|\x1b\[[0-?]*[23]J|\x1b\[\?1049[hl]/.test(text);
}

function scheduleRepaintBurst(status, timers) {
  for (const delayMs of [0, 80, 250, 700, 1400]) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      status.paint(true);
    }, delayMs);
    timers.add(timer);
  }
}

class StatusLine {
  constructor(args, activeProvider, options = {}) {
    this.args = args;
    this.activeProvider = activeProvider;
    this.bottomOffset = options.bottomOffset ?? 0;
    this.text = "";
    this.nextFetch = 0;
    this.lastLine = "";
    this.lastRow = null;
    this.lastDraw = 0;
    this.refreshInFlight = false;
    this.refreshQueued = false;
    this.disposed = false;
    this.onRefresh = null;
    this.resize();
  }

  resize(clearStale = false) {
    const previousRow = this.lastRow;
    const size = termSize();
    this.cols = size.cols;
    this.rows = size.rows;
    const nextRow = statusRow(this.rows, this.bottomOffset);
    if (clearStale && previousRow && previousRow !== nextRow && previousRow <= this.rows) {
      this.writeRow(previousRow, "\x1b[0m\r\x1b[1G\x1b[2K\x1b[0m");
      this.lastLine = "";
      this.lastRow = null;
    }
  }

  kickRefresh(force = false) {
    if (this.disposed) return;
    const now = Date.now();
    if (!force && now < this.nextFetch) return;
    if (this.refreshInFlight) {
      this.refreshQueued = this.refreshQueued || force;
      return;
    }

    this.refreshInFlight = true;
    this.nextFetch = now + (this.args.interval * 1000);
    const maxWidth = Math.max(20, this.cols - columnGuard());
    const command = batteryCommand(this.args, this.activeProvider, maxWidth);
    const child = spawn(command[0], command.slice(1), {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });

    let stdout = "";
    const timeout = setTimeout(() => child.kill(), statusCommandTimeoutMs());
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024) child.kill();
    });

    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      this.refreshInFlight = false;
      if (this.disposed) return;
      const text = statusOutputText(stdout);
      const changed = status === 0 && text && text !== this.text;
      if (changed) {
        this.text = text;
        if (typeof this.onRefresh === "function") {
          this.onRefresh();
        } else {
          this.paint(true);
        }
      }
      if (this.refreshQueued) {
        this.refreshQueued = false;
        this.kickRefresh(true);
      }
    };

    child.on("close", finish);
    child.on("error", () => finish(1));
  }

  paint(force = false) {
    if (this.disposed) return;
    if (!this.text) return;
    this.resize(true);
    const now = Date.now();
    if (!force && now - this.lastDraw < 150) return;
    const width = Math.max(1, this.cols - 1);
    const row = statusRow(this.rows, this.bottomOffset);
    const line = fitAnsi(this.text, width, true);
    if (!force && line === this.lastLine && row === this.lastRow) return;
    this.lastLine = line;
    this.lastRow = row;
    this.lastDraw = now;
    this.writeRow(row, `\x1b[0m\r\x1b[1G${line}\x1b[K\x1b[0m`);
  }

  writeRow(row, payload) {
    const target = Math.max(1, Math.min(Math.max(1, this.rows), Math.floor(Number(row) || 1)));
    process.stdout.write(`\x1b7\x1b[${target};1H${payload}\x1b8`);
  }

  draw(force = false) {
    this.kickRefresh(force);
    this.paint(force);
  }

  dispose() {
    this.disposed = true;
  }

  clear() {
    this.dispose();
    const row = statusRow(this.rows, this.bottomOffset);
    this.writeRow(row, "\x1b[0m\r\x1b[1G\x1b[2K");
    if (this.lastRow && this.lastRow !== row && this.lastRow <= this.rows) {
      this.writeRow(this.lastRow, "\x1b[0m\r\x1b[1G\x1b[2K");
    }
  }
}

function normalizeWindowsCommandPath(value) {
  let text = String(value || "").trim();
  for (let i = 0; i < 6; i += 1) {
    const before = text;
    text = text.replace(/\\"/g, "\"").trim();
    if (
      (text.startsWith("\"") && text.endsWith("\""))
      || (text.startsWith("'") && text.endsWith("'"))
    ) {
      text = text.slice(1, -1).trim();
    }
    if (text === before) break;
  }
  return text;
}

function resolveWindowsCommandFile(commandPath) {
  commandPath = normalizeWindowsCommandPath(commandPath);
  if (path.extname(commandPath)) return commandPath;
  for (const suffix of [".cmd", ".exe", ".bat", ".ps1"]) {
    const candidate = `${commandPath}${suffix}`;
    if (fs.existsSync(candidate)) return candidate;
  }
  return commandPath;
}

function resolveNpmCmdShim(commandPath) {
  if (!/\.cmd$/i.test(commandPath)) return null;
  let source;
  try {
    source = fs.readFileSync(commandPath, "utf8");
  } catch {
    return null;
  }
  if (!source.includes("%dp0%") || !source.includes("%*")) return null;
  const match = source.match(/%dp0%[\\/]([^"\r\n]+?\.(?:cjs|mjs|js))"?\s+%\*/i);
  if (!match) return null;
  const scriptPath = path.resolve(path.dirname(commandPath), match[1].replace(/[\\/]+/g, path.sep));
  if (!fs.existsSync(scriptPath)) return null;
  const localNode = path.join(path.dirname(commandPath), "node.exe");
  return {
    file: fs.existsSync(localNode) ? localNode : process.execPath,
    scriptPath
  };
}

function assertSafeCmdArguments(commandPath, args) {
  const unsafePath = UNSAFE_CMD_PATH_RE.test(String(commandPath));
  const unsafeArgument = args.find((value) => UNSAFE_CMD_ARGUMENT_RE.test(String(value)));
  if (!unsafePath && unsafeArgument === undefined) return;
  throw new Error(
    `Cannot safely pass shell metacharacters through legacy batch command ${commandPath}. `
    + "Use an .exe/.js entrypoint or an npm-generated .cmd shim instead."
  );
}

function windowsCommand(command) {
  const exe = resolveWindowsCommandFile(command[0]);
  const rest = command.slice(1);
  if (/\.(cmd|bat)$/i.test(exe)) {
    const npmShim = resolveNpmCmdShim(exe);
    if (npmShim) {
      return {
        file: npmShim.file,
        args: [npmShim.scriptPath, ...rest]
      };
    }
    assertSafeCmdArguments(exe, rest);
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", "call", exe, ...rest]
    };
  }
  if (/\.ps1$/i.test(exe)) {
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", exe, ...rest]
    };
  }
  if (/\.(js|mjs|cjs)$/i.test(exe)) {
    return {
      file: process.execPath,
      args: [exe, ...rest]
    };
  }
  return { file: exe, args: rest };
}

function codexNoAltScreenEnabled() {
  const raw = process.env.AI_BATTERY_CODEX_NO_ALT_SCREEN
    ?? process.env.CLAUDEX_BATTERY_CODEX_NO_ALT_SCREEN
    ?? "1";
  return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase());
}

function commandArgsLookLikeCodex(command) {
  const exe = resolveWindowsCommandFile(command[0] || "");
  const base = path.basename(exe).toLowerCase();
  return ["codex", "codex.cmd", "codex.exe"].includes(base);
}

function withCodexNoAltScreen(command, activeProvider) {
  if (activeProvider !== "codex") return command;
  if (!codexNoAltScreenEnabled()) return command;
  if (!commandArgsLookLikeCodex(command)) return command;
  if (command.some((arg) => String(arg).toLowerCase() === "--no-alt-screen")) return command;
  return [command[0], "--no-alt-screen", ...command.slice(1)];
}

async function loadNodePty() {
  try {
    const mod = await import("node-pty");
    debugLog("node-pty:loaded");
    return mod.default ?? mod;
  } catch (error) {
    debugLog("node-pty:missing", { error: error.message });
    return null;
  }
}

function compositorFrameIntervalMs() {
  const raw = Number(process.env.AI_BATTERY_COMPOSITOR_FRAME_MS || process.env.CLAUDEX_BATTERY_COMPOSITOR_FRAME_MS);
  if (Number.isFinite(raw)) return Math.max(0, Math.min(250, Math.floor(raw)));
  return 16;
}

function compositorUsesBundledConpty() {
  return rowptyConptyMode() !== "os";
}

function windowsBuildNumber(release = os.release()) {
  const parts = String(release || "").split(".");
  const parsed = Number(parts.at(-1));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 21376;
}

function compositorWindowsPty(release = os.release()) {
  return {
    backend: "conpty",
    // node-pty's bundled provider uses passthrough VT behavior independent of
    // the Windows build number reported by the host OS.
    buildNumber: compositorUsesBundledConpty() ? 21376 : windowsBuildNumber(release)
  };
}

async function runFullscreenCompositor(args, activeProvider) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    debugLog("fullscreen:unavailable", {
      reason: "stdin/stdout is not a TTY",
      stdinTty: Boolean(process.stdin.isTTY),
      stdoutTty: Boolean(process.stdout.isTTY)
    });
    return null;
  }

  const pty = await loadNodePty();
  if (!pty) {
    debugLog("fullscreen:unavailable", { reason: "node-pty is not installed" });
    return null;
  }

  const size = termSize();
  const childRows = Math.max(1, size.rows - 1);
  const command = windowsCommand(args.command);
  const status = new StatusLine(args, activeProvider);
  let term;
  let compositor;
  const pendingReplies = [];

  try {
    compositor = new HeadlessTerminalCompositor({
      columns: size.cols,
      rows: size.rows,
      frameIntervalMs: compositorFrameIntervalMs(),
      windowsMode: false,
      windowsPty: compositorWindowsPty(),
      onReply: (data) => {
        if (term) term.write(data);
        else pendingReplies.push(data);
      },
      onTitle: (title) => {
        const safeTitle = String(title || "").replace(/[\x00-\x1f\x7f]/g, " ");
        if (safeTitle) compositor.emitHost(`\x1b]0;${safeTitle}\x07`);
      }
    });

    term = pty.spawn(command.file, command.args, {
      name: "xterm-256color",
      cols: size.cols,
      rows: childRows,
      cwd: process.cwd(),
      env: {
        ...process.env,
        TERM: process.env.TERM || "xterm-256color",
        COLORTERM: process.env.COLORTERM || "truecolor"
      },
      encoding: null,
      useConpty: true,
      useConptyDll: compositorUsesBundledConpty(),
      conptyInheritCursor: false
    });
  } catch (error) {
    await compositor?.dispose?.().catch(() => {});
    debugLog("fullscreen:error", { stage: "spawn", error: error.message, command });
    return null;
  }

  let pendingOutputBytes = 0;
  let outputGeneration = 0;
  let outputPaused = false;
  let outputTail = Promise.resolve();
  const resumeOutput = () => {
    if (!outputPaused || pendingOutputBytes > RESUME_COMPOSITOR_OUTPUT_BYTES) return;
    outputPaused = false;
    try {
      term.resume?.();
    } catch (error) {
      debugLog("fullscreen:error", { stage: "output-resume", error: error.message });
    }
  };
  const outputDisposable = term.onData((data) => {
    const bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
    pendingOutputBytes += bytes;
    outputGeneration += 1;
    if (!outputPaused && pendingOutputBytes >= MAX_COMPOSITOR_PENDING_OUTPUT_BYTES) {
      try {
        term.pause?.();
        outputPaused = true;
        debugLog("fullscreen:output-pause", { pendingOutputBytes });
      } catch (error) {
        debugLog("fullscreen:error", { stage: "output-pause", error: error.message });
      }
    }
    outputTail = outputTail
      .then(() => compositor.write(data))
      .catch((error) => debugLog("fullscreen:error", { stage: "parse", error: error.message }))
      .finally(() => {
        pendingOutputBytes = Math.max(0, pendingOutputBytes - bytes);
        resumeOutput();
      });
  });

  const waitForOutputDrain = async () => {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const generation = outputGeneration;
      await outputTail;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (pendingOutputBytes === 0 && generation === outputGeneration) return;
    }
    debugLog("fullscreen:error", {
      stage: "output-drain-timeout",
      pendingOutputBytes,
      outputGeneration
    });
  };

  let settleExit;
  const exitResult = new Promise((resolve) => {
    let settled = false;
    settleExit = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
  });
  const exitDisposable = term.onExit(({ exitCode, signal }) => {
    debugLog("fullscreen:exit", { exitCode, signal });
    settleExit({ exitCode, signal });
  });
  for (const reply of pendingReplies.splice(0)) term.write(reply);

  debugLog("fullscreen:start", {
    size,
    childRows,
    command,
    conptyMode: rowptyConptyMode(),
    bundled: compositorUsesBundledConpty(),
    frameIntervalMs: compositorFrameIntervalMs()
  });

  const oldRaw = process.stdin.isRaw;
  const stdinWasPaused = process.stdin.isPaused?.() ?? false;
  const onInput = (data) => compositor.input(data);
  let refreshTimer = null;
  let resizePollTimer = null;
  let lastSize = size;
  const onResize = () => {
    try {
      const next = termSize();
      if (next.cols === lastSize.cols && next.rows === lastSize.rows) return;
      lastSize = next;
      const nextChildRows = Math.max(1, next.rows - 1);
      debugLog("fullscreen:resize", { size: next, childRows: nextChildRows });
      compositor.resize(next.cols, next.rows).catch((error) => {
        debugLog("fullscreen:error", { stage: "screen-resize", error: error.message });
      });
      term.resize(next.cols, nextChildRows);
      status.resize();
      status.kickRefresh(true);
    } catch (error) {
      debugLog("fullscreen:error", { stage: "resize", error: error.message });
    }
  };

  const emergencyRestore = () => {
    try {
      fs.writeSync(process.stdout.fd, HOST_RESTORE_SEQUENCE);
    } catch {}
  };
  process.once("exit", emergencyRestore);

  const terminationHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
    const handler = () => {
      debugLog("fullscreen:signal", { signal });
      try {
        term.kill?.();
      } catch {}
      setTimeout(() => settleExit({ exitCode: null, signal }), 100);
    };
    try {
      process.once(signal, handler);
      terminationHandlers.set(signal, handler);
    } catch {}
  }

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (refreshTimer) clearInterval(refreshTimer);
    if (resizePollTimer) clearInterval(resizePollTimer);
    process.stdout.off("resize", onResize);
    process.stdin.off("data", onInput);
    process.stdin.setRawMode?.(oldRaw);
    if (stdinWasPaused) process.stdin.pause();
    status.dispose();
    await waitForOutputDrain();
    outputDisposable?.dispose?.();
    exitDisposable?.dispose?.();
    for (const [signal, handler] of terminationHandlers) process.off(signal, handler);
    try {
      await compositor.dispose();
    } catch (error) {
      emergencyRestore();
      throw error;
    } finally {
      process.off("exit", emergencyRestore);
    }
  };

  let childResult = { exitCode: 1, signal: null };
  try {
    compositor.start();
    await compositor.setStatusText("AI Battery starting...");
    status.onRefresh = () => compositor.setStatusText(status.text);
    status.kickRefresh(true);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", onInput);
    refreshTimer = setInterval(
      () => status.kickRefresh(false),
      Math.max(500, Math.floor(args.interval * 1000))
    );
    process.stdout.on("resize", onResize);
    resizePollTimer = setInterval(onResize, 200);
    childResult = await exitResult;
    await waitForOutputDrain();
  } catch (error) {
    debugLog("fullscreen:error", { stage: "run", error: error.message });
    try {
      term.kill?.();
    } catch {}
  } finally {
    await cleanup();
  }

  const { exitCode, signal } = childResult;
  return exitCode ?? (signal ? 1 : 0);
}

function nativeFullscreenHudEnabled() {
  const raw = process.env.AI_BATTERY_FULLSCREEN_HUD
    ?? process.env.CLAUDEX_BATTERY_FULLSCREEN_HUD
    ?? "1";
  return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase());
}

function windowsDockPosition() {
  const raw = process.env.AI_BATTERY_WIN_DOCK_POSITION
    ?? process.env.CLAUDEX_BATTERY_WIN_DOCK_POSITION
    ?? "bottom";
  return ["tabs", "tab", "top"].includes(String(raw).trim().toLowerCase())
    ? "tabs"
    : "bottom";
}

function runNativeFullscreen(args) {
  const hudEnabled = nativeFullscreenHudEnabled();
  if (hudEnabled) ensureDockedHud();
  const command = windowsCommand(args.command);
  const env = {
    ...process.env,
    AI_BATTERY_ACTIVE_LAYOUT: "fullscreen"
  };
  debugLog("native-fullscreen:start", { command, hud: nativeFullscreenHudEnabled() });
  const child = spawn(command.file, command.args, {
    stdio: "inherit",
    cwd: process.cwd(),
    env,
    windowsHide: false
  });
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      debugLog("native-fullscreen:exit", { code, signal });
      resolve(code ?? (signal ? 1 : 0));
    });
    child.on("error", (error) => {
      debugLog("native-fullscreen:error", { error: error.message });
      resolve(1);
    });
  });
}

async function runConPty(args, activeProvider) {
  // Nested ConPTY (node-pty) breaks host-terminal scrollback and can stall
  // child output until the next keypress, so it is opt-in via --layout reserve.
  if (args.layout !== "reserve") {
    debugLog("conpty:skipped", { reason: `layout ${args.layout}` });
    return null;
  }

  const pty = await loadNodePty();
  if (!pty || !process.stdin.isTTY || !process.stdout.isTTY) {
    debugLog("conpty:unavailable", {
      hasPty: Boolean(pty),
      stdinTty: Boolean(process.stdin.isTTY),
      stdoutTty: Boolean(process.stdout.isTTY)
    });
    if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
    console.error("ai-battery-run-win: ConPTY reserve layout is unavailable in this terminal.");
    return 2;
  }

  const status = new StatusLine(args, activeProvider);
  const size = termSize();
  const childRows = Math.max(1, size.rows - 1);
  const command = windowsCommand(args.command);
  debugLog("conpty:start", {
    size,
    childRows,
    command,
    stdoutColumns: process.stdout.columns,
    stdoutRows: process.stdout.rows,
    windowSize: process.stdout.getWindowSize?.() || null,
    wtSession: Boolean(process.env.WT_SESSION)
  });
  const term = pty.spawn(command.file, command.args, {
    name: "xterm-256color",
    cols: size.cols,
    rows: childRows,
    cwd: process.cwd(),
    env: process.env
  });

  const oldRaw = process.stdin.isRaw;
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  const onInput = (data) => term.write(normalizeConPtyInput(data));
  process.stdin.on("data", onInput);

  let drawTimer = null;
  let drawForce = false;
  const scheduleDraw = (force = false, delayMs = 45) => {
    drawForce = drawForce || force;
    if (drawTimer) return;
    drawTimer = setTimeout(() => {
      drawTimer = null;
      const forceNow = drawForce;
      drawForce = false;
      status.draw(forceNow);
    }, delayMs);
  };
  status.onRefresh = () => scheduleDraw(true, 45);

  const timers = new Set();
  const timer = setInterval(() => scheduleDraw(false), Math.max(500, args.interval * 1000));
  const repaintTimer = setInterval(() => status.paint(true), conPtyRepaintIntervalMs());
  const onResize = () => {
    status.resize(true);
    term.resize(status.cols, Math.max(1, status.rows - 1));
    scheduleDraw(true, 0);
    scheduleRepaintBurst(status, timers);
  };
  process.stdout.on("resize", onResize);

  const clearConPtyTimers = () => {
    clearInterval(timer);
    clearInterval(repaintTimer);
    if (drawTimer) clearTimeout(drawTimer);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };

  return await new Promise((resolve) => {
    term.onData((data) => {
      process.stdout.write(data);
      if (outputMayClearDisplay(data)) scheduleRepaintBurst(status, timers);
      scheduleDraw(false);
    });
    term.onExit(({ exitCode }) => {
      debugLog("conpty:exit", { exitCode });
      clearConPtyTimers();
      process.stdout.off("resize", onResize);
      process.stdin.off("data", onInput);
      process.stdin.setRawMode?.(oldRaw);
      status.clear();
      resolve(exitCode ?? 0);
    });
    scheduleDraw(true, 0);
    scheduleRepaintBurst(status, timers);
  });
}

function overlayInitialDelayMs() {
  const raw = Number(process.env.AI_BATTERY_OVERLAY_INITIAL_DELAY_MS || process.env.CLAUDEX_BATTERY_OVERLAY_INITIAL_DELAY_MS);
  if (Number.isFinite(raw)) return Math.max(0, Math.min(5000, Math.floor(raw)));
  return 1200;
}

function overlayRepaintIntervalMs() {
  const raw = Number(process.env.AI_BATTERY_OVERLAY_REPAINT_MS || process.env.CLAUDEX_BATTERY_OVERLAY_REPAINT_MS);
  if (Number.isFinite(raw)) return Math.max(250, Math.min(5000, Math.floor(raw)));
  return 1000;
}

function scheduleOverlayRepaintBurst(status, timers) {
  scheduleRepaintBurst(status, timers);
}

function runOverlay(args, activeProvider, options = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    debugLog("overlay:unavailable", {
      stdinTty: Boolean(process.stdin.isTTY),
      stdoutTty: Boolean(process.stdout.isTTY)
    });
    console.error("ai-battery-run-win: stdin/stdout is not a real terminal.");
    return 2;
  }

  const status = new StatusLine(args, activeProvider, {
    bottomOffset: overlayBottomOffset(activeProvider)
  });
  const launchCommand = options.codexNoAltScreen
    ? withCodexNoAltScreen(args.command, activeProvider)
    : args.command;
  const aggressiveRepaint = options.aggressiveRepaint ?? true;
  const command = windowsCommand(launchCommand);
  debugLog("overlay:start", {
    size: termSize(),
    command,
    codexNoAltScreen: launchCommand !== args.command,
    aggressiveRepaint,
    bottomOffset: status.bottomOffset,
    initialDelayMs: overlayInitialDelayMs(),
    stdoutColumns: process.stdout.columns,
    stdoutRows: process.stdout.rows,
    windowSize: process.stdout.getWindowSize?.() || null,
    wtSession: Boolean(process.env.WT_SESSION)
  });
  const child = spawn(command.file, command.args, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
    windowsHide: false
  });

  const timers = new Set();
  const refreshTimer = setInterval(() => status.draw(false), Math.max(1000, args.interval * 1000));
  const repaintTimer = aggressiveRepaint
    ? setInterval(() => status.paint(true), overlayRepaintIntervalMs())
    : null;
  const onResize = () => {
    status.resize(true);
    status.draw(true);
    if (aggressiveRepaint) scheduleOverlayRepaintBurst(status, timers);
  };
  process.stdout.on("resize", onResize);
  const firstDraw = setTimeout(() => {
    status.draw(true);
    if (aggressiveRepaint) scheduleOverlayRepaintBurst(status, timers);
  }, overlayInitialDelayMs());
  timers.add(firstDraw);

  const clearOverlayTimers = () => {
    clearInterval(refreshTimer);
    if (repaintTimer) clearInterval(repaintTimer);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };

  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      debugLog("overlay:exit", { code, signal });
      clearOverlayTimers();
      process.stdout.off("resize", onResize);
      status.clear();
      resolve(code ?? (signal ? 1 : 0));
    });
    child.on("error", (error) => {
      debugLog("overlay:error", { error: error.message });
      clearOverlayTimers();
      process.stdout.off("resize", onResize);
      status.clear();
      console.error(`ai-battery-run-win: ${error.message}`);
      resolve(1);
    });
  });
}

function ensureDockedHud() {
  // Fire-and-forget: codex startup must not wait for the HUD. The launcher
  // resolves the terminal window while still attached to this console, then
  // starts the HUD detached (or hands the dock target to a running one).
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    debugLog("hud:skip", { reason: "not a TTY" });
    return;
  }
  const hudBin = path.join(BIN_DIR, "ai-battery-hud.js");
  if (!fs.existsSync(hudBin)) {
    debugLog("hud:skip", { reason: "launcher missing", hudBin });
    return;
  }
  try {
    const dockPosition = windowsDockPosition();
    const child = spawn(process.execPath, [hudBin, "--dock-console", "--dock-position", dockPosition, "--dock-session", String(process.pid)], {
      stdio: "ignore",
      cwd: process.cwd(),
      env: {
        ...process.env,
        AI_BATTERY_HUD_NO_PREFETCH: "1"
      },
      windowsHide: false
    });
    child.on("error", (error) => debugLog("hud:error", { error: error.message }));
    child.unref();
    debugLog("hud:dock-launch", { position: dockPosition });
  } catch (error) {
    debugLog("hud:error", { error: error.message });
  }
}

function runPlain(args) {
  const command = windowsCommand(args.command);
  debugLog("plain:start", { command });
  const child = spawn(command.file, command.args, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
    windowsHide: false
  });

  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      debugLog("plain:exit", { code, signal });
      resolve(code ?? (signal ? 1 : 0));
    });
    child.on("error", (error) => {
      debugLog("plain:error", { error: error.message });
      console.error(`ai-battery-run-win: ${error.message}`);
      resolve(1);
    });
  });
}

async function main() {
  if (process.platform !== "win32") {
    console.error("ai-battery-run-win is only for native Windows.");
    process.exit(2);
  }

  const args = parseArgs(process.argv.slice(2));
  const commandProvider = inferProvider(args.command);
  if (args.provider === "auto") args.provider = commandProvider;
  const activeProvider = ["codex", "claude"].includes(commandProvider) ? commandProvider : null;
  debugLog("main:start", {
    argv: process.argv.slice(2),
    provider: args.provider,
    layout: args.layout,
    commandProvider,
    activeProvider,
    stdinTty: Boolean(process.stdin.isTTY),
    stdoutTty: Boolean(process.stdout.isTTY)
  });

  let exitCode = null;
  if (["fullscreen", "auto"].includes(args.layout)) {
    exitCode = await runNativeFullscreen(args);
  } else if (args.layout === "composite") {
    exitCode = await runFullscreenCompositor(args, activeProvider);
    if (exitCode === null) {
      console.error("ai-battery-run-win: experimental compositor unavailable; launching Codex directly.");
      exitCode = await runPlain(args);
    }
  } else if (args.layout === "inline") {
    exitCode = process.stdin.isTTY && process.stdout.isTTY
      ? await runOverlay(args, activeProvider, { codexNoAltScreen: true, aggressiveRepaint: false })
      : await runPlain(args);
  } else if (args.layout === "hud") {
    // The child owns the terminal untouched (no PTY in the middle, no row
    // painting); the battery HUD docks onto the terminal window instead.
    ensureDockedHud();
    exitCode = await runPlain(args);
  } else if (args.layout === "plain") {
    exitCode = await runPlain(args);
  } else {
    if (args.layout !== "overlay") {
      exitCode = await runRowPty(args, activeProvider);
      if (exitCode === null) exitCode = await runConPty(args, activeProvider);
    }
    if (exitCode === null) {
      exitCode = process.stdin.isTTY && process.stdout.isTTY
        ? await runOverlay(args, activeProvider)
        : await runPlain(args);
    }
  }
  process.exit(exitCode);
}

export {
  codexNoAltScreenEnabled,
  commandArgsLookLikeCodex,
  compositorFrameIntervalMs,
  compositorUsesBundledConpty,
  compositorWindowsPty,
  conPtyBackspaceMode,
  conPtyRepaintIntervalMs,
  isVsCodeTerminal,
  normalizeConPtyInput,
  outputMayClearDisplay,
  overlayBottomOffset,
  overlayRepaintIntervalMs,
  parseArgs,
  quoteWindowsCommandLineArg,
  resolveNpmCmdShim,
  resolveWindowsCommandFile,
  rowptyConptyMode,
  rowptyFilterAltScreen,
  rowptyExePath,
  rowptyPreserveScrollback,
  rowptySpawnEnv,
  rowptyStatusCommand,
  nativeFullscreenHudEnabled,
  main,
  runFullscreenCompositor,
  runNativeFullscreen,
  sameFilePath,
  statusRow,
  statusOutputText,
  withCodexNoAltScreen,
  windowsDockPosition,
  windowsCommand
};

function sameFilePath(leftPath, rightPath) {
  try {
    return fs.realpathSync(leftPath) === fs.realpathSync(rightPath);
  } catch {
    return path.resolve(leftPath) === path.resolve(rightPath);
  }
}

function isDirectRun() {
  return Boolean(process.argv[1]) && sameFilePath(fileURLToPath(import.meta.url), process.argv[1]);
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(`ai-battery-run-win: ${error.message}`);
    process.exit(1);
  });
}
