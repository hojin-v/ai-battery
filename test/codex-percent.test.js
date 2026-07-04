import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeLimit, sameFilePath } from "../bin/ai-battery.js";

const CLI_PATH = fileURLToPath(new URL("../bin/ai-battery.js", import.meta.url));

test("Codex used_percent 1.0 is treated as 1%, not ratio 100%", () => {
  const primary = normalizeLimit({
    used_percent: 1.0,
    window_minutes: 300,
    resets_at: 4102444800
  });

  assert.equal(primary.usedPercent, 1);
  assert.equal(primary.remainingPercent, 99);
});

test("fractional ratio fields are still scaled to percentages", () => {
  const primary = normalizeLimit({
    utilization: 0.25,
    window_minutes: 300,
    resets_at: 4102444800
  }, {
    usedKey: "utilization"
  });

  assert.equal(primary.usedPercent, 25);
  assert.equal(primary.remainingPercent, 75);
});

test("CLI entrypoint treats npm bin symlinks as direct execution", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const linkPath = path.join(tmpDir, process.platform === "win32" ? "ai-battery.js" : "ai-battery");
  try {
    fs.symlinkSync(CLI_PATH, linkPath);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("symlink creation is unavailable");
      return;
    }
    throw error;
  }

  assert.equal(sameFilePath(CLI_PATH, linkPath), true);
});
