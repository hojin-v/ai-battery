import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let TerminalConstructor = null;

function loadHeadlessTerminal() {
  if (TerminalConstructor) return TerminalConstructor;
  const loaded = require("@xterm/headless");
  TerminalConstructor = loaded.Terminal;
  if (typeof TerminalConstructor !== "function") {
    throw new Error("@xterm/headless did not expose Terminal");
  }
  return TerminalConstructor;
}

const ESC = "\x1b";
const CSI = `${ESC}[`;
const DEFAULT_FRAME_INTERVAL_MS = 16;
const HOST_MOUSE_PRIVATE_MODES = [9, 1000, 1002, 1003, 1005, 1006, 1007, 1015, 1016];
const HOST_RESTORE_SEQUENCE =
  `${CSI}?2026h${CSI}0m${CSI}?25h${CSI}?7h${CSI}?1l${ESC}>`
  + `${CSI}?9001l${CSI}?1004l${HOST_MOUSE_PRIVATE_MODES.map((mode) => `${CSI}?${mode}l`).join("")}${CSI}?2004l`
  + `${CSI}?1049l${CSI}?2026l`;

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function paletteForegroundCode(index) {
  if (index < 8) return String(30 + index);
  if (index < 16) return String(90 + index - 8);
  return `38;5;${index}`;
}

function paletteBackgroundCode(index) {
  if (index < 8) return String(40 + index);
  if (index < 16) return String(100 + index - 8);
  return `48;5;${index}`;
}

function rgbCode(prefix, packed) {
  const red = (packed >> 16) & 0xff;
  const green = (packed >> 8) & 0xff;
  const blue = packed & 0xff;
  return `${prefix};2;${red};${green};${blue}`;
}

function cellStyleCodes(cell) {
  const codes = [];
  if (cell.isBold()) codes.push("1");
  if (cell.isDim()) codes.push("2");
  if (cell.isItalic()) codes.push("3");
  if (cell.isUnderline()) {
    const style = cell.getUnderlineStyle?.() || 1;
    codes.push(style > 1 ? `4:${style}` : "4");
  }
  if (cell.isBlink()) codes.push("5");
  if (cell.isInverse()) codes.push("7");
  if (cell.isInvisible()) codes.push("8");
  if (cell.isStrikethrough()) codes.push("9");
  if (cell.isOverline()) codes.push("53");

  if (cell.isFgRGB()) {
    codes.push(rgbCode("38", cell.getFgColor()));
  } else if (cell.isFgPalette()) {
    codes.push(paletteForegroundCode(cell.getFgColor()));
  }

  if (cell.isBgRGB()) {
    codes.push(rgbCode("48", cell.getBgColor()));
  } else if (cell.isBgPalette()) {
    codes.push(paletteBackgroundCode(cell.getBgColor()));
  }

  if (cell.isUnderlineColorRGB?.()) {
    codes.push(rgbCode("58", cell.getUnderlineColor()));
  } else if (cell.isUnderlineColorPalette?.()) {
    codes.push(`58;5;${cell.getUnderlineColor()}`);
  }
  return codes;
}

function renderBufferLine(line, columns) {
  let output = "";
  let previousStyle = null;
  let renderedColumns = 0;

  for (let column = 0; column < columns; column += 1) {
    const cell = line?.getCell(column);
    if (!cell) {
      if (previousStyle !== "default") {
        output += `${CSI}0m`;
        previousStyle = "default";
      }
      output += " ";
      renderedColumns += 1;
      continue;
    }

    const width = cell.getWidth();
    if (width === 0) continue;

    const style = cellStyleCodes(cell).join(";");
    if (style !== previousStyle) {
      output += `${CSI}${style ? `0;${style}` : "0"}m`;
      previousStyle = style;
    }

    output += cell.getChars() || " ";
    renderedColumns += Math.max(1, width);
  }

  if (renderedColumns < columns) output += " ".repeat(columns - renderedColumns);
  return `${output}${CSI}0m`;
}

function modeSequence(parameter, enabled) {
  return `${CSI}?${parameter}${enabled ? "h" : "l"}`;
}

function terminalInputModeSnapshot(terminal, win32InputMode, mousePrivateModes = new Set()) {
  const modes = terminal.modes;
  return {
    applicationCursorKeysMode: Boolean(modes.applicationCursorKeysMode),
    applicationKeypadMode: Boolean(modes.applicationKeypadMode),
    bracketedPasteMode: Boolean(modes.bracketedPasteMode),
    mousePrivateModes: [...mousePrivateModes].sort((left, right) => left - right),
    sendFocusMode: Boolean(modes.sendFocusMode),
    win32InputMode: Boolean(win32InputMode)
  };
}

