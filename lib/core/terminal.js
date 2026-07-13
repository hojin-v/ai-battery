import { clamp } from "./limits.js";
import { isWsl } from "../platforms/runtime.js";

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
function colorize(text, color, style) {
  if (style === "plain") return text;
  if (style === "muted") {
    // Muted style dims the status text, but the battery bar keeps its
    // green/orange/red charge color so the level reads at a glance.
    const mutedColorCodes = {
      white: 97,
      green: 32,
      orange: "38;5;208",
      red: 31
    };
    const code = mutedColorCodes[color] ?? 90;
    return `\u001b[${code}m${text}\u001b[0m`;
  }
  const codes = {
    white: 37,
    green: 32,
    orange: "38;5;208",
    red: 31,
    gray: 90,
    cyan: 36
  };
  if (style === "tmux") {
    // All colors: fg only (no background). The user's status-bar background
    // is preserved; only the glyph/text color is changed.
    const tmuxFg = {
      green: "green", orange: "colour208", red: "red",
      white: "black",       // active provider text → black
      gray: "colour240",    // inactive provider → slightly darker gray than 244
      cyan: "cyan"
    };
    return `#[fg=${tmuxFg[color] || "default"}]${text}#[default]`;
  }
  return `\u001b[${codes[color] || 0}m${text}\u001b[0m`;
}

function remainingColor(percent) {
  if (percent <= 20) return "red";
  if (percent <= 40) return "orange";
  return "green";
}

function activityColor(data) {
  return data?.running ? "white" : "gray";
}

function statusColorize(data, text, args) {
  return colorize(text, activityColor(data), args.style);
}

// The colored bar uses one centered glyph for both filled and empty halves,
// separated only by color. It keeps the segmented shape while keeping the bar
// aligned with the text baseline across macOS Terminal, Windows Terminal, and
// WSL terminal fonts.
const BAR_GLYPH = "❚";
const WINDOWS_BAR_GLYPH = "❚";
// Plain (--no-color / non-TTY) has no color to tell the halves apart, so it
// falls back to a distinct empty glyph. This path is opt-in and not the TUI.
const BAR_EMPTY_PLAIN_GLYPH = "░";
// tmux status-right: ▮ (U+25AE) and ▯ (U+25AF) are the filled/outline pair
// from the same Geometric Shapes Unicode block, so they render at the same
// size and baseline across terminal fonts (no cross-block fallback mismatch).
// Colors are NOT applied: fg-only colors become invisible when they match the
// status-bar background (e.g. green bar fill on green status-bar bg).
const BAR_FILL_TMUX_GLYPH = "▮";
const BAR_EMPTY_TMUX_GLYPH = "▯";

function barGlyph() {
  const override = process.env.AI_BATTERY_BAR_GLYPH || process.env.CLAUDEX_BATTERY_BAR_GLYPH;
  if (override) return Array.from(override)[0];
  if (process.platform === "win32" || isWsl()) return WINDOWS_BAR_GLYPH;
  return BAR_GLYPH;
}

function bar(percent, width, chargeColor = "green", style) {
  if (typeof percent !== "number") return colorize("─".repeat(width), "gray", style);

  const exact = (clamp(percent, 0, 100) / 100) * width;
  let full = Math.round(exact);
  if (percent > 0 && full === 0) full = 1;
  if (full > width) full = width;

  const glyph = barGlyph();
  const empty = width - full;

  if (style === "plain") {
    return `${glyph.repeat(full)}${BAR_EMPTY_PLAIN_GLYPH.repeat(empty)}`;
  }
  if (style === "tmux") {
    // No color on either half: fg-only colors become invisible when they match
    // the status-bar background. Shape alone distinguishes fill from empty.
    return `${BAR_FILL_TMUX_GLYPH.repeat(full)}${BAR_EMPTY_TMUX_GLYPH.repeat(empty)}`;
  }
  const fill = glyph.repeat(full);
  const emptyStr = empty ? colorize(glyph.repeat(empty), "gray", style) : "";
  return `${colorize(fill, chargeColor, style)}${emptyStr}`;
}

function duration(seconds) {
  if (typeof seconds !== "number") return "?";
  if (seconds <= 0) return "now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 48) return restMinutes ? `${hours}h${restMinutes}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d${restHours}h` : `${days}d`;
}

function shortWindow(minutes) {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "7d";
  if (!minutes) return "?";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function resetClock(limit) {
  if (!limit?.resetsAt || limit.resetPassed) return "--:--";
  const date = new Date(limit.resetsAt);
  if (Number.isNaN(date.getTime())) return "--:--";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

const TMUX_FORMAT_RE = /#\[[^\]]*\]/g;

function stripAnsi(text) {
  return String(text).replace(ANSI_RE, "").replace(TMUX_FORMAT_RE, "");
}

function charWidth(char) {
  const code = char.codePointAt(0);
  if (
    (code >= 0x0300 && code <= 0x036f)
    || (code >= 0x1ab0 && code <= 0x1aff)
    || (code >= 0x1dc0 && code <= 0x1dff)
    || (code >= 0x20d0 && code <= 0x20ff)
    || (code >= 0xfe20 && code <= 0xfe2f)
  ) {
    return 0;
  }
  if (
    (code >= 0x1100 && code <= 0x115f)
    || code === 0x2329
    || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

function visibleWidth(text) {
  return Array.from(stripAnsi(text)).reduce((width, char) => width + charWidth(char), 0);
}

function takeVisibleStart(text, maxWidth) {
  let width = 0;
  let output = "";
  for (const char of Array.from(text)) {
    const nextWidth = width + charWidth(char);
    if (nextWidth > maxWidth) break;
    output += char;
    width = nextWidth;
  }
  return output;
}

function takeVisibleEnd(text, maxWidth) {
  let width = 0;
  let output = "";
  for (const char of Array.from(text).reverse()) {
    const nextWidth = width + charWidth(char);
    if (nextWidth > maxWidth) break;
    output = char + output;
    width = nextWidth;
  }
  return output;
}

function truncateMiddleVisible(text, maxWidth) {
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth <= 0) return "";
  if (maxWidth === 1) return "…";

  const marker = "…";
  const budget = maxWidth - visibleWidth(marker);
  const startWidth = Math.ceil(budget * 0.55);
  const endWidth = Math.max(0, budget - startWidth);
  return `${takeVisibleStart(text, startWidth)}${marker}${takeVisibleEnd(text, endWidth)}`;
}

function numericColumn(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const columns = Math.floor(number);
  if (columns < 20) return null;
  return clamp(columns, 20, 500);
}

function numericGuard(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return clamp(Math.floor(number), 0, 20);
}
export {
  activityColor,
  bar,
  charWidth,
  colorize,
  duration,
  numericColumn,
  numericGuard,
  remainingColor,
  resetClock,
  shortWindow,
  statusColorize,
  stripAnsi,
  takeVisibleEnd,
  takeVisibleStart,
  truncateMiddleVisible,
  visibleWidth
};