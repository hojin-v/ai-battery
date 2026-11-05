import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { errorText, messageText } from "../lib/core/cli-messages.js";
import { formatDoctorResult, formatResetResult, formatSetupResult } from "../lib/core/cli-output.js";

const CLI = fileURLToPath(new URL("../bin/ai-battery.js", import.meta.url));

function fixture(t, language = "en") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-messages-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const nativeDir = path.join(root, "bin");
  fs.mkdirSync(nativeDir);
  fs.writeFileSync(path.join(nativeDir, process.platform === "win32" ? "codex.cmd" : "codex"), process.platform === "win32" ? "@echo off\r\necho codex-fixture\r\n" : "#!/bin/sh\necho codex-fixture\n", { mode: 0o755 });
  const env = {
    ...process.env, LANGUAGE: language, LC_ALL: "", LC_MESSAGES: "", LANG: "en_US.UTF-8",
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"),
    TMUX: "", AI_BATTERY_TMUX_STATUS: "",
    AI_BATTERY_STATE_DIR: state, AI_BATTERY_DATA_DIR: path.join(root, "data"),
    AI_BATTERY_SHIM_DIR: path.join(root, "data", "bin"), AI_BATTERY_RC: path.join(home, ".bashrc"),
    AI_BATTERY_SHARED_USAGE_STATE_DIR: path.join(root, "shared"), AI_BATTERY_NO_UPDATE_CHECK: "1",
    AI_BATTERY_SKIP_WINDOWS_PATH_WRITE: "1",
    PATH: [nativeDir, path.dirname(process.execPath), ...(process.platform === "win32"
      ? [path.join(process.env.SystemRoot, "System32"), path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0")]
      : ["/usr/bin", "/bin"])].join(path.delimiter)
  };
  const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, input, timeout: 10000 });
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  return { root, home, state, env, run, write };
}

for (const language of ["en", "ko"]) {
  test(`${language} bounded status rows keep missing-provider errors short; diagnostics retain detail`, (t) => {
    const f = fixture(t, language);
    const compact = f.run(["--provider", "all", "--no-color", "--max-width", "100"]);
    assert.equal(compact.status, 0, compact.stderr);
    assert.match(compact.stdout, /Codex --%/);
    assert.match(compact.stdout, /Claude --%/);
    assert.doesNotMatch(compact.stdout, /\(|[가-힣]/);
    const detailed = f.run(["--provider", "claude", "--no-color"]);
    assert.equal(detailed.status, 0, detailed.stderr);
    assert.match(detailed.stdout, /Claude \? \(.+\)/);
    assert.equal(/[가-힣]/.test(detailed.stdout), language === "ko");
    const machine = f.run(["--provider", "claude", "--json"]);
    assert.equal(machine.status, 0, machine.stderr);
    assert.equal(JSON.parse(machine.stdout).results[0].ok, false);
    assert.ok(JSON.parse(machine.stdout).results[0].error);
  });

  test(`${language} setup, doctor, visibility and reset use concise runtime messages`, (t) => {
    const f = fixture(t, language);
    const setup = f.run(["setup", "codex"]);
    assert.equal(setup.status, 0, setup.stderr + setup.stdout);
    assert.match(setup.stdout, /Codex wrapper: ready/);
    assert.ok(setup.stdout.includes(language === "ko" ? "설정 완료." : "Setup complete."));
    assert.match(setup.stdout, /ai-battery reset/);
    const claude = f.run(["install-claude-statusline"]);
    assert.equal(claude.status, 0, claude.stderr);
    assert.match(claude.stdout, /Claude statusLine: ready/);
    assert.ok(claude.stdout.includes(language === "ko" ? "복구용으로 저장" : "saved for restore"));

    const doctor = f.run(["doctor"]);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stdout, /Update: skipped/);
    assert.match(doctor.stdout, /status_line: optional/);
    assert.match(doctor.stdout, /statusLine: ready/);
    assert.ok(doctor.stdout.includes(language === "ko" ? "상세 진단:" : "Details:"));
    assert.doesNotMatch(doctor.stdout, /wrapper is not installed|status_line is not configured/);
    assert.equal(f.run(["off", "codex"]).stdout, "codex: off\n");
    const hidden = f.run(["doctor"]);
    assert.equal(hidden.status, 0, hidden.stderr);
    assert.match(hidden.stdout, /Visibility: off/);
    assert.match(hidden.stdout, /Show: ai-battery on codex/);
    assert.match(hidden.stdout, /TUI: PATH mismatch/);
    assert.equal(f.run(["on", "codex"]).stdout, "codex: on\n");

    f.env.AI_BATTERY_WRAPPED_CODEX = "1";
    const reset = f.run(["reset", "claude"]);
    assert.equal(reset.status, 0, reset.stderr);
    assert.match(reset.stdout, /Claude statusLine: removed/);
    assert.ok(reset.stdout.includes(language === "ko" ? "복원 완료. npm 패키지는 유지됩니다." : "Settings restored. npm package unchanged."));
    assert.doesNotMatch(reset.stdout, /Exit this Codex|이 Codex 세션/);
    assert.equal(fs.existsSync(path.join(f.home, ".claude", "settings.json")), false);
  });

  test(`${language} configuration errors preserve files and use the selected language`, (t) => {
    const f = fixture(t, language);
    const config = path.join(f.state, "config.json");
    f.write(config, "{invalid");
    const result = f.run(["setup", "codex"]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(config));
    assert.ok(result.stderr.includes(language === "ko" ? "파일 유지:" : "File preserved:"));
    assert.equal(fs.readFileSync(config, "utf8"), "{invalid");
    const doctor = f.run(["doctor"]);
    assert.equal(doctor.status, 1, doctor.stdout + doctor.stderr);
    assert.ok(doctor.stderr.includes(config));
    assert.doesNotMatch(doctor.stdout, /Visibility: on|TUI: ready/);
  });

  test(`${language} invalid Claude settings are localized only in human output`, (t) => {
    const f = fixture(t, language);
    const file = path.join(f.home, ".claude", "settings.json");
    f.write(file, "{invalid");
    const human = f.run(["install-claude-statusline"]);
    assert.equal(human.status, 1, human.stderr);
    assert.match(human.stdout, /Claude statusLine: error/);
    assert.ok(human.stdout.includes(language === "ko" ? "파일 유지:" : "File preserved:"));
    assert.ok(human.stdout.includes(file));
    const machine = f.run(["install-claude-statusline", "--json"]);
    assert.equal(machine.status, 1);
    assert.match(JSON.parse(machine.stdout).error, /^Could not parse Claude settings/);
    assert.equal(fs.readFileSync(file, "utf8"), "{invalid");
  });

  test(`${language} invalid statusLine input produces an actionable error`, (t) => {
    const f = fixture(t, language);
    const result = f.run(["capture-claude"], "{invalid");
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(language === "ko" ? "JSON이 올바르지 않습니다" : "invalid JSON"));
    assert.equal(fs.existsSync(f.state), false);
  });
}

