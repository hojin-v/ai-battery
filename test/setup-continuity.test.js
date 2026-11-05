import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./helpers/setup-continuity.py", import.meta.url));
const cli = fileURLToPath(new URL("../bin/ai-battery.js", import.meta.url));
const available = process.platform !== "win32" && spawnSync("python3", ["--version"]).status === 0;
test("setup preserves running PTYs, cached commands, new shells and a live tmux bar", { skip: !available }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-continuity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync("python3", [helper], { env: { ...process.env, AI_BATTERY_TEST_ROOT: root,
    AI_BATTERY_TEST_CLI: cli, AI_BATTERY_TEST_NODE: process.execPath }, encoding: "utf8", timeout: 40000 });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).result, "passed");
});