function inputModeSequence(previous, next) {
  let output = "";
  if (!previous || previous.applicationCursorKeysMode !== next.applicationCursorKeysMode) {
    output += modeSequence(1, next.applicationCursorKeysMode);
  }
  if (!previous || previous.applicationKeypadMode !== next.applicationKeypadMode) {
    output += next.applicationKeypadMode ? `${ESC}=` : `${ESC}>`;
  }
  if (!previous || previous.bracketedPasteMode !== next.bracketedPasteMode) {
    output += modeSequence(2004, next.bracketedPasteMode);
  }
  if (!previous || previous.sendFocusMode !== next.sendFocusMode) {
    output += modeSequence(1004, next.sendFocusMode);
  }
  const previousMouseModes = new Set(previous?.mousePrivateModes || []);
  const nextMouseModes = new Set(next.mousePrivateModes || []);
  for (const parameter of HOST_MOUSE_PRIVATE_MODES) {
    if (!previous || previousMouseModes.has(parameter) !== nextMouseModes.has(parameter)) {
      output += modeSequence(parameter, nextMouseModes.has(parameter));
    }
  }
  if (!previous || previous.win32InputMode !== next.win32InputMode) {
    output += modeSequence(9001, next.win32InputMode);
  }
  return output;
}

function makeTerminal(columns, rows, options = {}) {
  const Terminal = loadHeadlessTerminal();
  return new Terminal({
    allowProposedApi: true,
    cols: columns,
    rows,
    scrollback: options.scrollback ?? 10000,
    windowsMode: options.windowsMode ?? false,
    windowsPty: options.windowsPty,
    windowOptions: {
      getWinSizeChars: true,
      ...(options.windowOptions || {})
    }
  });
}

class HeadlessTerminalCompositor {
  constructor(options = {}) {
    this.columns = clampInteger(options.columns, 2, 1000, 80);
    this.rows = clampInteger(options.rows, 2, 1000, 24);
    this.childRows = Math.max(1, this.rows - 1);
    this.frameIntervalMs = clampInteger(options.frameIntervalMs, 0, 1000, DEFAULT_FRAME_INTERVAL_MS);
    const usesDefaultHost = typeof options.writeHost !== "function";
    this.usesDefaultHost = usesDefaultHost;
    this.writeHost = options.writeHost || ((data) => process.stdout.write(data));
    this.waitForHostDrain = options.waitForHostDrain || (usesDefaultHost
      ? () => new Promise((resolve) => {
        if (!process.stdout.writableNeedDrain) {
          resolve();
          return;
        }
        const finish = () => {
          clearTimeout(timeout);
          process.stdout.off("drain", finish);
          process.stdout.off("close", finish);
          process.stdout.off("error", finish);
          resolve();
        };
        const timeout = setTimeout(finish, 1000);
        process.stdout.once("drain", finish);
        process.stdout.once("close", finish);
        process.stdout.once("error", finish);
      })
      : () => Promise.resolve());
    this.onReply = options.onReply || null;
    this.onTitle = options.onTitle || null;
    this.terminalOptions = {
      scrollback: options.scrollback,
      windowsMode: options.windowsMode,
      windowsPty: options.windowsPty,
      windowOptions: options.windowOptions
    };
    this.terminal = makeTerminal(this.columns, this.childRows, this.terminalOptions);
    this.statusTerminal = makeTerminal(Math.max(1, this.columns - 1), 1, {
      scrollback: 0,
      windowsMode: false
    });
    this.statusText = "";
    this.win32InputMode = false;
    this.mousePrivateModes = new Set();
    this.cursorHidden = false;
    this.lastInputModes = null;
    this.lastRows = [];
    this.lastStatusRow = null;
    this.started = false;
    this.disposed = false;
    this.forceFullRender = true;
    this.renderTimer = null;
    this.renderInProgress = false;
    this.renderQueued = false;
    this.pendingWrites = 0;
    this.flushWaiters = [];
    this.statusWriteGeneration = 0;
    this.hostBackpressured = false;
    this.hostDrainPromise = null;
    this.pendingHostWrites = 0;
    this.hostWriteWaiters = [];
    this.disposables = [];
    this.registerTerminalHandlers();
  }

