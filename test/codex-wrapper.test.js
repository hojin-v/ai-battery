import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import windowsLauncher from "../bin/codex-wrapper-win.cjs";

import { codexWrapperScript, windowsCodexWrapperBridge, diagnoseCodex, installCodexWrapper } from "../bin/ai-battery.js";

const posixOnly = { skip: process.platform === "win32" ? "POSIX-only" : false };
const terminalOnly = {
  skip: process.platform === "win32" ? "POSIX-only"
    : spawnSync("python3", ["--version"]).status === 0 ? false : "python3 is required for the PTY fixture"
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-wrapper ' [test]-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shim = path.join(root, "shim");
  const nvmDir = path.join(root, "nvm");
  const oldBin = path.join(nvmDir, "versions", "node", "v24.15.0", "bin");
  const activeBin = path.join(nvmDir, "versions", "node", "v18.0.0", "bin");
  for (const dir of [shim, oldBin, activeBin]) fs.mkdirSync(dir, { recursive: true });

  function command(dir, name, body) {
    const target = path.join(dir, name);
    fs.writeFileSync(target, "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
    return target;
  }
  const oldCodex = command(oldBin, "codex", "printf '%s\\n' old");
  const oldRunner = command(oldBin, "ai-battery-run", "printf '%s\\n' old-runner");
  command(oldBin, "node", "printf '%s\\n' tool-node");
  command(activeBin, "node", "printf '%s\\n' project-node");
  const activeCodex = command(activeBin, "codex", [
    "printf '%s\\n' active",
    'printf "original:%s\\n" "$AI_BATTERY_ORIGINAL_CODEX"',
    'printf "wrapped:%s\\n" "$AI_BATTERY_WRAPPED_CODEX"',
    'printf "arg:%s\\n" "$@"',
    "exit 23"
  ].join("\n"));
  const wrapper = path.join(shim, "codex");
  fs.writeFileSync(wrapper, codexWrapperScript(oldRunner), { mode: 0o755 });

  function run(args = [], extra = {}) {
    return spawnSync(wrapper, args, {
      encoding: "utf8",
      timeout: 5000,
      ...extra,
      env: {
        ...process.env,
        NVM_DIR: nvmDir,
        HOME: path.join(root, "home"),
        HOMEBREW_PREFIX: "",
        PATH: [shim, activeBin].join(path.delimiter),
        AI_BATTERY_WRAPPED_CODEX: "inherited",
        ...extra.env
      }
    });
  }
  return { root, shim, nvmDir, oldBin, activeBin, command, oldCodex, oldRunner, activeCodex, wrapper, run };
}

function runNode(f, args, env) {
  // File descriptors also capture Node output in restricted subprocess hosts.
  const out = path.join(f.root, "node-out");
  const err = path.join(f.root, "node-err");
  const stdout = fs.openSync(out, "w");
  const stderr = fs.openSync(err, "w");
  let result;
  try {
    result = spawnSync(process.execPath, args, { env, stdio: ["ignore", stdout, stderr], timeout: 5000 });
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
  return { ...result, stdout: fs.readFileSync(out, "utf8"), stderr: fs.readFileSync(err, "utf8") };
}

test("missing Codex never reuses a saved command, another nvm version, or a Homebrew prefix", posixOnly, (t) => {
  const f = fixture(t);
  const brewBin = path.join(f.root, "homebrew", "bin");
  fs.mkdirSync(brewBin, { recursive: true });
  f.command(brewBin, "codex", "exit 99");
  const result = f.run(["update"], { env: { PATH: f.shim, HOMEBREW_PREFIX: path.dirname(brewBin) } });
  assert.equal(result.status, 127, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "codex: command not found on PATH\n");
});

test("missing Codex never prompts or runs npm or brew, including in a terminal", terminalOnly, (t) => {
  const f = fixture(t);
  fs.rmSync(f.activeCodex);
  const log = path.join(f.root, "manager-ran");
  for (const name of ["npm", "brew"]) {
    f.command(f.activeBin, name, 'printf "%s\\n" ran > "$AI_BATTERY_TEST_MANAGER_LOG"');
  }
  for (const args of [[], ["--help"], ["--version"], ["exec", "prompt"], ["resume", "id"], ["update"]]) {
    const result = runInTerminal(f, args, { env: { AI_BATTERY_TEST_MANAGER_LOG: log } });
    assert.equal(result.status, 127, result.stderr + result.stdout);
    assert.equal(result.stdout, "codex: command not found on PATH\n");
    assert.equal(fs.existsSync(log), false);
  }
});

test("an earlier PATH install wins over Codex beside the active Node", posixOnly, (t) => {
  const f = fixture(t);
  installNodeCodex(f, f.activeBin);
  const bin = path.join(f.root, "homebrew", "bin");
  fs.mkdirSync(bin, { recursive: true });
  f.command(bin, "codex", 'printf "brew:%s\\n" "$@"');
  const result = f.run(["update"], { env: { PATH: [f.shim, bin, f.activeBin].join(":") } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "brew:update\n");
  assert.equal(result.stderr, "");
});

test("npm Codex retains its shebang's PATH Node even when its installation owns a different Node", posixOnly, (t) => {
  const f = fixture(t);
  installNodeCodex(f);
  installNodeCodex(f, f.activeBin);
  fs.rmSync(f.activeCodex);
  const testPath = [f.shim, f.activeBin, f.oldBin].join(":");
  const result = f.run(["exec", "a b", "*"], { env: { PATH: testPath } });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    tool: "current-tool-node", project: "project-node", path: testPath, args: ["exec", "a b", "*"]
  });
  assert.equal(result.stderr, "");
});

test("npm aliases on PATH are not rejected because their original nvm Node was removed", posixOnly, (t) => {
  const f = fixture(t);
  const js = installNodeCodex(f);
  installNodeCodex(f, f.activeBin);
  fs.rmSync(f.activeCodex);
  fs.rmSync(path.join(f.oldBin, "node"));
  fs.symlinkSync(js, f.activeCodex);
  const result = f.run(["--version"]);
  assert.equal(result.status, 23, result.stderr);
  assert.equal(JSON.parse(result.stdout).tool, "current-tool-node");
});

test("TTY launch passes updates, profiles and resume arguments without injecting config or changing updater ownership", terminalOnly, (t) => {
  const f = fixture(t);
  const runnerBody = 'shift 3\nexec "$@"';
  f.command(f.activeBin, "ai-battery-run", runnerBody);
  f.command(f.activeBin, "codex", [
    'printf "npm:%s\\nbun:%s\\nroot:%s\\n" "$CODEX_MANAGED_BY_NPM" "$CODEX_MANAGED_BY_BUN" "$CODEX_MANAGED_PACKAGE_ROOT"',
    'printf "arg:%s\\n" "$@"',
    "exit 23"
  ].join("\n"));
  for (const args of [["update"], ["--profile", "exec", "resume", "session id"], ["-c", "check_for_update_on_startup=true"]]) {
    const result = runInTerminal(f, args, { env: {
      CODEX_MANAGED_BY_NPM: "inherited-npm", CODEX_MANAGED_BY_BUN: "inherited-bun", CODEX_MANAGED_PACKAGE_ROOT: "/unchanged"
    } });
    assert.equal(result.status, 23, result.stderr + result.stdout);
    assert.equal(result.stdout, ["npm:inherited-npm", "bun:inherited-bun", "root:/unchanged", ...args.map(arg => "arg:" + arg), ""].join("\n"));
  }
});

test("the configured AI Battery runtime polls usage without replacing Codex's runtime or project PATH", terminalOnly, (t) => {
  const f = fixture(t);
  installNodeCodex(f, f.activeBin);
  f.command(f.oldBin, "ai-battery-run", 'printf "meter-node:%s\\n" "$AI_BATTERY_NODE"\nshift 3\nexec "$@"');
  const testPath = [f.shim, f.activeBin].join(":");
  const result = runInTerminal(f, ["resume", "existing-id"], { env: { PATH: testPath } });
  assert.equal(result.status, 23, result.stderr + result.stdout);
  const [meter, json] = result.stdout.trim().split("\n");
  assert.equal(meter, "meter-node:" + path.join(f.oldBin, "node"));
  const codex = JSON.parse(json);
  assert.equal(codex.tool, "current-tool-node");
  assert.equal(codex.project, "project-node");
  assert.equal(codex.path, testPath);
  assert.deepEqual(codex.args, ["resume", "existing-id"]);
});

test("a missing runner runtime uses plain Codex without scanning other nvm installations", terminalOnly, (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.oldBin, "node"));
  const other = path.join(f.nvmDir, "versions", "node", "v99.0.0", "bin");
  fs.mkdirSync(other, { recursive: true });
  f.command(other, "node", "exit 98");
  f.command(other, "ai-battery-run", "exit 99");
  const result = runInTerminal(f, ["--version"]);
  assert.equal(result.status, 23, result.stderr + result.stdout);
  assert.match(result.stdout, /^active\n/);
  assert.match(result.stdout, /\nwrapped:\narg:--version\n$/);
});

