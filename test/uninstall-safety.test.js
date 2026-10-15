import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupBatteryArtifacts } from "../lib/core/uninstall.js";
import { createIntegrationFiles } from "../lib/core/integration-files.js";
import { createMacHudPlatform } from "../lib/platforms/macos/hud.js";
import { windowsAutostartCleanupScript } from "../lib/platforms/windows/autostart-cleanup.js";

const CLI = fileURLToPath(new URL("../bin/ai-battery.js", import.meta.url));
const posix = { skip: process.platform === "win32" };
const config = { version: 1, providers: { codex: true, claude: true }, codexWrapper: null, codexStatusLineBackup: null, claudeStatusLineBackup: null };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-uninstall-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const data = path.join(root, "data");
  const codex = path.join(home, ".codex");
  const claude = path.join(home, ".claude");
  const temp = path.join(root, "tmp");
  for (const directory of [home, state, data, codex, claude, temp]) fs.mkdirSync(directory, { recursive: true });
  function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; }
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codex,
    LOCALAPPDATA: path.join(root, "localappdata"), APPDATA: path.join(root, "appdata"), TEMP: temp, TMP: temp, TMPDIR: temp,
    PATH: [path.dirname(process.execPath), ...(process.platform === "win32" ? [path.join(process.env.SystemRoot, "System32"), path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0")] : ["/usr/bin", "/bin"])].join(path.delimiter),
    AI_BATTERY_STATE_DIR: state, AI_BATTERY_DATA_DIR: data, AI_BATTERY_SHARED_USAGE_STATE_DIR: path.join(root, "shared"),
    AI_BATTERY_RC: path.join(home, ".bashrc"), AI_BATTERY_SKIP_WINDOWS_PATH_WRITE: "1" };
  const clean = roots => cleanupBatteryArtifacts({ roots, home, protectedRoots: [codex, claude] });
  const run = args => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, timeout: 10000 });
  return { root, home, state, data, codex, claude, env, write, clean, run };
}

test("default Codex setup leaves commands, settings, sessions and shell files unchanged", (t) => {
  const f = fixture(t);
  const original = f.write(path.join(f.root, "original", process.platform === "win32" ? "codex.cmd" : "codex"), "original Codex launcher\n");
  f.env.PATH = path.dirname(original) + path.delimiter + f.env.PATH;
  fs.chmodSync(original, 0o755);
  const files = [
    [path.join(f.codex, "config.toml"), '# user settings\nmodel = "custom-model"\n[tui]\nstatus_line = ["context-remaining"]\n'],
    [path.join(f.codex, "sessions", "keep.jsonl"), 'resume history\n'],
    [path.join(f.claude, "settings.json"), '{"statusLine":{"type":"command","command":"my-status"},"theme":"dark"}\n'],
    [path.join(f.home, ".bashrc"), 'export MY_SETTING=keep\n'],
    [path.join(f.home, ".profile"), '# user profile\n'],
    [original, "original Codex launcher\n"]
  ];
  for (const [file, content] of files) f.write(file, content);
  const result = f.run(["setup", "codex", "--json"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).codex.standalone, true);
  for (const [file, content] of files) assert.equal(fs.readFileSync(file, "utf8"), content, file);
  assert.equal(fs.existsSync(path.join(f.data, "bin", process.platform === "win32" ? "codex.cmd" : "codex")), false);
  assert.equal(fs.existsSync(path.join(f.home, ".local", "bin", "codex")), false);
  assert.equal(fs.existsSync(path.join(f.state, "config.json")), false);
});

