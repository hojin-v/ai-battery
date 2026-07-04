#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BATTERY_BIN = process.env.AI_BATTERY_BIN
  || process.env.CLAUDEX_BATTERY_BIN
  || path.join(SCRIPT_DIR, "ai-battery.js");
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const DEFAULT_COLUMN_GUARD = 4;
const DEFAULT_LEFT_PADDING = 2;

function usage() {
  console.log(`Usage: ai-battery-run-win [--interval SECONDS] [--bar-width N] [--provider auto|all|codex|claude] [--left-padding N] -- COMMAND [ARGS...]

Runs COMMAND and keeps AI Battery on the terminal bottom row.
On Windows, node-pty enables ConPTY row reservation when available; otherwise AI Battery falls back to a same-console overlay row.`);
}

function parseArgs(argv) {
  const args = {
    interval: Number(process.env.AI_BATTERY_INTERVAL || process.env.CLAUDEX_BATTERY_INTERVAL || 10),
    barWidth: process.env.AI_BATTERY_BAR_WIDTH || process.env.CLAUDEX_BATTERY_BAR_WIDTH || "10",
    provider: process.env.AI_BATTERY_PROVIDER || process.env.CLAUDEX_BATTERY_PROVIDER || "auto",
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
    } else if (arg === "--left-padding") {
      args.leftPadding = Math.max(0, Math.min(20, Number(argv[++i]) || args.leftPadding));
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
  return {
    cols: Math.max(20, process.stdout.columns || 80),
    rows: Math.max(1, process.stdout.rows || 24)
  };
}

function columnGuard() {
  const raw = process.env.AI_BATTERY_COLUMN_GUARD || process.env.CLAUDEX_BATTERY_COLUMN_GUARD;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(20, Math.floor(value))) : DEFAULT_COLUMN_GUARD;
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

class StatusLine {
  constructor(args, activeProvider) {
    this.args = args;
    this.activeProvider = activeProvider;
    this.text = "AI Battery starting...";
    this.nextFetch = 0;
    this.lastLine = "";
    this.lastDraw = 0;
    this.resize();
  }

  resize() {
    const size = termSize();
    this.cols = size.cols;
    this.rows = size.rows;
  }

  refresh(force = false) {
    const now = Date.now();
    if (!force && now < this.nextFetch) return;
    this.nextFetch = now + (this.args.interval * 1000);
    const maxWidth = Math.max(20, this.cols - columnGuard());
    const command = batteryCommand(this.args, this.activeProvider, maxWidth);
    const result = spawnSync(command[0], command.slice(1), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
      windowsHide: true
    });
    const text = result.stdout?.trim();
    if (result.status === 0 && text) this.text = text;
  }

  draw(force = false) {
    const now = Date.now();
    if (!force && now - this.lastDraw < 150) return;
    this.refresh(force);
    const width = Math.max(1, this.cols - 1);
    const line = fitAnsi(this.text, width, true);
    if (!force && line === this.lastLine) return;
    this.lastLine = line;
    this.lastDraw = now;
    process.stdout.write(`\x1b7\x1b[0m\x1b[${this.rows};1H\r\x1b[1G${line}\x1b[K\x1b[0m\x1b8`);
  }

  clear() {
    process.stdout.write(`\x1b7\x1b[0m\x1b[${this.rows};1H\r\x1b[1G\x1b[2K\x1b8`);
  }
}

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
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

function windowsCommand(command) {
  const exe = resolveWindowsCommandFile(command[0]);
  const rest = command.slice(1);
  if (/\.(cmd|bat)$/i.test(exe)) {
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", [exe, ...rest].map(quoteCmdArg).join(" ")]
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

async function loadNodePty() {
  try {
    const mod = await import("node-pty");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

async function runConPty(args, activeProvider) {
  const pty = await loadNodePty();
  if (!pty || !process.stdin.isTTY || !process.stdout.isTTY) return null;

  const status = new StatusLine(args, activeProvider);
  const size = termSize();
  const childRows = Math.max(1, size.rows - 1);
  const command = windowsCommand(args.command);
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
  const onInput = (data) => term.write(data.toString());
  process.stdin.on("data", onInput);

  const timer = setInterval(() => status.draw(false), Math.max(500, args.interval * 1000));
  const onResize = () => {
    status.resize();
    term.resize(status.cols, Math.max(1, status.rows - 1));
    status.draw(true);
  };
  process.stdout.on("resize", onResize);

  return await new Promise((resolve) => {
    term.onData((data) => {
      process.stdout.write(data);
      status.draw(false);
    });
    term.onExit(({ exitCode }) => {
      clearInterval(timer);
      process.stdout.off("resize", onResize);
      process.stdin.off("data", onInput);
      process.stdin.setRawMode?.(oldRaw);
      status.clear();
      resolve(exitCode ?? 0);
    });
    status.draw(true);
  });
}

function runOverlay(args, activeProvider) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("ai-battery-run-win: stdin/stdout is not a real terminal.");
    return 2;
  }

  const status = new StatusLine(args, activeProvider);
  const command = windowsCommand(args.command);
  const child = spawn(command.file, command.args, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
    windowsHide: false
  });

  const timer = setInterval(() => status.draw(true), Math.max(750, args.interval * 1000));
  const onResize = () => {
    status.resize();
    status.draw(true);
  };
  process.stdout.on("resize", onResize);
  status.draw(true);

  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      clearInterval(timer);
      process.stdout.off("resize", onResize);
      status.clear();
      resolve(code ?? (signal ? 1 : 0));
    });
    child.on("error", (error) => {
      clearInterval(timer);
      process.stdout.off("resize", onResize);
      status.clear();
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

  const ptyExit = await runConPty(args, activeProvider);
  const exitCode = ptyExit === null ? await runOverlay(args, activeProvider) : ptyExit;
  process.exit(exitCode);
}

export {
  resolveWindowsCommandFile,
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