test("PATH symlinks follow installer upgrades and keep Codex home, directory and resume arguments", terminalOnly, (t) => {
  const f = fixture(t);
  const bin = path.join(f.root, "public-bin");
  const releases = path.join(f.root, "Caskroom", "codex");
  const cwd = path.join(f.root, "project");
  for (const dir of [bin, releases, cwd]) fs.mkdirSync(dir, { recursive: true });
  const context = 'printf "home:%s\\ncodex-home:%s\\ncwd:%s\\n" "$HOME" "$CODEX_HOME" "$PWD"\nprintf "arg:%s\\n" "$@"';
  const first = f.command(releases, "0.160", "exit 99");
  const second = f.command(releases, "0.162", context);
  const entry = path.join(bin, "codex");
  fs.symlinkSync(first, entry);
  fs.rmSync(entry);
  fs.symlinkSync(second, entry);
  f.command(f.activeBin, "ai-battery-run", 'shift 3\nexec "$@"');
  const env = { PATH: [f.shim, bin, f.activeBin].join(":"), CODEX_HOME: path.join(f.root, "shared-state") };
  const result = runInTerminal(f, ["resume", "same-id", "--profile", "project"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stdout, [
    "home:" + path.join(f.root, "home"), "codex-home:" + env.CODEX_HOME, "cwd:" + cwd,
    "arg:resume", "arg:same-id", "arg:--profile", "arg:project", ""
  ].join("\n"));
});

test("setup and doctor resolve only PATH and flag old wrappers for migration", posixOnly, (t) => {
  const f = fixture(t);
  setupEnvironment(f, { PATH: [f.shim, f.oldBin].join(":") }, () => {
    assert.equal(installCodexWrapper({ force: false }).ok, true);
    process.env.PATH = [f.shim, f.activeBin].join(":");
    let diagnostic = diagnoseCodex();
    assert.equal(diagnostic.pathOnly, true);
    assert.equal(diagnostic.originalCommand, f.oldCodex);
    assert.equal(diagnostic.resolvedOriginalCommand, f.activeCodex);
    fs.rmSync(f.activeCodex);
    diagnostic = diagnoseCodex();
    assert.equal(diagnostic.resolvedOriginalCommand, null);
    assert.equal(diagnostic.pathOriginal, null);
    assert.equal(diagnostic.originalExists, true);
    assert.ok(diagnostic.notes.some(note => note.includes("not found on PATH")));
    assert.equal(installCodexWrapper({ force: false }).ok, false);
    fs.writeFileSync(f.wrapper, "#!/bin/sh\n# AI_BATTERY_MANAGED_CODEX_WRAPPER=1\nexit 0\n");
    diagnostic = diagnoseCodex();
    assert.equal(diagnostic.pathOnly, false);
    assert.ok(diagnostic.notes.some(note => note.includes("pins installation paths")));
  });
});

test("setup keeps an unmanaged local Codex entry intact", posixOnly, (t) => {
  const f = fixture(t);
  const home = path.join(f.root, "home");
  const bin = path.join(home, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const original = f.command(bin, "codex", "exit 0");
  const before = fs.readFileSync(original, "utf8");
  setupEnvironment(f, { PATH: [bin, f.activeBin].join(":"), AI_BATTERY_SHIM_DIR: "" }, () => {
    const installed = installCodexWrapper({ force: false });
    assert.equal(installed.ok, true);
    assert.equal(installed.originalCommand, original);
    assert.notEqual(installed.wrapperPath, original);
    assert.equal(fs.readFileSync(original, "utf8"), before);
  });
});

test("Windows PATH resolver uses PATH and PATHEXT order while skipping managed aliases", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.shim, "codex.cmd"), "rem AI_BATTERY_MANAGED_CODEX_WRAPPER=1\r\n");
  fs.writeFileSync(path.join(f.activeBin, "codex.cmd"), "@echo off\r\n");
  fs.writeFileSync(path.join(f.oldBin, "codex.exe"), "native");
  const env = { PATH: [f.shim, f.oldBin, f.activeBin].join(path.delimiter), PATHEXT: ".EXE;.CMD" };
  assert.equal(windowsLauncher.findWindowsPathCommand("codex", env), path.join(f.oldBin, "codex.exe"));
  fs.writeFileSync(path.join(f.oldBin, "codex.cmd"), "@echo off\r\n");
  env.PATHEXT = ".CMD;.EXE";
  assert.equal(windowsLauncher.findWindowsPathCommand("codex", env), path.join(f.oldBin, "codex.cmd"));
  fs.rmSync(path.join(f.oldBin, "codex"));
  env.PATH = f.shim;
  assert.equal(windowsLauncher.findWindowsPathCommand("codex", env), null);
});