test("cleanup removes owned caches and runtimes while retaining unrelated files", (t) => {
  const f = fixture(t);
  const owned = [
    f.write(path.join(f.state, "config.json"), JSON.stringify(config)),
    f.write(path.join(f.state, "codex-status-scan-cache.json"), "{}"),
    f.write(path.join(f.state, "codex-status-scan-cache.json.123.456.abc.tmp"), "partial"),
    f.write(path.join(f.state, "claude-statusline-sessions", "one.json"), '{"provider":"claude"}'),
    f.write(path.join(f.data, "runtimes", "node-v24.21.0-win-x64", "node.exe"), "private display runtime"),
    f.write(path.join(f.data, "bin", "rowpty.exe"), "private display host")
  ];
  const keep = f.write(path.join(f.state, "notes.txt"), "user notes\n");
  const result = f.clean([f.state, f.data]);
  assert.deepEqual(result.errors, []);
  for (const file of owned) assert.equal(fs.existsSync(file), false, file);
  assert.equal(fs.readFileSync(keep, "utf8"), "user notes\n");
  assert.ok(result.retained.includes(keep));
  assert.equal(fs.existsSync(f.data), false);
});

test("cleanup never traverses symlinks into provider settings or shared roots", posix, (t) => {
  const f = fixture(t);
  const settings = f.write(path.join(f.codex, "config.json"), JSON.stringify(config));
  const target = f.write(path.join(f.codex, "codex-status-scan-cache.json"), "keep this user data");
  fs.symlinkSync(target, path.join(f.state, "codex-status-scan-cache.json"));
  fs.symlinkSync(f.codex, path.join(f.data, "runtimes"), "dir");
  const result = f.clean([f.state, f.data, f.codex, f.home, f.root]);
  assert.equal(fs.readFileSync(target, "utf8"), "keep this user data");
  assert.equal(fs.readFileSync(settings, "utf8"), JSON.stringify(config));
  assert.equal(result.errors.length, 3);
  assert.equal(fs.lstatSync(path.join(f.data, "runtimes")).isSymbolicLink(), true);
});

test("recovery records and foreign config.json files survive cleanup", (t) => {
  const f = fixture(t);
  const recovery = f.write(path.join(f.state, "config.json"), JSON.stringify({ ...config, claudeStatusLineBackup: { settingsPath: "keep" } }));
  const foreign = f.write(path.join(f.data, "config.json"), '{"mySetting":"keep"}');
  const result = f.clean([f.state, f.data]);
  assert.ok(result.retained.includes(recovery));
  assert.ok(result.retained.includes(foreign));
  assert.equal(fs.readFileSync(foreign, "utf8"), '{"mySetting":"keep"}');
  assert.ok(JSON.parse(fs.readFileSync(recovery)).claudeStatusLineBackup);
});

