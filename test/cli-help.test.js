import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cliLanguage, helpText } from "../lib/core/cli-help.js";
import { createMacHudPlatform } from "../lib/platforms/macos/hud.js";

const CLI = fileURLToPath(new URL("../bin/ai-battery.js", import.meta.url));
const HUD = fileURLToPath(new URL("../bin/ai-battery-hud.js", import.meta.url));

function fixture(t, locale = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-help-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env, LANGUAGE: "", LC_ALL: "", LC_MESSAGES: "", LANG: "en_US.UTF-8", ...locale,
    HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, "codex"),
    AI_BATTERY_STATE_DIR: path.join(root, "state"), AI_BATTERY_DATA_DIR: path.join(root, "data")
  };
  const run = (args, entry = CLI) => spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", env, timeout: 10000 });
  return { root, run };
}

test("CLI follows language preferences and locale precedence with English fallback", () => {
  for (const [env, expected] of [
    [{ LANG: "ko_KR.UTF-8" }, "ko"],
    [{ LANG: "ko-KR" }, "ko"],
    [{ LANG: "ko_KR.UTF-8", LC_MESSAGES: "en_US.UTF-8" }, "en"],
    [{ LANG: "en_US.UTF-8", LC_MESSAGES: "ko_KR.UTF-8" }, "ko"],
    [{ LANG: "ko_KR.UTF-8", LC_ALL: "C.UTF-8" }, "en"],
    [{ LANG: "en_US.UTF-8", LC_ALL: "ko_KR.UTF-8" }, "ko"],
    [{ LANGUAGE: "fr:ko:en", LC_ALL: "C" }, "ko"],
    [{ LANGUAGE: "en:ko", LANG: "ko_KR.UTF-8" }, "en"],
    [{ LANGUAGE: "C:ko" }, "en"],
    [{ LANGUAGE: "", LANG: "ko_KR.UTF-8" }, "ko"],
    [{ LANG: "ja_JP.UTF-8" }, "en"]
  ]) assert.equal(cliLanguage(env, "en-US"), expected, JSON.stringify(env));
  assert.equal(cliLanguage({}, "ko-KR"), "ko");
  assert.equal(cliLanguage({}, "en-US"), "en");
});