test("Windows npm shim uses its adjacent Node or PATH Node rather than AI Battery's Node", (t) => {
  const f = fixture(t);
  const js = path.join(f.oldBin, "codex.js");
  const cmd = path.join(f.oldBin, "codex.cmd");
  fs.writeFileSync(js, "");
  fs.writeFileSync(cmd, '"%_prog%" "%dp0%\\codex.js" %*\r\n');
  const selectedNode = path.join(f.activeBin, "node.exe");
  fs.writeFileSync(selectedNode, "active-node");
  setupEnvironment(f, { PATH: f.activeBin }, () => {
    assert.equal(windowsLauncher.resolveNpmCmdShim(cmd).file, selectedNode);
    const adjacent = path.join(f.oldBin, "node.exe");
    fs.writeFileSync(adjacent, "shim-node");
    assert.equal(windowsLauncher.resolveNpmCmdShim(cmd).file, adjacent);
  });
});

test("generated Windows bridge is self-contained and does not save a Codex execution path", posixOnly, (t) => {
  const f = fixture(t);
  const bridge = path.join(f.shim, "codex.cmd.ai-battery.cjs");
  const source = windowsCodexWrapperBridge();
  new vm.Script(source);
  fs.writeFileSync(bridge, source);
  const result = runNode(f, [bridge, "update", "literal $PATH"], { ...process.env, PATH: [f.shim, f.activeBin].join(":") });
  assert.equal(result.status, 23, result.stderr);
  assert.match(result.stdout, /^active\n/);
  assert.match(result.stdout, /\narg:update\narg:literal \$PATH\n$/);
  const missing = runNode(f, [bridge], { ...process.env, PATH: f.shim });
  assert.equal(missing.status, 127, missing.stderr);
  assert.equal(missing.stderr, "codex: command not found on PATH\n");
});

