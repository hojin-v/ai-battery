import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { codexWrapperScript, diagnoseCodex, installCodexWrapper } from "../bin/ai-battery.js";

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
  fs.writeFileSync(wrapper, codexWrapperScript(oldCodex, oldRunner), { mode: 0o755 });

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

test("POSIX wrapper retains a usable saved Codex when PATH has no original command", posixOnly, (t) => {
  const f = fixture(t);
  const result = f.run([], { env: { PATH: f.shim } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "old\n");
});

test("POSIX wrapper reports a missing Codex without recursing into its saved wrapper", posixOnly, (t) => {
  const f = fixture(t);
  fs.rmSync(f.activeCodex);
  for (const fallback of [f.oldCodex, f.wrapper]) {
    fs.rmSync(f.oldCodex, { force: true });
    fs.writeFileSync(f.wrapper, codexWrapperScript(fallback, f.oldRunner), { mode: 0o755 });
    const result = f.run([], { env: { PATH: f.shim } });
    assert.equal(result.status, 127, result.stderr);
    assert.match(result.stderr, /codex was not found on PATH/);
    assert.match(result.stderr, /npm install -g @openai\/codex@latest/);
    assert.doesNotMatch(result.stderr, /Choice \[/);
    assert.equal(result.stdout, "");
  }
});

function runInTerminal(f, args, options = {}) {
  const { PATH: testPath, ...envOverrides } = options.env || {};
  const python = [
    "import errno, json, os, pty, select, subprocess, sys, time",
    "master, slave = pty.openpty()",
    "env = dict(os.environ, PATH=os.environ['AI_BATTERY_TEST_PATH'])",
    "choices = json.loads(os.environ['AI_BATTERY_TEST_CHOICES'])",
    "child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, env=env)",
    "os.close(slave)",
    "output = b''",
    "answered = 0",
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
    "        while output.count(b'Choice [') > answered:",
    "            if not choices:",
    "                child.kill()",
    "                raise RuntimeError('Unexpected recovery prompt: ' + output.decode(errors='replace'))",
    "            os.write(master, (choices.pop(0) + '\\n').encode())",
    "            answered += 1",
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
      AI_BATTERY_TEST_CHOICES: JSON.stringify(options.choices || []),
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

test("setup refreshes its saved Codex from PATH even while the previous install exists", posixOnly, (t) => {
  const f = fixture(t);
  const values = {
    HOME: path.join(f.root, "home"),
    NVM_DIR: f.nvmDir,
    AI_BATTERY_STATE_DIR: path.join(f.root, "state"),
    AI_BATTERY_DATA_DIR: path.join(f.root, "data"),
    AI_BATTERY_SHIM_DIR: f.shim,
    AI_BATTERY_RC: path.join(f.root, "shellrc"),
    PATH: [f.shim, f.oldBin].join(":")
  };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    const first = installCodexWrapper({ force: false });
    assert.equal(first.ok, true);
    assert.equal(first.originalCommand, f.oldCodex);
    process.env.PATH = [f.shim, f.activeBin].join(":");
    const currentRunner = f.command(f.activeBin, "ai-battery-run", "exit 0");
    const diagnostic = diagnoseCodex();
    assert.equal(diagnostic.pathLookup, true);
    assert.equal(diagnostic.originalCommand, f.oldCodex);
    assert.equal(diagnostic.resolvedOriginalCommand, f.activeCodex);
    assert.equal(diagnostic.runnerPath, currentRunner);
    const refreshed = installCodexWrapper({ force: false });
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.originalCommand, f.activeCodex);
    fs.rmSync(f.activeCodex);
    process.env.PATH = [f.shim, f.oldBin].join(":");
    const recovered = diagnoseCodex();
    assert.equal(recovered.originalExists, false);
    assert.equal(recovered.resolvedOriginalCommand, f.oldCodex);
    assert.equal(recovered.notes.some((note) => note.includes("saved by setup no longer exists")), false);
    fs.writeFileSync(f.wrapper, "#!/bin/sh\n# AI_BATTERY_MANAGED_CODEX_WRAPPER=1\nexit 0\n");
    const legacy = diagnoseCodex();
    assert.equal(legacy.pathLookup, false);
    assert.equal(legacy.resolvedOriginalCommand, f.activeCodex);
    assert.equal(legacy.notes.some((note) => note.includes("pins installation paths")), true);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

function mockNpm(f, body = "exit 98") {
  const log = path.join(f.root, "npm-calls");
  f.command(f.activeBin, "npm", 'printf "%s\\n" "$@" >> "$AI_BATTERY_TEST_NPM_LOG"\n' + body);
  return { AI_BATTERY_TEST_NPM_LOG: log };
}

function forwardingRunner(f, name = "ai-battery-run") {
  return f.command(f.activeBin, name, [
    'printf "runner-node:%s\\n" "$AI_BATTERY_NODE"',
    '[ "$1" = --provider ] && [ "$2" = all ] && [ "$3" = -- ] || exit 96',
    "shift 3",
    'exec "$@"'
  ].join("\n"));
}

test("interactive launch explains a missing runner and starts plain Codex without prompting or installing", terminalOnly, (t) => {
  const f = fixture(t);
  fs.rmSync(f.oldRunner);
  const env = mockNpm(f);
  const result = runInTerminal(f, ["a b"], { env });
  assert.equal(result.status, 23, result.stderr);
  assert.match(result.stdout, /No usable runner is available/);
  assert.match(result.stdout, /npm install -g ai-battery@latest/);
  assert.doesNotMatch(result.stdout, /Choice \[/);
  assert.match(result.stdout, /continuing without the AI Battery row/);
  assert.match(result.stdout, /\nactive\n/);
  assert.equal(fs.existsSync(env.AI_BATTERY_TEST_NPM_LOG), false);
});

test("interactive launch installs a missing Codex only after selection and retries with an available runner", terminalOnly, (t) => {
  const f = fixture(t);
  fs.rmSync(f.oldCodex);
  fs.rmSync(f.oldRunner);
  const pendingCodex = path.join(f.activeBin, "pending-codex");
  fs.renameSync(f.activeCodex, pendingCodex);
  forwardingRunner(f);
  const env = {
    ...mockNpm(f, [
      'case "$3" in',
      '  @openai/codex@latest) /bin/mv "$AI_BATTERY_TEST_CODEX" "$AI_BATTERY_TEST_BIN/codex" ;;',
      "  *) exit 97 ;;",
      "esac"
    ].join("\n")),
    AI_BATTERY_TEST_CODEX: pendingCodex,
    AI_BATTERY_TEST_BIN: f.activeBin
  };
  const result = runInTerminal(f, ["a b", "*"], { choices: ["1"], env });
  assert.equal(result.status, 23, result.stderr + result.stdout);
  assert.match(result.stdout, /\nwrapped:1\narg:a b\narg:\*\n$/);
  assert.match(result.stdout, /runner-node:/);
  assert.equal(fs.readFileSync(env.AI_BATTERY_TEST_NPM_LOG, "utf8"),
    "install\n-g\n@openai/codex@latest\n");
});

test("failed Codex installation returns to the recovery menu so the user can exit", terminalOnly, (t) => {
  const f = fixture(t);
  fs.rmSync(f.oldCodex);
  fs.rmSync(f.activeCodex);
  const env = mockNpm(f, "printf '%s\\n' 'mock npm failure' >&2\nexit 17");
  const result = runInTerminal(f, [], { choices: ["1", "0"], env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /mock npm failure/);
  assert.match(result.stdout, /Installation failed/);
  assert.doesNotMatch(result.stdout, /\nactive\n/);
  assert.equal(fs.readFileSync(env.AI_BATTERY_TEST_NPM_LOG, "utf8"), "install\n-g\n@openai/codex@latest\n");
});

test("successful npm with no PATH command explains the prefix issue instead of pretending the repair succeeded", terminalOnly, (t) => {
  const f = fixture(t);
  fs.rmSync(f.oldCodex);
  fs.rmSync(f.activeCodex);
  const env = mockNpm(f, "exit 0");
  const result = runInTerminal(f, [], { choices: ["1", "0"], env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /command is still missing from PATH/);
  assert.match(result.stdout, /npm prefix -g/);
  assert.doesNotMatch(result.stdout, /Ready:/);
  assert.equal(fs.readFileSync(env.AI_BATTERY_TEST_NPM_LOG, "utf8"), "install\n-g\n@openai/codex@latest\n");
});

test("invalid selections and cancellation never install or launch Codex", terminalOnly, (t) => {
  const f = fixture(t);
  fs.rmSync(f.oldCodex);
  fs.rmSync(f.activeCodex);
  const env = mockNpm(f);
  const result = runInTerminal(f, [], { choices: ["9", "0"], env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Choose one of the displayed options/);
  assert.doesNotMatch(result.stdout, /\nactive\n/);
  assert.equal(fs.existsSync(env.AI_BATTERY_TEST_NPM_LOG), false);
});

test("headless Codex subcommands never prompt or install even with a terminal", terminalOnly, (t) => {
  const f = fixture(t);
  fs.rmSync(f.oldCodex);
  fs.rmSync(f.activeCodex);
  const env = mockNpm(f);
  const result = runInTerminal(f, ["-c", "model=example", "exec", "a b"], { env });
  assert.equal(result.status, 127, result.stderr);
  assert.match(result.stdout, /codex was not found on PATH/);
  assert.doesNotMatch(result.stdout, /Choice \[/);
  assert.equal(fs.existsSync(env.AI_BATTERY_TEST_NPM_LOG), false);
});

test("recovery can be disabled while reusing an available Codex without installation", terminalOnly, (t) => {
  const f = fixture(t);
  fs.rmSync(f.activeCodex);
  fs.rmSync(f.oldRunner);
  const env = { ...mockNpm(f), AI_BATTERY_CODEX_RECOVERY: "off" };
  const result = runInTerminal(f, [], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reusing codex at/);
  assert.match(result.stdout, /\nold\n$/);
  assert.doesNotMatch(result.stdout, /Choice \[/);
  assert.equal(fs.existsSync(env.AI_BATTERY_TEST_NPM_LOG), false);
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

test("Codex reuses its own Node while project commands keep the active Node and PATH", posixOnly, (t) => {
  const f = fixture(t);
  installNodeCodex(f);
  fs.rmSync(f.activeCodex);
  const result = f.run(["exec", "a b", "*"]);
  assert.equal(result.status, 23, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    tool: "tool-node",
    project: "project-node",
    path: [f.shim, f.activeBin].join(":"),
    args: ["exec", "a b", "*"]
  });
  assert.doesNotMatch(result.stderr, /Choice \[/);
});

test("interactive launch automatically reuses Codex and explains the other Node without requiring input", terminalOnly, (t) => {
  const f = fixture(t);
  installNodeCodex(f);
  fs.rmSync(f.activeCodex);
  fs.rmSync(f.oldRunner);
  const env = mockNpm(f);
  const result = runInTerminal(f, ["a b"], { env });
  assert.equal(result.status, 23, result.stderr + result.stdout);
  assert.match(result.stdout, /Reusing codex at/);
  assert.match(result.stdout, /Codex is using another Node installation:.*v24\.15\.0\/bin\/node/);
  assert.doesNotMatch(result.stdout, /Choice \[/);
  const payload = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(payload.tool, "tool-node");
  assert.equal(payload.project, "project-node");
  assert.deepEqual(payload.args, ["-c", "check_for_update_on_startup=false", "a b"]);
  assert.equal(fs.existsSync(env.AI_BATTERY_TEST_NPM_LOG), false);
});

test("a removed saved Codex is replaced by another usable nvm install with numeric version ordering", posixOnly, (t) => {
  const f = fixture(t);
  fs.rmSync(f.oldCodex);
  fs.rmSync(f.activeCodex);
  for (const version of ["v9.0.0", "v22.9.0", "v22.10.0", "v99.0.0", "v40.0.0"]) {
    const dir = path.join(f.nvmDir, "versions", "node", version, "bin");
    fs.mkdirSync(dir, { recursive: true });
    if (version === "v99.0.0") {
      f.command(dir, "codex", "# AI_BATTERY_MANAGED_CODEX_WRAPPER=1\nexit 99");
    } else if (version === "v40.0.0") {
      fs.writeFileSync(path.join(dir, "codex"), "#!/usr/bin/env node\nthrow new Error('missing owner Node');", { mode: 0o755 });
    } else {
      f.command(dir, "codex", "printf '%s\\n' " + version);
    }
  }
  const result = f.run(["--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "v22.10.0\n");
  assert.match(result.stderr, /Reusing codex at.*v22\.10\.0\/bin\/codex/);
});

test("AI Battery can reuse a runner under another nvm version without installing it again", terminalOnly, (t) => {
  const f = fixture(t);
  fs.rmSync(f.oldRunner);
  const dir = path.join(f.nvmDir, "versions", "node", "v22.0.0", "bin");
  fs.mkdirSync(dir, { recursive: true });
  const node = f.command(dir, "node", "printf '%s\\n' other-tool-node");
  const runner = f.command(dir, "ai-battery-run",
    'printf "reused-runner:%s\\n" "$AI_BATTERY_NODE"\nshift 3\nexec "$@"');
  const env = mockNpm(f);
  const result = runInTerminal(f, ["a b"], { env });
  assert.equal(result.status, 23, result.stderr + result.stdout);
  assert.match(result.stdout, /Reusing ai-battery-run at/);
  assert.doesNotMatch(result.stdout, /Choice \[/);
  assert.equal(result.stdout.includes(runner), true);
  assert.equal(result.stdout.includes("reused-runner:" + node), true);
  assert.equal(fs.existsSync(env.AI_BATTERY_TEST_NPM_LOG), false);
});

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

test("a saved nvm runner whose Node was removed is excluded from reuse and offers plain Codex", terminalOnly, (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.oldBin, "node"));
  const result = runInTerminal(f, []);
  assert.equal(result.status, 23, result.stderr + result.stdout);
  assert.match(result.stdout, /No usable runner is available/);
  assert.doesNotMatch(result.stdout, /Choice \[/);
  assert.doesNotMatch(result.stdout, /Reuse an existing installation/);
  assert.match(result.stdout, /\nactive\n/);
});

test("setup can discover a reusable Codex outside the active Node and doctor reports its actual runtime", posixOnly, (t) => {
  const f = fixture(t);
  const js = installNodeCodex(f);
  fs.rmSync(f.activeCodex);
  const values = {
    HOME: path.join(f.root, "home"),
    NVM_DIR: f.nvmDir,
    AI_BATTERY_STATE_DIR: path.join(f.root, "state"),
    AI_BATTERY_DATA_DIR: path.join(f.root, "data"),
    AI_BATTERY_SHIM_DIR: f.shim,
    AI_BATTERY_RC: path.join(f.root, "shellrc"),
    PATH: [f.shim, f.activeBin].join(":")
  };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    const result = installCodexWrapper({ force: false });
    assert.equal(result.ok, true);
    assert.equal(result.originalCommand, f.oldCodex);
    const diagnostic = diagnoseCodex();
    assert.equal(diagnostic.nvmLookup, true);
    assert.equal(diagnostic.scopedUpdates, true);
    assert.equal(diagnostic.resolvedOriginalCommand, f.oldCodex);
    assert.equal(diagnostic.installation.target, fs.realpathSync(js));
    assert.equal(diagnostic.installation.kind, "npm");
    assert.equal(diagnostic.codexNode, path.join(f.oldBin, "node"));
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("installing Codex in the active Node switches automatically and keeps resume history and arguments", terminalOnly, (t) => {
  const f = fixture(t);
  const oldJs = installNodeCodex(f);
  fs.rmSync(f.activeCodex);
  forwardingRunner(f);
  const project = path.join(f.root, "project");
  const codexHome = path.join(f.root, "shared-codex-home");
  const id = "31d45f45-9188-487e-b6e5-c0f9bb0aa401";
  const history = [{ role: "user", text: "Keep the existing resume context." }];
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "sessions", id + ".json"), JSON.stringify(history));
  const env = {
    ...mockNpm(f),
    HOME: path.join(f.root, "shared-home"),
    CODEX_HOME: codexHome,
    AI_BATTERY_TEST_SESSION_ID: id
  };
  const before = fs.readFileSync(f.wrapper, "utf8");
  const first = runInTerminal(f, ["resume", id], { env, cwd: project });
  assert.equal(first.status, 23, first.stderr + first.stdout);
  assert.doesNotMatch(first.stdout, /Choice \[/);
  const reused = JSON.parse(first.stdout.trim().split("\n").at(-1));
  assert.equal(reused.tool, "tool-node");
  assert.deepEqual(reused.args, ["-c", "check_for_update_on_startup=false", "resume", id]);

  installNodeCodex(f, f.activeBin);
  const staleAlias = path.join(f.root, "stale-codex-alias");
  fs.mkdirSync(staleAlias);
  fs.symlinkSync(oldJs, path.join(staleAlias, "codex"));
  const second = runInTerminal(f, ["resume", id], {
    cwd: project,
    env: { ...env, PATH: [f.shim, staleAlias, f.activeBin].join(":") }
  });
  assert.equal(second.status, 23, second.stderr + second.stdout);
  const current = JSON.parse(second.stdout.trim().split("\n").at(-1));
  assert.equal(current.tool, "current-tool-node");
  assert.deepEqual(current.args, ["resume", id]);
  assert.deepEqual(current.session, reused.session);
  assert.deepEqual(current.session, { home: env.HOME, codexHome, cwd: project, id, history });
  assert.doesNotMatch(second.stdout, /another Node installation|Choice \[/);
  assert.equal(fs.readFileSync(f.wrapper, "utf8"), before);
  assert.equal(fs.existsSync(env.AI_BATTERY_TEST_NPM_LOG), false);
  assert.equal(current.path, [f.shim, staleAlias, f.activeBin].join(":"));
});

test("the copied update command and codex update both target the reused npm prefix and Node", posixOnly, (t) => {
  const f = fixture(t);
  installNodeCodex(f);
  fs.rmSync(f.activeCodex);
  const prefix = path.dirname(f.oldBin);
  const npmCli = path.join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const log = path.join(f.root, "owned-npm-calls.json");
  fs.mkdirSync(path.dirname(npmCli), { recursive: true });
  fs.writeFileSync(npmCli, [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const {spawnSync} = require("node:child_process");',
    "const args = process.argv.slice(2);",
    'const prefix = args[args.indexOf("--prefix") + 1];',
    "const result = {",
    "  args, prefix, node: process.env.AI_BATTERY_TEST_TOOL_NODE,",
    '  lifecycleNode: spawnSync("node", ["-e", "require(\'node:fs\').writeSync(1, process.env.AI_BATTERY_TEST_TOOL_NODE)"], {encoding:"utf8"}).stdout,',
    "  path: process.env.PATH, projectPrefix: process.env.npm_config_prefix",
    "};",
    'fs.writeFileSync(process.env.AI_BATTERY_TEST_OWNED_NPM_LOG, JSON.stringify(result));',
    'const pkg = path.join(prefix, "lib", "node_modules", "@openai", "codex", "package.json");',
    'fs.writeFileSync(pkg, JSON.stringify({name:"@openai/codex", version:"0.2.0", type:"module"}));'
  ].join("\n"));
  const env = {
    ...process.env,
    ...mockNpm(f),
    PATH: [f.shim, f.activeBin].join(":"),
    NVM_DIR: f.nvmDir,
    npm_config_prefix: path.dirname(f.activeBin),
    AI_BATTERY_TEST_OWNED_NPM_LOG: log
  };
  const notice = f.run(["--version"], { env });
  assert.equal(notice.status, 23, notice.stderr);
  const command = notice.stderr.split("\n").find((line) => line.startsWith("  PATH="))?.trim();
  assert.ok(command, notice.stderr);
  const copied = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env, timeout: 5000 });
  assert.equal(copied.status, 0, copied.stderr);
  for (const invocation of ["copied", "codex update"]) {
    if (invocation === "codex update") {
      fs.rmSync(log);
      const updated = f.run(["update"], { env });
      assert.equal(updated.status, 0, updated.stderr);
      assert.match(updated.stderr, /Updating the reused Codex installation/);
    }
    const actual = JSON.parse(fs.readFileSync(log, "utf8"));
    assert.deepEqual(actual.args, ["install", "-g", "--prefix", prefix, "@openai/codex@latest"]);
    assert.equal(actual.node, "tool-node");
    assert.equal(actual.lifecycleNode, "tool-node");
    assert.equal(actual.prefix, prefix);
    assert.equal(actual.projectPrefix, path.dirname(f.activeBin));
    assert.equal(actual.path, f.oldBin + ":" + env.PATH);
    assert.equal(fs.existsSync(env.AI_BATTERY_TEST_NPM_LOG), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(prefix, "lib/node_modules/@openai/codex/package.json"))).version, "0.2.0");
    assert.equal(fs.existsSync(path.join(f.activeBin, "codex")), false);
  }
});

test("profile names and resume names matching command names still receive the scoped update setting", terminalOnly, (t) => {
  const f = fixture(t);
  installNodeCodex(f);
  fs.rmSync(f.activeCodex);
  forwardingRunner(f);
  const args = ["--profile", "review", "resume", "exec"];
  const result = runInTerminal(f, args);
  assert.equal(result.status, 23, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.deepEqual(payload.args, ["-c", "check_for_update_on_startup=false", ...args]);
  assert.doesNotMatch(result.stdout, /Choice \[/);
});

function brewInstallation(f, name = "homebrew", family = "Caskroom", version = "0.160.0") {
  const prefix = path.join(f.root, name);
  const bin = path.join(prefix, "bin");
  const releaseBin = path.join(prefix, family, "codex", version, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(releaseBin, { recursive: true });
  const target = f.command(releaseBin, "codex", [
    'printf "release:%s\\n" ' + shellQuote(version),
    'printf "arg:%s\\n" "$@"',
    'printf "npm-owner:%s\\n" "$CODEX_MANAGED_BY_NPM"',
    'printf "package-root:%s\\n" "$CODEX_MANAGED_PACKAGE_ROOT"',
    'printf "cwd:%s\\n" "$PWD"',
    'printf "codex-home:%s\\n" "$CODEX_HOME"'
  ].join("\n"));
  const command = path.join(bin, "codex");
  fs.symlinkSync(path.relative(bin, target), command);
  const log = path.join(prefix, "brew-calls");
  const brew = f.command(bin, "brew", 'printf "%s\\n" "$@" >> ' + shellQuote(log));
  return { prefix, bin, target, command, log, brew };
}

function resolved(f, env = {}) {
  const result = f.run([], { env: { ...env, AI_BATTERY_CODEX_RESOLVE_ONLY: "1" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const fields = result.stdout.split("\0");
  assert.equal(fields.length, 11);
  const [command, target, kind, node, prefix, source, runner, runnerNode, activeNode, scopedUpdate] = fields;
  return { command, target, kind, node, prefix, source, runner, runnerNode, activeNode, scopedUpdate };
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

test("mixed npm and Homebrew installations follow current npm, then PATH, without reinstalling", posixOnly, (t) => {
  const f = fixture(t);
  const brew = brewInstallation(f);
  const env = { ...mockNpm(f), PATH: [f.shim, brew.bin, f.activeBin, f.oldBin].join(":") };
  installNodeCodex(f, f.activeBin);
  assert.equal(resolved(f, env).command, f.activeCodex);
  assert.equal(resolved(f, env).kind, "npm");
  fs.rmSync(f.activeCodex);
  assert.equal(resolved(f, env).command, brew.command);
  assert.equal(resolved(f, env).kind, "homebrew");
  const launched = f.run(["--version"], { env });
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /^release:0\.160\.0\narg:--version/);
  assert.equal(fs.existsSync(brew.log), false);
  assert.equal(fs.existsSync(env.AI_BATTERY_TEST_NPM_LOG), false);
});

test("native installations respect PATH even when another native Codex sits beside the current Node", posixOnly, (t) => {
  const f = fixture(t);
  const first = brewInstallation(f);
  const env = { PATH: [f.shim, first.bin, f.activeBin].join(":") };
  assert.equal(resolved(f, env).command, first.command);
  assert.equal(f.run(["resume", "saved-id"], { env }).status, 0);
});

test("an old npm alias beside current Node is not mistaken for a current npm installation", posixOnly, (t) => {
  const f = fixture(t);
  const js = installNodeCodex(f);
  const brew = brewInstallation(f);
  fs.rmSync(f.activeCodex);
  fs.symlinkSync(js, f.activeCodex);
  const env = { PATH: [f.shim, brew.bin, f.activeBin].join(":") };
  assert.equal(resolved(f, env).command, brew.command);
  assert.equal(f.run(["--version"], { env }).status, 0);
});

test("setup and doctor use the same resolver and retain a Homebrew public symlink across upgrades", posixOnly, (t) => {
  const f = fixture(t);
  const old = brewInstallation(f);
  fs.rmSync(f.activeCodex);
  const env = { PATH: [f.shim, old.bin, f.activeBin].join(":") };
  setupEnvironment(f, env, () => {
    const setup = installCodexWrapper({ force: false });
    assert.equal(setup.ok, true);
    assert.equal(setup.originalCommand, old.command);
    const before = diagnoseCodex();
    assert.equal(before.unifiedResolver, true);
    assert.equal(before.resolvedOriginalCommand, old.command);
    assert.equal(before.installation.target, old.target);
    assert.equal(before.installation.node, null);
    fs.rmSync(old.command);
    const next = brewInstallation(f, "homebrew", "Caskroom", "0.161.0");
    fs.rmSync(path.join(old.prefix, "Caskroom", "codex", "0.160.0"), { recursive: true });
    const after = diagnoseCodex();
    assert.equal(after.resolvedOriginalCommand, next.command);
    assert.equal(after.installation.target, next.target);
    assert.equal(after.installation.kind, "homebrew");
    assert.equal(after.installation.target, resolved(f, env).target);
    assert.equal(f.run(["--version"], { env }).stdout.startsWith("release:0.161.0\n"), true);
    assert.equal(fs.existsSync(next.log), false);
  });
});

test("old saved Caskroom and Cellar version paths recover through stable entries even outside PATH", posixOnly, (t) => {
  for (const family of ["Caskroom", "Cellar"]) {
    const f = fixture(t);
    const old = brewInstallation(f, "brew-" + family, family);
    fs.writeFileSync(f.wrapper, codexWrapperScript(old.target, f.oldRunner), { mode: 0o755 });
    fs.rmSync(f.activeCodex);
    fs.rmSync(old.command);
    const next = brewInstallation(f, "brew-" + family, family, "0.161.0");
    fs.rmSync(path.join(old.prefix, family, "codex", "0.160.0"), { recursive: true });
    const installation = resolved(f);
    assert.equal(installation.command, next.command);
    assert.equal(installation.target, next.target);
    assert.equal(installation.source, "saved");
    assert.equal(installation.node, "");
    const launch = f.run(["--version"]);
    assert.equal(launch.status, 0, launch.stderr);
    assert.match(launch.stdout, /^release:0\.161\.0\n/);
    assert.doesNotMatch(launch.stderr, /npm install|another Node/);
  }
});

test("Homebrew updates always use the owning brew when another brew or npm is on PATH", posixOnly, (t) => {
  const f = fixture(t);
  const owner = brewInstallation(f, "owner-brew");
  const other = brewInstallation(f, "other-brew");
  fs.rmSync(f.activeCodex);
  fs.writeFileSync(f.wrapper, codexWrapperScript(owner.command, f.oldRunner), { mode: 0o755 });
  const env = { ...mockNpm(f), PATH: [f.shim, f.activeBin, other.bin].join(":") };
  // Keep the owner's Codex on PATH, but deliberately select a different brew.
  const alias = path.join(f.root, "owner-alias");
  fs.mkdirSync(alias);
  fs.symlinkSync(owner.command, path.join(alias, "codex"));
  env.PATH = [f.shim, alias, f.activeBin, other.bin].join(":");
  assert.equal(resolved(f, env).scopedUpdate, "1");
  const notice = f.run(["--version"], { env });
  const command = notice.stderr.split("\n").find((line) => line.startsWith("To update this installation"))?.split(" or: ")[1];
  assert.ok(command, notice.stderr);
  const copied = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(copied.status, 0, copied.stderr);
  assert.equal(fs.readFileSync(owner.log, "utf8"), "upgrade\n--cask\ncodex\n");
  fs.rmSync(owner.log);
  assert.equal(f.run(["update"], { env }).status, 0);
  assert.equal(fs.readFileSync(owner.log, "utf8"), "upgrade\n--cask\ncodex\n");
  assert.equal(fs.existsSync(other.log), false);
  assert.equal(fs.existsSync(env.AI_BATTERY_TEST_NPM_LOG), false);
});

test("a stale npm alias with no owning Node is skipped in favor of Homebrew", posixOnly, (t) => {
  const f = fixture(t);
  const js = installNodeCodex(f);
  const brew = brewInstallation(f);
  fs.rmSync(f.activeCodex);
  fs.rmSync(path.join(f.oldBin, "node"));
  const alias = path.join(f.root, "stale-alias");
  fs.mkdirSync(alias);
  fs.symlinkSync(js, path.join(alias, "codex"));
  const env = { PATH: [f.shim, alias, brew.bin, f.activeBin].join(":") };
  assert.equal(resolved(f, env).command, brew.command);
  assert.equal(f.run(["--version"], { env }).status, 0);
});

test("Homebrew can be found through its declared prefix without Node, npm or a Codex on PATH", posixOnly, (t) => {
  const f = fixture(t);
  const brew = brewInstallation(f);
  fs.rmSync(f.activeCodex);
  fs.rmSync(f.oldCodex);
  fs.rmSync(path.join(f.oldBin, "node"));
  const env = { PATH: f.shim, HOMEBREW_PREFIX: brew.prefix };
  const installation = resolved(f, env);
  assert.equal(installation.kind, "homebrew");
  assert.equal(installation.source, "stable");
  assert.equal(installation.node, "");
  assert.equal(f.run(["resume", "saved-id"], { env }).status, 0);
});

test("standalone symlinks follow replacement targets without Node and keep native update handling", posixOnly, (t) => {
  const f = fixture(t);
  const bin = path.join(f.root, "standalone", "bin");
  fs.mkdirSync(bin, { recursive: true });
  // A compiled executable proves this path needs no Node interpreter on PATH.
  const command = path.join(bin, "codex");
  fs.symlinkSync(process.execPath, command);
  fs.writeFileSync(f.wrapper, codexWrapperScript(command, f.oldRunner), { mode: 0o755 });
  const env = { PATH: f.shim, CODEX_MANAGED_BY_NPM: "1", CODEX_MANAGED_PACKAGE_ROOT: "/wrong/npm/package" };
  assert.equal(resolved(f, env).kind, "standalone");
  assert.equal(resolved(f, env).node, "");
  const launch = f.run(["-e", "require('node:fs').writeSync(1, JSON.stringify({owner:process.env.CODEX_MANAGED_BY_NPM,root:process.env.CODEX_MANAGED_PACKAGE_ROOT}))"], { env });
  assert.equal(launch.status, 0, launch.stderr);
  assert.deepEqual(JSON.parse(launch.stdout), {});
  fs.rmSync(command);
  const next = f.command(bin, "new-codex", 'printf "native-arg:%s\\n" "$@"');
  fs.symlinkSync(path.basename(next), command);
  const update = f.run(["update"], { env });
  assert.equal(update.status, 0, update.stderr);
  assert.equal(update.stdout, "native-arg:update\n");
  assert.doesNotMatch(update.stderr, /npm install|upgrade --cask|another Node/);
});

test("unrecognized Node launchers retain their own updater instead of being classified as npm", posixOnly, (t) => {
  const f = fixture(t);
  const bin = path.join(f.root, "custom-manager", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "codex"), "#!/usr/bin/env node\nrequire('node:fs').writeSync(1, JSON.stringify(process.argv.slice(2)));", { mode: 0o755 });
  f.command(f.activeBin, "node", "exec " + shellQuote(process.execPath) + ' "$@"');
  fs.rmSync(f.activeCodex);
  const env = { PATH: [f.shim, bin, f.activeBin].join(":") };
  assert.equal(resolved(f, env).kind, "node");
  assert.equal(resolved(f, env).scopedUpdate, "0");
  const result = f.run(["update"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["update"]);
});

test("unrecognized launchers preserve Node shebang options", posixOnly, (t) => {
  const f = fixture(t);
  const bin = path.join(f.root, "custom-launcher");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "codex"), "#!" + process.execPath + " --no-warnings\nrequire('node:fs').writeSync(1, JSON.stringify({flags:process.execArgv,args:process.argv.slice(2)}));", { mode: 0o755 });
  fs.rmSync(f.activeCodex);
  const env = { PATH: [f.shim, bin, f.activeBin].join(":") };
  const result = f.run(["update"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { flags: ["--no-warnings"], args: ["update"] });
});

test("missing Codex can be installed with Homebrew by explicit selection when npm is absent", terminalOnly, (t) => {
  const f = fixture(t);
  fs.rmSync(f.oldCodex);
  fs.rmSync(f.activeCodex);
  forwardingRunner(f);
  const pending = f.command(f.activeBin, "pending-codex", "printf '%s\\n' installed-with-brew");
  const log = path.join(f.root, "brew-installs");
  f.command(f.activeBin, "brew", [
    'printf "%s\\n" "$@" >> ' + shellQuote(log),
    "/bin/mv " + shellQuote(pending) + " " + shellQuote(f.activeCodex)
  ].join("\n"));
  const result = runInTerminal(f, [], { choices: ["2"] });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /installed-with-brew/);
  assert.doesNotMatch(result.stdout, /1\) Install using the current npm/);
  assert.equal(fs.readFileSync(log, "utf8"), "install\n--cask\ncodex\n");
});

test("installer switching preserves the resume directory, Codex home and arguments", terminalOnly, (t) => {
  const f = fixture(t);
  const brew = brewInstallation(f);
  installNodeCodex(f, f.activeBin);
  forwardingRunner(f);
  const cwd = path.join(f.root, "project");
  fs.mkdirSync(cwd);
  const env = { PATH: [f.shim, brew.bin, f.activeBin].join(":"), CODEX_HOME: path.join(f.root, "shared-state") };
  assert.equal(resolved(f, env).kind, "npm");
  fs.rmSync(f.activeCodex);
  const result = runInTerminal(f, ["resume", "existing-id"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Using Homebrew Codex/);
  assert.match(result.stdout, /arg:resume\narg:existing-id\n/);
  assert.equal(result.stdout.includes("cwd:" + cwd), true);
  assert.equal(result.stdout.includes("codex-home:" + env.CODEX_HOME), true);
  assert.doesNotMatch(result.stdout, /check_for_update_on_startup=false|Choice \[/);
});

test("npm installs outside nvm scope updates to their package prefix using the available Node and npm", posixOnly, (t) => {
  const f = fixture(t);
  const prefix = path.join(f.root, "custom-global-prefix");
  const bin = path.join(prefix, "bin");
  fs.mkdirSync(bin, { recursive: true });
  installNodeCodex(f, bin);
  // This npm prefix has no Node or npm of its own. Use the current runtime's
  // npm CLI while still explicitly updating the selected package prefix.
  fs.rmSync(path.join(bin, "node"));
  fs.rmSync(f.activeCodex);
  f.command(f.activeBin, "node", "exec " + shellQuote(process.execPath) + ' "$@"');
  const npmCli = path.join(f.activeBin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const log = path.join(f.root, "custom-prefix-update.json");
  fs.mkdirSync(path.dirname(npmCli), { recursive: true });
  fs.writeFileSync(npmCli, "require('node:fs').writeFileSync(" + JSON.stringify(log) + ",JSON.stringify(process.argv.slice(2)));\n");
  const env = { ...mockNpm(f), PATH: [f.shim, bin, f.activeBin].join(":") };
  const installation = resolved(f, env);
  assert.equal(installation.kind, "npm");
  assert.equal(installation.node, path.join(f.activeBin, "node"));
  assert.equal(installation.prefix, prefix);
  assert.equal(installation.scopedUpdate, "1");
  const update = f.run(["update"], { env });
  assert.equal(update.status, 0, update.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(log, "utf8")), ["install", "-g", "--prefix", prefix, "@openai/codex@latest"]);
  assert.equal(fs.existsSync(env.AI_BATTERY_TEST_NPM_LOG), false);
});

test("a native Codex in a former nvm directory remains usable without its Node", terminalOnly, (t) => {
  const f = fixture(t);
  fs.rmSync(f.activeCodex);
  fs.rmSync(path.join(f.oldBin, "node"));
  const installation = resolved(f);
  assert.equal(installation.kind, "standalone");
  assert.equal(installation.node, "");
  const result = runInTerminal(f, []);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /No usable runner is available/);
  assert.match(result.stdout, /\nold\n$/);
  assert.doesNotMatch(result.stdout, /another Node installation|check_for_update_on_startup|Choice \[/);
});

test("an orphaned Homebrew installation stays usable but does not send updates to another installer", posixOnly, (t) => {
  const f = fixture(t);
  const brew = brewInstallation(f);
  fs.rmSync(f.activeCodex);
  fs.rmSync(brew.brew);
  const env = { ...mockNpm(f), PATH: [f.shim, brew.bin, f.activeBin].join(":") };
  assert.equal(f.run(["--version"], { env }).status, 0);
  const update = f.run(["update"], { env });
  assert.equal(update.status, 127);
  assert.match(update.stderr, /Restore Homebrew/);
  assert.equal(fs.existsSync(env.AI_BATTERY_TEST_NPM_LOG), false);
  assert.equal(fs.existsSync(brew.log), false);
});

test("even current-Node Codex scopes updates when PATH selects a different npm", terminalOnly, (t) => {
  const f = fixture(t);
  installNodeCodex(f, f.activeBin);
  forwardingRunner(f);
  const alias = path.join(f.root, "competing-npm");
  fs.mkdirSync(alias);
  const wrongLog = path.join(f.root, "wrong-npm-calls");
  f.command(alias, "npm", 'printf "%s\\n" "$@" >> ' + shellQuote(wrongLog) + "\nexit 97");
  mockNpm(f);
  const prefix = path.dirname(f.activeBin);
  const npmCli = path.join(prefix, "lib/node_modules/npm/bin/npm-cli.js");
  const log = path.join(f.root, "current-owner-npm.json");
  fs.mkdirSync(path.dirname(npmCli), { recursive: true });
  fs.writeFileSync(npmCli, "require('node:fs').writeFileSync(" + JSON.stringify(log) + ",JSON.stringify(process.argv.slice(2)));\n");
  const env = { PATH: [f.shim, alias, f.activeBin].join(":") };
  assert.equal(resolved(f, env).scopedUpdate, "1");
  const launch = runInTerminal(f, ["resume", "same-id"], { env });
  assert.equal(launch.status, 23, launch.stderr + launch.stdout);
  assert.doesNotMatch(launch.stdout, /another Node installation/);
  const payload = JSON.parse(launch.stdout.trim().split("\n").at(-1));
  assert.deepEqual(payload.args, ["-c", "check_for_update_on_startup=false", "resume", "same-id"]);
  const update = f.run(["update"], { env });
  assert.equal(update.status, 0, update.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(log, "utf8")), ["install", "-g", "--prefix", prefix, "@openai/codex@latest"]);
  assert.equal(fs.existsSync(wrongLog), false);
});

test("setup treats an unmanaged ~/.local/bin/codex as a standalone original and leaves it intact", posixOnly, (t) => {
  const f = fixture(t);
  const home = path.join(f.root, "home");
  const bin = path.join(home, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const native = f.command(bin, "codex", "printf '%s\\n' standalone-original");
  const before = fs.readFileSync(native, "utf8");
  fs.rmSync(f.activeCodex);
  setupEnvironment(f, { PATH: [bin, f.activeBin].join(":"), AI_BATTERY_SHIM_DIR: "" }, () => {
    const installed = installCodexWrapper({ force: false });
    assert.equal(installed.ok, true);
    assert.equal(installed.originalCommand, native);
    assert.notEqual(installed.wrapperPath, native);
    assert.equal(fs.readFileSync(native, "utf8"), before);
    process.env.PATH = [path.dirname(installed.wrapperPath), bin, f.activeBin].join(":");
    const diagnostic = diagnoseCodex();
    assert.equal(diagnostic.installation.kind, "standalone");
    assert.equal(diagnostic.installation.command, native);
  });
});