for (const [language, marker] of [["ko", "사용법:"], ["en", "Usage:"]]) {
  test(`${language} top-level help stays compact and points to detailed help`, (t) => {
    const f = fixture(t, { LANGUAGE: language });
    const result = f.run(["-h"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, new RegExp(marker));
    assert.ok(result.stdout.includes(language === "ko" ? "명령:" : "Commands:"));
    assert.ok(result.stdout.trim().split("\n").length <= 28);
    const commands = result.stdout.split("\n")
      .filter((line) => /^  (setup|hud|on \/ off|reset|doctor)\s/.test(line))
      .map((line) => line.trim().split(/\s{2,}/)[0]);
    assert.deepEqual(commands.slice(0, 3), ["setup", "hud", "on / off"]);
    assert.doesNotMatch(result.stdout, /^  show\s/m);
    assert.match(result.stdout, /reset\s+.+/);
    assert.doesNotMatch(result.stdout, /reset settings/);
    assert.match(result.stdout, /--help/);
    assert.match(result.stdout, /ai-battery setup tmux/);
    assert.doesNotMatch(result.stdout, /ai-battery setup claude/);
    assert.doesNotMatch(result.stdout, /--wrap-codex|--configure-codex-statusline/);
    assert.deepEqual(fs.readdirSync(f.root), []);
  });

  test(`${language} no-argument invocation opens help without collecting usage`, (t) => {
    const f = fixture(t, { LANGUAGE: language });
    const result = f.run([]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, f.run(["--help"]).stdout);
    assert.deepEqual(fs.readdirSync(f.root), []);
  });

  test(`${language} command help covers detailed options without running commands`, (t) => {
    const f = fixture(t, { LANGUAGE: language });
    for (const [command, detail] of [
      ["--watch", "--bar-width"], ["setup", "--wrap-codex"], ["reset", "npm uninstall -g ai-battery"],
      ["doctor", "--json"], ["hud", "autostart"], ["on", "codex|claude|all"], ["off", "codex|claude|all"],
      ["capture-claude", "--no-header"], ["teardown", "npm uninstall -g ai-battery"],
      ["uninstall", "npm uninstall -g ai-battery"], ["install-claude-statusline", "--force"],
      ["uninstall-claude-statusline", "uninstall-claude-statusline"]
    ]) {
      const result = f.run([command, "--help"]);
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
      assert.ok(result.stdout.includes(marker), command);
      assert.ok(result.stdout.includes(detail), command);
      assert.equal(result.stderr, "");
      if (command === "reset") {
        assert.match(result.stdout, /ai-battery reset \[codex\|claude\|hud\|tmux\|all\]/);
      }
      if (command === "setup") {
        assert.doesNotMatch(result.stdout, /ai-battery-run/);
        assert.match(result.stdout, /ai-battery setup tmux/);
        assert.doesNotMatch(result.stdout, /ai-battery setup claude/);
      }
      if (command === "--watch" || command === "capture-claude") {
        assert.doesNotMatch(result.stdout, /--menu-bar|--menu-detail-image|--hud-state/);
      }
      if (command === "capture-claude") {
        assert.doesNotMatch(result.stdout, /--watch|--active-provider|--max-width|--json/);
        assert.match(result.stdout, /--left-padding/);
      }
    }
    const alias = f.run(["help", "setup"]);
    assert.equal(alias.status, 0, alias.stderr);
    assert.equal(alias.stdout, f.run(["setup", "--help"]).stdout);
    assert.deepEqual(fs.readdirSync(f.root), []);
  });

  test(`${language} invalid input gives a short, relevant help hint without side effects`, (t) => {
    const f = fixture(t, { LANGUAGE: language });
    for (const [args, hint] of [
      [["wat"], "ai-battery --help"], [["--wat"], "ai-battery --help"],
      [["show"], "ai-battery --help"], [["show", "--help"], "ai-battery --help"],
      [["help", "show"], "ai-battery --help"], [["setup", "--wat"], "ai-battery setup --help"],
      [["--provider", "wat"], "ai-battery --help"],
      [["--provider"], "ai-battery --help"], [["--provider", "--json"], "ai-battery --help"],
      [["--active-provider", "all"], "ai-battery --help"], [["--bar-width"], "ai-battery --help"],
      [["--watch", "wat"], "ai-battery --help"], [["setup", "wat"], "ai-battery setup --help"],
      [["reset", "everything"], "ai-battery reset --help"],
      [["reset", "settings", "config"], "ai-battery reset --help"],
      [["reset", "settings", "wat"], "ai-battery reset --help"], [["off", "hud"], "ai-battery off --help"],
      [["hud", "wat"], "ai-battery hud --help"]
    ]) {
      const result = f.run(args);
      assert.equal(result.status, 1, `${args}: ${result.stderr}`);
      assert.equal(result.stdout, "", args.join(" "));
      assert.equal(result.stderr.trim().split("\n").length, 1, result.stderr);
      assert.ok(result.stderr.includes(hint), result.stderr);
      if (language === "ko") assert.match(result.stderr, /[가-힣]/);
      else assert.doesNotMatch(result.stderr, /[가-힣]/);
    }
    assert.deepEqual(fs.readdirSync(f.root), []);
  });

  test(`${language} standalone HUD help works without desktop requirements`, (t) => {
    const f = fixture(t, { LANGUAGE: language });
    const result = f.run(["-h"], HUD);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(marker));
    assert.match(result.stdout, /ai-battery hud/);
    assert.equal(result.stderr, "");
    assert.deepEqual(fs.readdirSync(f.root), []);
  });
}

test("HUD help describes the platform's supported options", () => {
  const env = { LANGUAGE: "en" };
  const mac = helpText("hud", { env, platform: "darwin" });
  assert.match(mac, /--provider/);
  assert.match(mac, /--interval/);
  assert.doesNotMatch(mac, /--dock-console/);
  const linux = helpText("hud", { env, platform: "linux" });
  assert.match(linux, /Linux/);
  assert.match(linux, /--provider/);
  assert.match(linux, /--interval/);
  assert.match(linux, /--foreground/);
  assert.doesNotMatch(linux, /--dock-console|light\|dark/);
  assert.match(helpText("hud", { env, platform: "win32" }), /--dock-console/);
  assert.match(helpText("capture-claude", { env, platform: "win32" }), /--attach-hud/);
  assert.doesNotMatch(helpText("capture-claude", { env, platform: "linux" }), /--attach-hud/);
  assert.doesNotMatch(helpText("capture-claude", { env, platform: "darwin" }), /--attach-hud/);
});

test("macOS HUD rejects invalid commands before touching login startup", (t) => {
  const f = fixture(t);
  const hud = createMacHudPlatform({ home: f.root, runLaunchctl: () => assert.fail("Unexpected launchctl call") });
  const errors = [];
  const previousCode = process.exitCode;
  t.mock.method(console, "error", (message) => errors.push(message));
  t.after(() => { process.exitCode = previousCode; });
  hud.runMacHud(["autostart", "on", "wat"]);
  assert.equal(process.exitCode, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ai-battery hud --help/);
  assert.deepEqual(fs.readdirSync(f.root), []);
  process.exitCode = previousCode;
});