test("POSIX wrapper follows the active PATH even while the saved nvm version exists", posixOnly, (t) => {
  const f = fixture(t);
  const args = ["--version", "a b", "quote'\" $HOME; $(false)", "", "line\nbreak", "*"];
  const result = f.run(args);
  assert.equal(result.status, 23, result.stderr);
  assert.equal(result.stdout, [
    "active",
    "original:" + f.activeCodex,
    "wrapped:",
    ...args.map((arg) => "arg:" + arg),
    ""
  ].join("\n"));
});


test("POSIX wrapper survives deletion of the original Node and AI Battery installation", posixOnly, (t) => {
  const f = fixture(t);
  fs.rmSync(path.dirname(f.oldBin), { recursive: true });
  const result = f.run(["--version"]);
  assert.equal(result.status, 23, result.stderr);
  assert.match(result.stdout, /^active\n/);
  assert.equal(result.stderr, "");
});


test("POSIX wrapper skips legacy wrappers, symlink aliases, and unusable PATH entries", posixOnly, (t) => {
  const f = fixture(t);
  const legacyBin = path.join(f.root, "legacy");
  const aliasBin = path.join(f.root, "alias");
  const brokenBin = path.join(f.root, "broken");
  const noExecBin = path.join(f.root, "not-executable");
  for (const dir of [legacyBin, aliasBin, brokenBin, noExecBin]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(legacyBin, "codex"),
    "#!/bin/sh\n# AI_BATTERY_MANAGED_CODEX_WRAPPER=1\nexit 99\n", { mode: 0o755 });
  fs.symlinkSync(f.wrapper, path.join(aliasBin, "codex"));
  fs.symlinkSync(path.join(f.root, "missing"), path.join(brokenBin, "codex"));
  fs.writeFileSync(path.join(noExecBin, "codex"), "#!/bin/sh\nexit 98\n", { mode: 0o644 });
  const result = f.run([], {
    env: { PATH: [f.shim, legacyBin, aliasBin, brokenBin, noExecBin, f.shim, f.activeBin].join(":") }
  });
  assert.equal(result.status, 23, result.stderr);
  assert.match(result.stdout, /^active\n/);
});


