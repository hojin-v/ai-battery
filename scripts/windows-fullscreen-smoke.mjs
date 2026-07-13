import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(root, "bin", "ai-battery-run-win.js");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-fullscreen-"));
const nativeMode = process.argv.includes("--native");

function runInPty(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const term = pty.spawn(process.execPath, args, {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: root,
      env: {
        ...process.env,
        AI_BATTERY_BIN: path.join(tempDir, "status.mjs"),
        AI_BATTERY_DEBUG_LOG: path.join(tempDir, "debug.log"),
        AI_BATTERY_FULLSCREEN_HUD: "0",
        AI_BATTERY_ROWPTY_CONPTY: "auto"
      }
    });
    let output = "";
    const timeout = setTimeout(() => {
      try {
        term.kill();
      } catch {}
      reject(new Error(`fullscreen smoke timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    term.onData((data) => {
      output += data;
    });
    term.onExit(({ exitCode, signal }) => {
      clearTimeout(timeout);
      resolve({ output, exitCode, signal });
    });
  });
}

function assertCheck(name, passed, detail = "") {
  if (!passed) throw new Error(`${name}: ${detail}`);
  console.log(`PASS  ${name}`);
}

async function runCase(name, command) {
  fs.writeFileSync(path.join(tempDir, "debug.log"), "");
  const result = await runInPty([
    runner,
    "--layout", nativeMode ? "fullscreen" : "composite",
    "--interval", "0.5",
    "--provider", "all",
    "--",
    ...command
  ]);
  const debug = fs.readFileSync(path.join(tempDir, "debug.log"), "utf8");
  const prefix = `FULLSCREEN_${name.toUpperCase()}`;

  assertCheck(`${name}: child exits successfully`, result.exitCode === 0, `exit=${result.exitCode}, signal=${result.signal}`);
  const expectedEvent = nativeMode ? '"event":"native-fullscreen:start"' : '"event":"fullscreen:start"';
  assertCheck(`${name}: ${nativeMode ? "native fullscreen" : "compositor"} path starts`, debug.includes(expectedEvent), debug);
  assertCheck(`${name}: no unintended terminal path starts`, nativeMode
    ? !/"event":"(?:fullscreen|rowpty|overlay|conpty):start"/.test(debug)
    : !/"event":"(?:native-fullscreen|rowpty|overlay|conpty):start"/.test(debug), debug);
  assertCheck(`${name}: host alternate screen is entered`, result.output.includes("\x1b[?1049h"));
  assertCheck(`${name}: final child frame is visible`, result.output.includes(`${prefix}_FINAL`));
  if (!nativeMode) {
    assertCheck(`${name}: status row is visible`, result.output.includes("FULLSCREEN_STATUS"));
    assertCheck(`${name}: child CSI 3J is isolated`, !result.output.includes("\x1b[3J"));
  }
  assertCheck(`${name}: host alternate screen is restored`, result.output.includes("\x1b[?1049l"));
}

if (process.platform !== "win32") {
  console.log("SKIP  windows fullscreen smoke is Windows-only");
  process.exit(0);
}

try {
  fs.writeFileSync(path.join(tempDir, "status.mjs"), "console.log('FULLSCREEN_STATUS 99%');\n");
  const child = path.join(tempDir, "child.mjs");
  fs.writeFileSync(child, [
    "const prefix = process.argv[2];",
    "process.stdout.write(prefix + '_START\\n');",
    "process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[H' + prefix + '_OLD');",
    "setTimeout(() => {",
    "  process.stdout.write('\\x1b[3J\\x1b[2J\\x1b[H' + prefix + '_FINAL');",
    "}, 250);",
    "setTimeout(() => process.stdout.write('\\x1b[?1049l'), 900);",
    "setTimeout(() => process.exit(0), 1200);"
  ].join("\n"));

  const cmdWrapper = path.join(tempDir, "child.cmd");
  fs.writeFileSync(cmdWrapper, `@echo off\r\n"${process.execPath}" "${child}" FULLSCREEN_CMD\r\nexit /b %ERRORLEVEL%\r\n`);
  const powershellWrapper = path.join(tempDir, "child.ps1");
  fs.writeFileSync(
    powershellWrapper,
    `& '${process.execPath.replaceAll("'", "''")}' '${child.replaceAll("'", "''")}' FULLSCREEN_POWERSHELL\nexit $LASTEXITCODE\n`
  );

  await runCase("cmd", [cmdWrapper]);
  await runCase("powershell", [
    "powershell.exe",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", powershellWrapper
  ]);
  console.log(`ALL PASS (${nativeMode ? "native fullscreen" : "experimental compositor"})`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// node-pty's Windows console-list helper can keep a handle alive after both
// child PTYs have exited. All assertions are complete, so do not let that
// helper turn a passing smoke run into a harness timeout.
process.exit(0);