  registerTerminalHandlers() {
    this.disposables.push(this.terminal.onData((data) => {
      if (typeof this.onReply === "function") this.onReply(data);
    }));
    this.disposables.push(this.terminal.onBell(() => this.emitHost("\x07")));
    this.disposables.push(this.terminal.onTitleChange((title) => {
      if (typeof this.onTitle === "function") this.onTitle(title);
    }));
    this.disposables.push(this.terminal.onWriteParsed(() => this.scheduleRender()));

    for (const final of ["h", "l"]) {
      this.disposables.push(this.terminal.parser.registerCsiHandler(
        { prefix: "?", final },
        (parameters) => {
          if (parameters.includes(9001)) this.win32InputMode = final === "h";
          if (parameters.includes(25)) this.cursorHidden = final === "l";
          for (const parameter of HOST_MOUSE_PRIVATE_MODES) {
            if (!parameters.includes(parameter)) continue;
            if (final === "h") this.mousePrivateModes.add(parameter);
            else this.mousePrivateModes.delete(parameter);
          }
          this.scheduleRender(true);
          return false;
        }
      ));
    }

    this.disposables.push(this.terminal.parser.registerEscHandler(
      { final: "c" },
      () => {
        this.win32InputMode = false;
        this.mousePrivateModes.clear();
        this.cursorHidden = false;
        this.scheduleRender(true);
        return false;
      }
    ));
  }

  emitHost(data) {
    let accepted;
    if (this.usesDefaultHost) {
      this.pendingHostWrites += 1;
      accepted = process.stdout.write(data, () => {
        this.pendingHostWrites = Math.max(0, this.pendingHostWrites - 1);
        if (this.pendingHostWrites !== 0) return;
        for (const waiter of this.hostWriteWaiters.splice(0)) waiter();
      });
    } else {
      accepted = this.writeHost(data);
    }
    if (accepted !== false || this.hostBackpressured) return accepted;
    this.hostBackpressured = true;
    this.hostDrainPromise = Promise.resolve()
      .then(() => this.waitForHostDrain())
      .catch(() => {})
      .then(() => {
        const renderAfterDrain = this.renderQueued;
        this.renderQueued = false;
        this.hostBackpressured = false;
        this.hostDrainPromise = null;
        if (!this.disposed && renderAfterDrain) this.scheduleRender(false, 0);
      });
    return accepted;
  }

  async waitUntilHostWritable() {
    while (this.hostBackpressured && this.hostDrainPromise) await this.hostDrainPromise;
    if (this.pendingHostWrites > 0) {
      await new Promise((resolve) => this.hostWriteWaiters.push(resolve));
    }
  }

  start() {
    if (this.started || this.disposed) return;
    this.started = true;
    this.emitHost(`${CSI}?1049h${CSI}?2026h${CSI}?25l${CSI}?7l${CSI}2J${CSI}H${CSI}?2026l`);
    this.scheduleRender(true, 0);
  }

  write(data) {
    if (this.disposed) return Promise.resolve();
    this.pendingWrites += 1;
    return new Promise((resolve) => {
      this.terminal.write(data, () => {
        this.scheduleRender();
        resolve();
        this.completePendingWrite();
      });
    });
  }

  completePendingWrite() {
    this.pendingWrites = Math.max(0, this.pendingWrites - 1);
    if (this.pendingWrites !== 0) return;
    for (const waiter of this.flushWaiters.splice(0)) waiter();
  }

  input(data) {
    if (this.disposed || typeof this.onReply !== "function") return;
    this.onReply(data);
  }

  setStatusText(text) {
    if (this.disposed) return Promise.resolve();
    const next = String(text || "").replace(/[\r\n]+/g, " ");
    if (next === this.statusText) return Promise.resolve();
    this.statusText = next;
    const generation = ++this.statusWriteGeneration;
    this.statusTerminal.reset();
    this.pendingWrites += 1;
    return new Promise((resolve) => {
      this.statusTerminal.write(`${CSI}0m${CSI}2K\r${next}`, () => {
        if (generation === this.statusWriteGeneration) {
          this.lastStatusRow = null;
          this.scheduleRender(true);
        }
        resolve();
        this.completePendingWrite();
      });
    });
  }

  resize(columns, rows) {
    if (this.disposed) return Promise.resolve();
    this.columns = clampInteger(columns, 2, 1000, this.columns);
    this.rows = clampInteger(rows, 2, 1000, this.rows);
    this.childRows = Math.max(1, this.rows - 1);
    this.terminal.resize(this.columns, this.childRows);
    this.statusTerminal.resize(Math.max(1, this.columns - 1), 1);
    const status = this.statusText;
    this.statusWriteGeneration += 1;
    this.statusTerminal.reset();
    this.pendingWrites += 1;
    return new Promise((resolve) => {
      this.statusTerminal.write(`${CSI}0m${CSI}2K\r${status}`, () => {
        this.forceFullRender = true;
        this.lastRows = [];
        this.lastStatusRow = null;
        this.scheduleRender(true, 0);
        resolve();
        this.completePendingWrite();
      });
    });
  }