test("POSIX wrapper handles empty and relative PATH entries without changing argument expansion", posixOnly, (t) => {
  const f = fixture(t);
  for (const entry of ["", path.relative(f.root, f.activeBin)]) {
    const result = f.run(["a b", "*"], {
      cwd: entry ? f.root : f.activeBin,
      env: { PATH: f.shim + ":" + entry }
    });
    assert.equal(result.status, 23, result.stderr);
    assert.match(result.stdout, /\narg:a b\narg:\*\n$/);
  }
});


function runInTerminal(f, args, options = {}) {
  const { PATH: testPath, ...envOverrides } = options.env || {};
  const python = [
    "import errno, json, os, pty, select, subprocess, sys, time",
    "master, slave = pty.openpty()",
    "env = dict(os.environ, PATH=os.environ['AI_BATTERY_TEST_PATH'])",
    "child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, env=env)",
    "os.close(slave)",
    "output = b''",
    "deadline = time.monotonic() + 5",
    "while True:",
    "    if time.monotonic() >= deadline:",
    "        child.kill()",
    "        raise TimeoutError(output.decode(errors='replace'))",
    "    if not select.select([master], [], [], 0.05)[0]: continue",
    "    try:",
    "        chunk = os.read(master, 4096)",
    "        if not chunk: break",
    "        output += chunk",
    "        if b'Choice [' in output:",
    "            child.kill()",
    "            raise RuntimeError('Unexpected prompt: ' + output.decode(errors='replace'))",
    "    except OSError as error:",
    "        if error.errno != errno.EIO: raise",
    "        break",
    "os.close(master)",
    "sys.stdout.buffer.write(output.replace(b'\\r\\n', b'\\n'))",
    "sys.exit(child.wait(timeout=1))"
  ].join("\n");
  return spawnSync("python3", ["-c", python, f.wrapper, ...args], {
    encoding: "utf8",
    timeout: 10000,
    cwd: options.cwd,
    env: {
      ...process.env,
      NVM_DIR: f.nvmDir,
      HOME: path.join(f.root, "home"),
      HOMEBREW_PREFIX: "",
      AI_BATTERY_TEST_PATH: testPath || [f.shim, f.activeBin].join(":"),
      ...envOverrides
    }
  });
}

