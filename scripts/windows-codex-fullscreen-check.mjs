import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Real Windows Codex and ConPTY, with an isolated CODEX_HOME and a loopback
// Responses fixture. No user login, production API or quota is needed.
if (process.platform !== "win32") {
  console.log("SKIP: actual Windows Codex fullscreen verification requires Windows.");
  process.exit(0);
}

if (process.argv.includes("--compare-installed") || process.argv.includes("--verify-matrix")) {
  const script = fileURLToPath(import.meta.url);
  const reportRoot = path.resolve(path.dirname(script), "..");
  const installedRunner = path.join(process.env.APPDATA, "npm/node_modules/ai-battery/bin/ai-battery-run-win.js");
  const modernIndex = process.argv.indexOf("--modern-node");
  const modern = modernIndex >= 0 ? process.argv[modernIndex + 1] : null;
  if (process.argv.includes("--verify-matrix") && !modern) throw new Error("--verify-matrix requires --modern-node <node.exe>");
  const variants = process.argv.includes("--verify-matrix") ? [
    ["legacy-managed-runtime", process.execPath, []],
    ["node24", modern, []],
    ["node24-installed", modern, ["--runner", installedRunner]]
  ] : [["check", process.execPath, []], ["installed", process.execPath, ["--runner", installedRunner]]];
  let failed = false;
  for (const [name, node, extra] of variants) {
    console.log("Checking " + name + " runner");
    const result = spawnSync(node, [script, ...extra, "--report", path.join(reportRoot, `codex-fullscreen-${name}-report.json`)], {
      stdio: "inherit", timeout: 120000
    });
    if (result.status !== 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const native = process.argv.includes("--native");
const expectPlain = process.argv.includes("--expect-plain");
const directScreen = native || expectPlain;
const runnerIndex = process.argv.indexOf("--runner");
const runner = runnerIndex >= 0 ? process.argv[runnerIndex + 1] : path.join(root, "bin/ai-battery-run-win.js");
const reportIndex = process.argv.indexOf("--report");
const reportPath = (reportIndex >= 0 ? process.argv[reportIndex + 1] : process.env.AI_BATTERY_FULLSCREEN_REPORT)
  || path.join(root, "codex-fullscreen-check-report.json");
const codex = process.env.AI_BATTERY_TEST_CODEX_JS || path.join(process.env.APPDATA, "npm/node_modules/@openai/codex/bin/codex.js");
// Codex's SQLite state requires a local Windows filesystem, not WSL's UNC share.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-fullscreen-"));
const codexHome = path.join(fixture, "codex-home");
const project = path.join(fixture, "project");
const debugPath = path.join(fixture, "debug.jsonl");
const inputPath = path.join(fixture, "input.jsonl");
const preloadPath = path.join(fixture, "input-observer.cjs");
const statusPath = path.join(fixture, "status.mjs");
const statusMarker = "AI_BATTERY_FULLSCREEN_STATUS";
const report = {
  ok: false, startedAt: new Date().toISOString(), completedAt: null,
  node: process.version, codexVersion: null, runner: native ? "native Codex (no wrapper)" : runner,
  checks: {}, requests: 0, httpRequests: [], fixtureErrors: [], screens: {}, failure: null
};
let term;
let terminal;
let exited = null;
let outputTail = Promise.resolve();
let rawOutput = "";
let server;
let lastScreen = [];
let statusWasVisible = false;
let maxStatusCopies = 0;
let bottomRowViolations = 0;
let hostWin32Input = false;
let closing = false;
let responseTurns = 0;
const prompts = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function snapshot() {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) || "");
}

function check(name, passed, detail = null) {
  report.checks[name] = { passed: Boolean(passed), detail };
  assert.ok(passed, name + (detail ? ": " + detail : ""));
  console.log("PASS: " + name);
}

async function waitFor(predicate, description, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await outputTail;
    lastScreen = snapshot();
    if (predicate(lastScreen, lastScreen.join("\n"))) return lastScreen;
    if (exited !== null) throw new Error(description + ": runner exited " + exited);
    await sleep(50);
  }
  throw new Error("Timeout: " + description);
}

async function type(text) {
  // Enter is separate: slash commands must not arrive as a paste plus newline.
  for (const character of text) {
    key(character);
    await sleep(20);
  }
  await sleep(250);
}