  scheduleRender(force = false, delay = this.frameIntervalMs) {
    if (this.disposed) return;
    this.forceFullRender = this.forceFullRender || force;
    if (this.terminal.modes.synchronizedOutputMode) return;
    if (this.hostBackpressured || this.renderInProgress) {
      this.renderQueued = true;
      return;
    }
    if (this.renderTimer !== null) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, Math.max(0, delay));
  }

  render(forceSynchronized = false) {
    if (this.disposed || !this.started || this.renderInProgress) return;
    if (this.terminal.modes.synchronizedOutputMode && !forceSynchronized) return;
    if (this.hostBackpressured) {
      this.renderQueued = true;
      return;
    }
    this.renderInProgress = true;
    try {
      const active = this.terminal.buffer.active;
      const nextRows = [];
      const changed = [];
      for (let row = 0; row < this.childRows; row += 1) {
        const line = active.getLine(active.viewportY + row);
        const rendered = renderBufferLine(line, this.columns);
        nextRows.push(rendered);
        if (this.forceFullRender || this.lastRows[row] !== rendered) {
          changed.push({ row: row + 1, rendered });
        }
      }

      const statusLine = this.statusTerminal.buffer.active.getLine(0);
      const renderedStatus = renderBufferLine(statusLine, Math.max(1, this.columns - 1));
      const statusChanged = this.forceFullRender || this.lastStatusRow !== renderedStatus;
      const nextInputModes = terminalInputModeSnapshot(this.terminal, this.win32InputMode, this.mousePrivateModes);
      const modes = inputModeSequence(this.lastInputModes, nextInputModes);

      let frame = `${CSI}?2026h${CSI}?25l${CSI}?7l${modes}`;
      if (this.forceFullRender) frame += `${CSI}2J`;
      for (const entry of changed) frame += `${CSI}${entry.row};1H${entry.rendered}`;
      if (statusChanged) frame += `${CSI}${this.rows};1H${renderedStatus}${CSI}K`;

      const cursorRow = Math.max(1, Math.min(this.childRows, active.cursorY + 1));
      const cursorColumn = Math.max(1, Math.min(this.columns, active.cursorX + 1));
      frame += `${CSI}0m${CSI}${cursorRow};${cursorColumn}H`;
      frame += this.cursorHidden ? `${CSI}?25l` : `${CSI}?25h`;
      frame += `${CSI}?2026l`;
      this.emitHost(frame);

      this.lastRows = nextRows;
      this.lastStatusRow = renderedStatus;
      this.lastInputModes = nextInputModes;
      this.forceFullRender = false;
    } finally {
      this.renderInProgress = false;
      if (this.renderQueued) {
        this.renderQueued = false;
        this.scheduleRender(false, 0);
      }
    }
  }

  async flush() {
    if (this.pendingWrites > 0) {
      await new Promise((resolve) => this.flushWaiters.push(resolve));
    }
    if (this.renderTimer !== null) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    await this.waitUntilHostWritable();
    this.forceFullRender = true;
    this.render(true);
    await this.waitUntilHostWritable();
  }

  snapshot() {
    const active = this.terminal.buffer.active;
    const lines = [];
    for (let row = 0; row < this.childRows; row += 1) {
      lines.push(active.getLine(active.viewportY + row)?.translateToString(true) || "");
    }
    return {
      columns: this.columns,
      rows: this.rows,
      childRows: this.childRows,
      bufferType: active.type,
      cursor: { x: active.cursorX, y: active.cursorY },
      lines,
      status: this.statusTerminal.buffer.active.getLine(0)?.translateToString(true) || "",
      modes: terminalInputModeSnapshot(this.terminal, this.win32InputMode, this.mousePrivateModes)
    };
  }

  async dispose() {
    if (this.disposed) return;
    await this.flush();
    this.disposed = true;
    if (this.renderTimer !== null) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    for (const disposable of this.disposables) disposable?.dispose?.();
    this.disposables = [];
    this.terminal.dispose();
    this.statusTerminal.dispose();
    if (this.started) {
      this.emitHost(HOST_RESTORE_SEQUENCE);
      await this.waitUntilHostWritable();
    }
  }
}

export {
  HeadlessTerminalCompositor,
  HOST_RESTORE_SEQUENCE,
  cellStyleCodes,
  inputModeSequence,
  renderBufferLine,
  terminalInputModeSnapshot
};