test("POSIX wrapper resolves the current runner in a TTY and falls back when both installations vanish", posixOnly, (t) => {
  const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (python.error?.code === "ENOENT") return t.skip("python3 is required for the PTY fixture");
  assert.equal(python.status, 0, python.stderr);
  const f = fixture(t);
  f.command(f.activeBin, "ai-battery-run", [
    "printf '%s\\n' active-runner",
    '[ "$AI_BATTERY_WRAPPED_CODEX" = 1 ] || exit 97',
    '[ "$1" = --provider ] && [ "$2" = all ] && [ "$3" = -- ] || exit 96',
    "shift 3",
    'exec "$@"'
  ].join("\n"));
  const wrapped = runInTerminal(f, ["a b", "*"]);
  assert.equal(wrapped.status, 23, wrapped.stderr);
  assert.match(wrapped.stdout, /^active-runner\nactive\n/);
  assert.match(wrapped.stdout, /\nwrapped:1\narg:a b\narg:\*\n$/);

  fs.rmSync(path.dirname(f.oldBin), { recursive: true });
  fs.rmSync(path.join(f.activeBin, "ai-battery-run"));
  const plain = runInTerminal(f, ["--version"]);
  assert.equal(plain.status, 23, plain.stderr);
  assert.match(plain.stdout, /^active\n/);
  assert.match(plain.stdout, /\nwrapped:\narg:--version\n$/);
});


function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function installNodeCodex(f, bin = f.oldBin) {
  const js = path.join(bin, "..", "lib", "node_modules", "@openai", "codex", "bin", "codex.js");
  fs.mkdirSync(path.dirname(js), { recursive: true });
  fs.writeFileSync(js, [
    "#!/usr/bin/env node",
    'import { spawnSync } from "node:child_process";',
    'import { readFileSync, writeSync } from "node:fs";',
    "const result = {",
    "  tool: process.env.AI_BATTERY_TEST_TOOL_NODE,",
    '  project: spawnSync("node", ["--version"], {encoding: "utf8"}).stdout.trim(),',
    "  path: process.env.PATH,",
    "  args: process.argv.slice(2)",
    "};",
    "if (process.env.AI_BATTERY_TEST_SESSION_ID) {",
    "  result.session = {",
    "    home: process.env.HOME, codexHome: process.env.CODEX_HOME, cwd: process.cwd(),",
    "    id: process.env.AI_BATTERY_TEST_SESSION_ID,",
    '    history: JSON.parse(readFileSync(process.env.CODEX_HOME + "/sessions/" + process.env.AI_BATTERY_TEST_SESSION_ID + ".json", "utf8"))',
    "  };",
    "}",
    'writeSync(1, JSON.stringify(result) + "\\n");',
    "process.exit(23);"
  ].join("\n"), { mode: 0o755 });
  fs.rmSync(path.join(bin, "codex"), { force: true });
  fs.symlinkSync(js, path.join(bin, "codex"));
  f.command(bin, "node", [
    bin === f.activeBin ? 'if [ "$#" = 1 ] && [ "$1" = --version ]; then printf "%s\\n" project-node; exit 0; fi' : ":",
    "export AI_BATTERY_TEST_TOOL_NODE=" + (bin === f.activeBin ? "current-tool-node" : "tool-node"),
    "exec " + shellQuote(process.execPath) + ' "$@"'
  ].join("\n"));
  return js;
}

function setupEnvironment(f, env, action) {
  const values = {
    HOME: path.join(f.root, "home"),
    NVM_DIR: f.nvmDir,
    AI_BATTERY_STATE_DIR: path.join(f.root, "state"),
    AI_BATTERY_DATA_DIR: path.join(f.root, "data"),
    AI_BATTERY_SHIM_DIR: f.shim,
    AI_BATTERY_RC: path.join(f.root, "shellrc"),
    ...env
  };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    return action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("POSIX status polling uses the runner's Node and falls back when that Node is unavailable", terminalOnly, (t) => {
  const f = fixture(t);
  const runner = fileURLToPath(new URL("../bin/ai-battery-run", import.meta.url));
  const python = [
    "import os, runpy, subprocess, sys",
    "os.environ['PATH'] = sys.argv[2]",
    "namespace = runpy.run_path(sys.argv[1], run_name='ai_battery_test')",
    "command = namespace['battery_command_base']()",
    "sys.stdout.buffer.write(subprocess.check_output(command))"
  ].join("\n");
  for (const [override, output] of [[path.join(f.oldBin, "node"), "tool-node\n"], [path.join(f.root, "missing-node"), "project-node\n"]]) {
    const result = spawnSync("python3", ["-c", python, runner, f.activeBin], {
      encoding: "utf8",
      env: { ...process.env, AI_BATTERY_NODE: override, AI_BATTERY_BIN: path.join(f.root, "meter.js") }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, output);
  }
});