function key(character) {
  if (exited !== null || term?._agent?.inSocket?.destroyed) return;
  if (!hostWin32Input) return term.write(character);
  const code = character.codePointAt(0);
  const scanCodes = { q:16,w:17,e:18,r:19,t:20,y:21,u:22,i:23,o:24,p:25,a:30,s:31,d:32,f:33,g:34,h:35,j:36,k:37,l:38,z:44,x:45,c:46,v:47,b:48,n:49,m:50 };
  const punctuation = {
    " ":[32,57,0], "/":[191,53,0], "&":[55,8,16], "|":[220,43,16],
    "%":[53,6,16], "!":[49,2,16], "-":[189,12,0], ".":[190,52,0]
  };
  let vk = character.toUpperCase().codePointAt(0);
  let scan = scanCodes[character.toLowerCase()] || 0;
  let modifiers = /[A-Z]/.test(character) ? 16 : 0;
  if (punctuation[character]) [vk, scan, modifiers] = punctuation[character];
  if (code === 127 || code === 8) { vk = 8; scan = 14; }
  if (code === 13) { vk = 13; scan = 28; }
  if (code === 27) { vk = 27; scan = 1; }
  if (code === 3) { vk = 67; scan = 46; modifiers = 8; }
  const unicode = code === 127 ? 8 : code;
  for (const down of [1, 0]) term.write(`\x1b[${vk};${scan};${unicode};${down};${modifiers};1_`);
}

function lastUserText(input) {
  const message = [...(Array.isArray(input) ? input : [])].reverse().find((item) => item.role === "user");
  if (typeof message?.content === "string") return message.content;
  return (message?.content || []).map((part) => part.text || "").join("\n");
}