test("foreign recovery metadata aborts integration changes", (t) => {
  const f = fixture(t);
  const foreign = f.write(path.join(f.state, "config.json"), '{"mySetting":"keep"}');
  const shell = f.write(path.join(f.home, ".bashrc"), "keep shell\n");
  const result = f.run(["uninstall", "codex", "claude", "--json"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ownership could not be verified/);
  assert.equal(fs.readFileSync(foreign, "utf8"), '{"mySetting":"keep"}');
  assert.equal(fs.readFileSync(shell, "utf8"), "keep shell\n");
});

function installedFixture(t, local = false) {
  const f = fixture(t);
  const prefix = path.join(f.root, local ? "project" : "npm-prefix");
  const root = path.join(prefix, ...(!local && process.platform !== "win32" ? ["lib"] : []), "node_modules", "ai-battery");
  const source = path.dirname(path.dirname(CLI));
  fs.mkdirSync(root, { recursive: true });
  for (const name of ["lib", "bin"]) fs.cpSync(path.join(source, name), path.join(root, name), { recursive: true });
  const manifest = f.write(path.join(root, "package.json"), JSON.stringify({ name: "ai-battery", version: "0.1.22", type: "module", bin: { "ai-battery": "bin/ai-battery.js" } }));
  const hudLog = path.join(f.root, "hud-calls.jsonl");
  // Keep desktop operations isolated from the user's HUD and autostart settings.
  f.write(path.join(root, "bin", "ai-battery-hud.js"), `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(hudLog)}, JSON.stringify(process.argv.slice(2)) + String.fromCharCode(10));`);
  f.write(path.join(f.state, "config.json"), JSON.stringify(config));
  f.write(path.join(f.state, "codex-status-scan-cache.json"), "{}");
  const keep = [
    [manifest, fs.readFileSync(manifest, "utf8")],
    [path.join(f.codex, "config.toml"), 'model = "keep-model"\n'],
    [path.join(f.claude, "settings.json"), '{"theme":"keep"}'],
    [path.join(f.home, ".bashrc"), "keep shell\n"],
    [path.join(path.dirname(root), "@openai", "codex", "package.json"), '{"name":"@openai/codex","version":"1.0.0"}'],
    [path.join(path.dirname(root), "@anthropic-ai", "claude-code", "package.json"), '{"name":"@anthropic-ai/claude-code","version":"1.0.0"}'],
    [path.join(prefix, process.platform === "win32" ? "codex.cmd" : "bin/codex"), "keep original launcher"]
  ];
  if (local) {
    keep.push([path.join(prefix, "package.json"), '{"dependencies":{"ai-battery":"*","other-package":"*"}}']);
    keep.push([path.join(prefix, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}']);
  }
  for (const [file, text] of keep) f.write(file, text);
  const run = args => spawnSync(process.execPath, [path.join(root, "bin", "ai-battery.js"), ...args], { encoding: "utf8", env: f.env, timeout: 30000 });
  return { ...f, root, prefix, keep, hudLog, run };
}

for (const args of [["reset", "settings"], ["reset", "config"], ["uninstall"], ["teardown"]]) {
  test(`${args.join(" ")} restores settings and cleans owned state while retaining npm packages`, (t) => {
    const f = installedFixture(t);
    const retained = f.write(path.join(f.home, "custom-integration"), "keep custom file");
    f.write(path.join(f.state, "config.json"), JSON.stringify({ ...config, integrationFiles: {
      [retained]: { beforeText: "original", installedText: "keep custom file", block: "unknown integration" }
    } }));
    const blocked = f.run([...args, "--json"]);
    assert.equal(blocked.status, 1, blocked.stderr + blocked.stdout);
    assert.match(blocked.stdout, /Unrestored integration files/);
    assert.equal(fs.existsSync(f.root), true);
    assert.equal(fs.readFileSync(retained, "utf8"), "keep custom file");
    assert.ok(JSON.parse(fs.readFileSync(path.join(f.state, "config.json"))).integrationFiles[retained]);
    f.write(path.join(f.state, "config.json"), JSON.stringify(config));
    const result = f.run([...args, "--json"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.fullReset, true);
    assert.equal(report.results.package, undefined);
    assert.equal(fs.existsSync(f.root), true);
    assert.equal(fs.existsSync(f.state), false);
    for (const [file, text] of f.keep) assert.equal(fs.readFileSync(file, "utf8"), text, file);
    if (args[0] === "reset") {
      const again = f.run(args);
      assert.equal(again.status, 0, again.stderr);
      assert.match(again.stdout, /npm package.*unchanged/);
      assert.match(again.stdout, /npm uninstall -g ai-battery/);
    }
  });
}

test("reset settings never changes a local npm project or its lockfile", (t) => {
  const f = installedFixture(t, true);
  const result = f.run(["reset", "settings", "--json"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  for (const [file, text] of f.keep) assert.equal(fs.readFileSync(file, "utf8"), text, file);
});

test("HUD targets are parsed as reset targets rather than the HUD start command", (t) => {
  for (const args of [["reset", "settings", "hud"], ["reset", "config", "hud"], ["uninstall", "hud"], ["teardown", "hud"]]) {
    const f = installedFixture(t);
    const result = f.run([...args, "--json"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.targets, ["hud"]);
    assert.equal(report.fullReset, false);
    assert.deepEqual(fs.readFileSync(f.hudLog, "utf8").trim().split("\n").map(line => JSON.parse(line)), [["stop"], ["autostart", "off"]]);
    assert.equal(fs.existsSync(path.join(f.state, "config.json")), true);
  }
});

test("reset requires an explicit settings/config scope and rejects command-like targets without side effects", (t) => {
  const f = fixture(t);
  const file = f.write(path.join(f.state, "config.json"), JSON.stringify(config));
  const before = fs.readFileSync(file, "utf8");
  for (const args of [["reset"], ["reset", "everything"], ["reset", "settings", "on"], ["reset", "settings", "show"]]) {
    const result = f.run(args);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
  const help = f.run(["reset", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /ai-battery reset settings/);
});

test("Bash reproduces a cached deleted shim and hash -r restores the original command", posix, (t) => {
  const f = fixture(t);
  const shim = f.write(path.join(f.data, "bin", "codex"), "#!/bin/sh\nprintf 'wrapper\\n'\n");
  const original = f.write(path.join(f.root, "original", "codex"), "#!/bin/sh\nprintf 'original\\n'\n");
  fs.chmodSync(shim, 0o755); fs.chmodSync(original, 0o755);
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", 'codex; /bin/rm -- "$SHIM"; codex; cached=$?; hash -r; codex; test "$cached" = 127'], {
    encoding: "utf8", env: { ...f.env, SHIM: shim, PATH: [path.dirname(shim), path.dirname(original)].join(":") }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "wrapper\noriginal\n");
  assert.match(result.stderr, /No such file or directory/);
});

test("custom tmux files are restored even without the original environment override", posix, (t) => {
  const f = fixture(t);
  const file = f.write(path.join(f.home, "custom tmux.conf"), 'set -g mouse on');
  f.env.AI_BATTERY_TMUX_CONF = file;
  assert.equal(f.run(["setup", "tmux", "--json"]).status, 0);
  delete f.env.AI_BATTERY_TMUX_CONF;
  const result = f.run(["uninstall", "tmux", "--json"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(fs.readFileSync(file, "utf8"), 'set -g mouse on');
});

test("custom shell files are restored from recovery metadata without the old override", posix, (t) => {
  const f = fixture(t);
  const file = f.write(path.join(f.home, "custom shellrc"), "original without newline");
  const block = "\n# >>> ai-battery setup >>>\nexport PATH='/owned/bin':$PATH\n# <<< ai-battery setup <<<\n";
  const installed = fs.readFileSync(file, "utf8") + block;
  f.write(file, installed);
  f.write(path.join(f.state, "config.json"), JSON.stringify({ ...config, integrationFiles: {
    [file]: { beforeText: "original without newline", installedText: installed, block, target: fs.realpathSync(file) }
  } }));
  const result = f.run(["uninstall", "codex", "--json"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(fs.readFileSync(file, "utf8"), "original without newline");
});

function integrationFixture(t) {
  const f = fixture(t);
  let stored = structuredClone(config);
  const manager = createIntegrationFiles({
    readConfig: () => structuredClone(stored), writeConfig: value => { stored = structuredClone(value); },
    writeTextAtomic: (file, text, mode) => fs.writeFileSync(file, text, { mode })
  });
  const file = path.join(f.home, ".bashrc");
  const block = "\n# >>> ai-battery setup >>>\nexport AI_BATTERY=1\n# <<< ai-battery setup <<<\n";
  const install = () => {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const base = manager.stripOwnedBlock(file, current, text => text);
    manager.installManagedText(file, base + block, block);
  };
  return { ...f, manager, file, block, install, records: () => stored.integrationFiles || {} };
}

test("shell/tmux text restoration preserves exact bytes, mode and original absence", (t) => {
  const f = integrationFixture(t);
  for (const original of [null, "", "user setting without newline", "user\r\n\r\n", "user\n\n\n"]) {
    if (original === null) fs.rmSync(f.file, { force: true });
    else { f.write(f.file, original); fs.chmodSync(f.file, 0o640); }
    f.install();
    f.install();
    f.manager.removeManagedText(f.file, () => { throw new Error("expected recovery record"); });
    assert.equal(fs.existsSync(f.file), original !== null);
    if (original !== null) {
      assert.equal(fs.readFileSync(f.file, "utf8"), original);
      if (process.platform !== "win32") assert.equal(fs.statSync(f.file).mode & 0o777, 0o640);
    }
    assert.deepEqual(f.records(), {});
  }
});

test("user edits outside the block survive uninstall and repeated setup", (t) => {
  const f = integrationFixture(t);
  f.write(f.file, "original\n");
  f.install();
  fs.appendFileSync(f.file, "user edit\n");
  f.install();
  f.manager.removeManagedText(f.file, text => text);
  assert.equal(fs.readFileSync(f.file, "utf8"), "original\nuser edit\n");
});

test("edited managed blocks are preserved with their recovery records", (t) => {
  const f = integrationFixture(t);
  f.write(f.file, "original");
  f.install();
  const edited = fs.readFileSync(f.file, "utf8").replace("AI_BATTERY=1", "AI_BATTERY=custom");
  f.write(f.file, edited);
  assert.throws(() => f.manager.removeManagedText(f.file, text => text), /block was edited/);
  assert.throws(f.install, /block was edited/);
  assert.equal(fs.readFileSync(f.file, "utf8"), edited);
  assert.ok(f.records()[f.file]);
});

test("symlink replacement never redirects integration restoration into another file", posix, (t) => {
  const f = integrationFixture(t);
  for (const original of [null, "original"]) {
    fs.rmSync(f.file, { force: true });
    if (original !== null) f.write(f.file, original);
    f.install();
    fs.unlinkSync(f.file);
    const target = f.write(path.join(f.home, "other-file"), "user content");
    fs.symlinkSync(target, f.file);
    assert.throws(() => f.manager.removeManagedText(f.file, text => text), /target changed/);
    assert.equal(fs.readFileSync(target, "utf8"), "user content");
    assert.ok(f.records()[f.file]);
    fs.unlinkSync(f.file);
    f.manager.removeManagedText(f.file, text => text);
  }
});

test("macOS autostart removes owned agents and refuses foreign or symlinked files", (t) => {
  const f = fixture(t);
  const calls = [];
  const platform = createMacHudPlatform({ home: f.home, scriptDir: path.dirname(CLI), runLaunchctl: args => calls.push(args) });
  const file = platform.macAutostartEnable({ interval: 2, provider: "all" });
  assert.match(fs.readFileSync(file, "utf8"), /ai-battery-hud\.js/);
  platform.macAutostartDisable();
  assert.equal(fs.existsSync(file), false);
  const foreign = f.write(file, '<plist><dict><key>Label</key><string>user-job</string></dict></plist>');
  const count = calls.length;
  assert.throws(platform.macAutostartDisable, /ownership/);
  assert.throws(() => platform.macAutostartEnable({ interval: 2, provider: "all" }), /ownership/);
  assert.match(fs.readFileSync(foreign, "utf8"), /user-job/);
  assert.equal(calls.length, count);
});

test("Windows autostart cleanup preserves unrelated files and registry values", { skip: process.platform !== "win32" }, (t) => {
  const f = fixture(t);
  const key = `HKCU:\\Software\\AiBatteryUninstallTest-${process.pid}-${Date.now()}`;
  const run = script => {
    const file = f.write(path.join(f.root, "script.ps1"), script);
    return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], {
      encoding: "utf8", env: { ...process.env, LOCALAPPDATA: f.data }, timeout: 10000
    });
  };
  t.after(() => run(`Remove-Item -LiteralPath '${key}' -Force -ErrorAction SilentlyContinue`));
  const auto = f.write(path.join(f.data, "ai-battery", "autostart.ps1"), "# Generated by: ai-battery hud autostart on\r\n");
  const own = f.write(path.join(f.data, "ai-battery", "hud", "main.ps1"), "# generated HUD");
  const keep = f.write(path.join(f.data, "ai-battery", "hud", "notes.txt"), "keep notes");
  const expected = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${auto}"`;
  const script = windowsAutostartCleanupScript({ registryPath: key, registryName: "AiBatteryHud" });
  assert.equal(run(`New-Item -Path '${key}' -Force | Out-Null; Set-ItemProperty -Path '${key}' -Name AiBatteryHud -Value 'unrelated command'`).status, 0);
  assert.notEqual(run(script).status, 0);
  assert.equal(fs.existsSync(auto), true);
  assert.equal(run(`Set-ItemProperty -Path '${key}' -Name AiBatteryHud -Value '${expected.replace(/'/g, "''")}'`).status, 0);
  const result = run(script);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(auto), false);
  assert.equal(fs.existsSync(own), false);
  assert.equal(fs.readFileSync(keep, "utf8"), "keep notes");
});
