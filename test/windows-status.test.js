import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { StatusLine, parseArgs } from "../bin/ai-battery-run-win.js";

async function waitFor(predicate) {
  const deadline = performance.now() + 6000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "status poll did not reach the expected state");
    await delay(20);
  }
}

function fixture(t, initial = "Codex 79%") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-battery-win-status-"));
  const modePath = path.join(root, "mode");
  const meterPath = path.join(root, "meter.mjs");
  fs.writeFileSync(meterPath, [
    'import fs from "node:fs";',
    'import { setTimeout as delay } from "node:timers/promises";',
    'const mode = fs.readFileSync(process.argv[2], "utf8");',
    'if (mode === "slow") await delay(1800);',
    'if (mode === "hang") { console.log("partial"); await delay(60000); }',
    'if (mode === "fail") { console.log("partial"); process.exit(3); }',
    'if (mode === "large") console.log("x".repeat(128 * 1024));',
    'else if (mode !== "empty") console.log(mode === "slow" ? "Codex 79%" : mode);'
  ].join("\n"));
  fs.writeFileSync(modePath, initial);
  const status = new StatusLine({ interval: 2, barWidth: "10", leftPadding: 2, provider: "all" }, "codex", {
    command: [process.execPath, meterPath, modePath]
  });
  status.onRefresh = () => {};
  t.after(async () => {
    const child = status.refreshChild;
    status.dispose();
    if (child) await waitFor(() => child.exitCode !== null || child.signalCode !== null);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { status, mode: (value) => fs.writeFileSync(modePath, value) };
}

test("Windows status defaults to a two-second poll interval", () => {
  if (process.env.AI_BATTERY_INTERVAL || process.env.CLAUDEX_BATTERY_INTERVAL) return;
  assert.equal(parseArgs(["codex"]).interval, 2);
});

test("Windows status accepts slow usage polls without overlapping requests", async (t) => {
  const { status } = fixture(t, "slow");
  status.kickRefresh(true);
  const child = status.refreshChild;
  status.kickRefresh(false);
  assert.equal(status.refreshChild, child);
  await delay(50);
  assert.equal(status.refreshInFlight, true);
  await waitFor(() => !status.refreshInFlight);
  assert.equal(status.text, "Codex 79%");
  assert.equal(status.fetchFailures, 0);
});

test("Windows status marks failed readings stale and automatically retries", async (t) => {
  const { status, mode } = fixture(t);
  status.kickRefresh(true);
  await waitFor(() => !status.refreshInFlight);
  assert.equal(status.text, "Codex 79%");
  mode("fail");
  status.kickRefresh(true);
  await waitFor(() => !status.refreshInFlight);
  assert.equal(status.text, "[stale] Codex 79%");
  assert.ok(status.nextFetch - Date.now() <= 1000);
  mode("Codex 0%");
  // Timers can fire just before the wall-clock deadline. A scheduled retry
  // must still run when the clock is one millisecond behind nextFetch.
  const originalNow = Date.now;
  const earlyNow = status.nextFetch - 1;
  try {
    Date.now = () => earlyNow;
    await waitFor(() => status.text === "Codex 0%");
  } finally {
    Date.now = originalNow;
  }
  assert.equal(status.fetchFailures, 0);
});

test("Windows status recovers from an initial failure without a manual refresh", async (t) => {
  const { status, mode } = fixture(t, "fail");
  status.kickRefresh(true);
  await waitFor(() => !status.refreshInFlight);
  assert.equal(status.text, "AI Battery unavailable");
  mode("Codex 50%");
  await waitFor(() => status.text === "Codex 50%");
});

test("Windows status rejects partial, empty, timed out and oversized output", async (t) => {
  const { status, mode } = fixture(t);
  status.kickRefresh(true);
  await waitFor(() => !status.refreshInFlight);
  for (const value of ["empty", "hang", "large"]) {
    mode(value);
    status.fetchTimeoutMs = value === "hang" ? 100 : 10000;
    status.kickRefresh(true);
    await waitFor(() => !status.refreshInFlight);
    assert.equal(status.text, "[stale] Codex 79%", value);
  }
});