test("doctor JSON keeps the same schema and values in both locales", (t) => {
  const f = fixture(t);
  const snapshots = ["en", "ko"].map((language) => {
    f.env.LANGUAGE = language;
    const result = f.run(["doctor", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    delete data.generatedAt;
    delete data.aiBattery.updateCheck.checkedAt;
    return data;
  });
  assert.deepEqual(snapshots[0], snapshots[1]);
});

test("doctor preserves actionable failures while treating optional integrations normally", () => {
  const data = {
    aiBattery: { version: "1.0.0", latestVersion: "1.1.0", updateAvailable: true, packageName: "ai-battery", recovery: {} },
    codex: { providerEnabled: true, activeCodex: "/opt/codex", statusLine: {}, sessionsExists: true, runnerExists: true,
      notes: ["Codex wrapper is not installed. Run: ai-battery setup codex", "Codex status_line is not configured. Run: ai-battery setup codex"] },
    claude: { providerEnabled: true, statusLine: { configured: true, managed: false }, statuslineCache: false,
      notes: ["Claude statusLine belongs to another tool. AI Battery will not replace it without --force."] }
  };
  const before = structuredClone(data);
  const text = formatDoctorResult(data, { env: { LANGUAGE: "ko" } });
  assert.match(text, /1\.0\.0 → 1\.1\.0/);
  assert.match(text, /npm install -g ai-battery@latest/);
  assert.match(text, /status_line: optional/);
  assert.match(text, /statusLine: external/);
  assert.match(text, /다른 도구의 Claude statusLine/);
  assert.match(text, /ai-battery setup claude --force/);
  assert.match(text, /Visibility: on/);
  assert.match(text, /TUI: not configured/);
  assert.match(text, /ai-battery setup codex/);
  assert.deepEqual(data, before);
});

test("failed setup and reset retain error context and recovery paths", () => {
  const env = { LANGUAGE: "ko" };
  const file = "/사용자 설정/기존.json";
  const reason = `AI Battery integration block was edited; kept the file and recovery record: ${file}`;
  const setup = formatSetupResult({ claude: { skipped: true, error: reason, settingsPath: file } }, { failed: true, env });
  assert.match(setup, /설정 미완료/);
  assert.ok(setup.includes(file));
  assert.match(setup, /복구 기록 유지/);
  const reset = formatResetResult({ targets: ["claude"], results: { claude: { error: reason, settingsPath: file }, recovery: { error: "Unrestored integration files remain; kept recovery metadata", paths: [file] } } }, { failed: true, env });
  assert.match(reset, /복원 미완료/);
  assert.match(reset, /Recovery pending:/);
  assert.ok(reset.includes(file));
  assert.doesNotMatch(reset, /복원 완료|패키지 삭제/);
});

test("message translation preserves paths, technical details and unknown external output", () => {
  const env = { LANGUAGE: "ko" };
  const file = "C:\\Users\\사용자 이름\\config.json";
  assert.ok(messageText(`AI Battery config is invalid and was left untouched: ${file}`, env).endsWith(file));
  const detail = "EACCES: permission denied, open '/a path/settings.json'";
  assert.ok(errorText(Object.assign(new Error(detail), { code: "EACCES" }), env).startsWith(detail));
  assert.match(errorText(Object.assign(new Error(detail), { code: "EACCES" }), env), /접근 권한/);
  assert.equal(messageText("HTTP 503 · external tool error", env), "HTTP 503 · external tool error");
  assert.equal(messageText("AI Battery config is invalid and was left untouched: /tmp/file", { LANGUAGE: "ja" }), "Invalid AI Battery config JSON. File preserved: /tmp/file");
});