async function startFixtureServer() {
  server = http.createServer(async (request, response) => {
    report.httpRequests.push({ method: request.method, url: request.url, encoding: request.headers["content-encoding"] || null });
    if (request.method !== "POST" || !request.url.includes("responses")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [] }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    let userText;
    try {
      userText = lastUserText(JSON.parse(body).input);
    } catch (error) {
      report.fixtureErrors.push(error.message);
      response.writeHead(400);
      response.end(error.message);
      return;
    }
    report.requests += 1;
    const titleRequest = userText.startsWith("Generate a concise, single-line task title");
    if (!titleRequest) prompts.push(userText);
    const turn = titleRequest ? "title" : ++responseTurns;
    const id = "resp_fullscreen_" + turn;
    const itemId = "msg_fullscreen_" + turn;
    const lines = titleRequest ? ["Check fullscreen"]
      : Array.from({ length: 45 }, (_, index) => "MOCK_" + turn + "_LINE_" + String(index + 1).padStart(2, "0") + " 한글 & | %PATH% !literal!");
    if (!titleRequest) lines.push("FULLSCREEN_RESPONSE_" + turn + "_READY");
    const text = lines.join("\n");
    const item = { id: itemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    const result = {
      id, object: "response", created_at: Math.floor(Date.now() / 1000),
      model: "gpt-6.1-sol", status: "completed", output: [item],
      usage: { input_tokens: 10, output_tokens: 50, total_tokens: 60, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }
    };
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    let sequence = 0;
    const send = (type, fields) => response.write("event: " + type + "\ndata: " + JSON.stringify({ type, sequence_number: sequence++, ...fields }) + "\n\n");
    send("response.created", { response: { ...result, status: "in_progress", output: [] } });
    send("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
    send("response.content_part.added", { item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    for (const line of lines) {
      if (response.destroyed) return;
      send("response.output_text.delta", { item_id: itemId, output_index: 0, content_index: 0, delta: line + "\n" });
      await sleep(20);
    }
    send("response.output_text.done", { item_id: itemId, output_index: 0, content_index: 0, text });
    send("response.content_part.done", { item_id: itemId, output_index: 0, content_index: 0, part: item.content[0] });
    send("response.output_item.done", { output_index: 0, item });
    send("response.completed", { response: result });
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

try {
  for (const directory of [codexHome, project]) fs.mkdirSync(directory, { recursive: true });
  const version = spawnSync(process.execPath, [codex, "--version"], { encoding: "utf8", cwd: project, env: { ...process.env, CODEX_HOME: codexHome } });
  check("installed Codex starts", version.status === 0, version.stderr?.trim());
  report.codexVersion = version.stdout.trim();
  const port = await startFixtureServer();
  fs.writeFileSync(path.join(codexHome, "config.toml"), [
    'model = "gpt-6.1-sol"', 'model_provider = "fullscreen-fixture"',
    "check_for_update_on_startup = false", "[analytics]", "enabled = false",
    "[features]", "daemon_auto_start = false", "enable_request_compression = false",
    "[model_providers.fullscreen-fixture]", 'name = "Local fullscreen verification"',
    'base_url = "http://127.0.0.1:' + port + '/v1"',
    'wire_api = "responses"', "requires_openai_auth = false",
    "[projects." + JSON.stringify(project) + "]", 'trust_level = "trusted"',
    "[tui]", "screen_reader_detection_done = true", "fullscreen_transcript = true",
    'status_line = ["model-with-reasoning", "current-dir"]', ""
  ].join("\n"));
  fs.writeFileSync(statusPath, "console.log(" + JSON.stringify(statusMarker + " Codex 0% · Claude 75%") + ");\n");
  // Observe only these hardcoded fixture inputs; never instrument a user session.
  fs.writeFileSync(preloadPath, [
    'const fs = require("node:fs");',
    "const originalEmit = process.stdin.emit;",
    "process.stdin.emit = function (event, ...args) {",
    "  if (event === 'data') fs.appendFileSync(" + JSON.stringify(inputPath) + ", JSON.stringify([...Buffer.from(args[0])]) + '\\n');",
    "  return originalEmit.call(this, event, ...args);",
    "};", ""
  ].join("\n"));
  const env = {
    ...process.env, CODEX_HOME: codexHome, CODEX_THREAD_ID: "",
    AI_BATTERY_BIN: statusPath, AI_BATTERY_DEBUG_LOG: debugPath,
    AI_BATTERY_FULLSCREEN_HUD: "0", AI_BATTERY_ROWPTY_CONPTY: "auto"
  };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  terminal = new Terminal({ allowProposedApi: true, cols: 100, rows: 30, scrollback: 1000, windowsPty: { backend: "conpty", buildNumber: 21376 } });
  terminal.onData((data) => { if (!closing && exited === null) term?.write(data); });
  terminal.parser.registerCsiHandler({ prefix: "?", final: "u" }, () => {
    if (!closing && exited === null) term?.write("\x1b[?0u");
    return true;
  });
  for (const final of ["h", "l"]) terminal.parser.registerCsiHandler({ prefix: "?", final }, (parameters) => {
    if (parameters.includes(9001)) hostWin32Input = final === "h";
    return false;
  });
  const childArgs = native ? [codex, "-C", project]
    : ["--require", preloadPath, runner, "--layout", "composite", "--interval", "0.5", "--provider", "all", "--", process.execPath, codex, "-C", project];
  term = pty.spawn(process.execPath, childArgs, {
    name: "xterm-256color", cols: 100, rows: 30, cwd: project, env,
    useConpty: true, useConptyDll: true, conptyInheritCursor: false
  });
  // node-pty 1.1.0 does not handle errors on its Windows input socket. A
  // second Ctrl+C can race with closure of the simulated host's ConPTY.
  term._agent?.inSocket?.on("error", (error) => {
    if (!closing) report.fixtureErrors.push("Host ConPTY input: " + error.message);
  });
  term.onData((data) => {
    rawOutput += data;
    outputTail = outputTail.then(() => new Promise((resolve) => terminal.write(data, () => {
      const screen = snapshot();
      const copies = screen.filter((line) => line.includes(statusMarker)).length;
      maxStatusCopies = Math.max(maxStatusCopies, copies);
      if (copies > 0) statusWasVisible = true;
      if (copies > 0 && !screen.at(-1).includes(statusMarker)) bottomRowViolations += 1;
      resolve();
    })));
  });
  term.onExit(({ exitCode }) => { exited = exitCode; });

  await waitFor((screen, text) => (directScreen || screen.at(-1).includes(statusMarker)) && text.includes("OpenAI Codex") && /gpt/i.test(text), "fullscreen startup and status row");
  report.screens.startup = lastScreen;
  if (!directScreen) check("battery row is inside the terminal", lastScreen.at(-1).includes(statusMarker));
  await type("/tui");
  key("\r");
  await waitFor((screen, text) => text.includes("TUI mode for next launch"), "/tui picker");
  report.screens.tuiPicker = lastScreen;
  check("actual /tui Fullscreen mode is active", lastScreen.join("\n").includes("Fullscreen (current)"));
  key("\x1b");
  await waitFor((screen, text) => !text.includes("TUI mode for next launch"), "close /tui picker");
  await type("first & | %PATH% !literal!");
  key("\r");
  await waitFor((screen, text) => text.includes("FULLSCREEN_RESPONSE_1_READY"), "first streamed response");
  report.screens.firstResponse = lastScreen;
  check("long response finishes without keypress nudges", prompts[0] === "first & | %PATH% !literal!", JSON.stringify(prompts));
  check("UTF-8 response is rendered", lastScreen.join("\n").includes("한글"));

  terminal.resize(84, 24);
  term.resize(84, 24);
  await sleep(600);
  await waitFor((screen) => screen.length === 24 && (directScreen || (screen.at(-1).includes(statusMarker)
    && fs.readFileSync(debugPath, "utf8").includes(':resize"'))), "shrink and redraw");
  report.screens.shrunk = lastScreen;
  terminal.resize(110, 34);
  term.resize(110, 34);
  await sleep(600);
  await waitFor((screen) => screen.length === 34 && (directScreen || screen.at(-1).includes(statusMarker)), "grow and redraw");
  report.screens.grown = lastScreen;
  if (!directScreen) check("resize keeps a single bottom row", true);
  await type("secondX");
  report.screens.typed = snapshot();
  key("\x7f");
  await sleep(250);
  await outputTail;
  report.screens.afterBackspace = snapshot();
  check("Backspace deletes one character", report.screens.afterBackspace.some((line) => line.trim() === "› second"));
  key("\r");
  await waitFor((screen, text) => text.includes("FULLSCREEN_RESPONSE_2_READY"), "second response after Backspace");
  report.screens.secondResponse = lastScreen;
  check("input and Backspace remain usable", prompts[1] === "second", JSON.stringify(prompts));
  if (!directScreen) {
    check("status row is never duplicated", statusWasVisible && maxStatusCopies === 1, maxStatusCopies);
    check("status remains outside the child screen", bottomRowViolations === 0, bottomRowViolations);
    const debug = fs.readFileSync(debugPath, "utf8");
    check("compositor ran without HUD or fallback", /"event":"(?:compositor|fullscreen):start"/.test(debug)
      && !/"event":"(?:native-fullscreen|hud|overlay|rowpty|conpty)[^"]*"/.test(debug));
  }
  if (expectPlain) {
    const debug = fs.readFileSync(debugPath, "utf8");
    check("legacy Node safely falls back to native Codex", debug.includes('"event":"compositor:unavailable"')
      && debug.includes('"event":"plain:start"') && !debug.includes('"event":"compositor:start"') && !statusWasVisible);
  }
  check("local fixture has no transport errors", report.fixtureErrors.length === 0, JSON.stringify(report.fixtureErrors));
  closing = true;
  key("\x03");
  await sleep(300);
  key("\x03");
  await waitFor(() => exited !== null, "clean exit");
  await outputTail;
  check("terminal alternate screen is restored", rawOutput.includes("\x1b[?1049l"));
  report.ok = true;
} catch (error) {
  report.failure = error.stack || error.message;
  report.screens.failure = lastScreen;
  console.error(report.failure);
} finally {
  try { if (term && exited === null) term.kill(); } catch {}
  await outputTail.catch(() => {});
  terminal?.dispose();
  if (server) { server.closeAllConnections?.(); server.close(); }
  report.completedAt = new Date().toISOString();
  report.debug = fs.existsSync(debugPath) ? fs.readFileSync(debugPath, "utf8") : null;
  report.prompts = prompts;
  report.hostWin32Input = hostWin32Input;
  report.inputBytes = fs.existsSync(inputPath) ? fs.readFileSync(inputPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  report.statusStats = { maxStatusCopies, bottomRowViolations };
  const tuiLog = path.join(codexHome, "log", "codex-tui.log");
  if (!report.ok && fs.existsSync(tuiLog)) report.codexErrors = fs.readFileSync(tuiLog, "utf8")
    .split("\n").filter((line) => /WARN|ERROR|error/i.test(line)).slice(-30);
  if (!report.ok) report.rawOutputTail = rawOutput.slice(-20000);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  try {
    await fs.promises.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    report.cleanupError = error.message;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  console.log("Report: " + reportPath);
}
// node-pty's console-list helper can retain a Windows process handle.
process.exit(report.ok ? 0 : 1);
