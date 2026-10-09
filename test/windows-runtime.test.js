import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import path from "node:path";
import {
  runtimeNodePath, supportsWindowsVtInput, verifyRuntimeArchive, windowsRuntimeRoot
} from "../lib/platforms/windows/node-runtime.js";

test("runtime selection checks VT input capability rather than the Node major version", () => {
  assert.equal(supportsWindowsVtInput({ isTTY: true, isRaw: false }), false);
  assert.equal(supportsWindowsVtInput({ isTTY: true, rawMode: false }), true);
  assert.equal(supportsWindowsVtInput({ isTTY: false, rawMode: false }), false);
});

test("private runtime path uses the selected data root and architecture", () => {
  assert.equal(windowsRuntimeRoot({ AI_BATTERY_DATA_DIR: "isolated" }), path.join("isolated", "runtimes"));
  assert.match(runtimeNodePath("isolated", "x64"), /node-v24\.21\.0-win-x64[\\/]node\.exe$/);
  assert.match(runtimeNodePath("isolated", "arm64"), /node-v24\.21\.0-win-arm64[\\/]node\.exe$/);
  assert.throws(() => runtimeNodePath("isolated", "ia32"), /architecture/);
});

test("private runtime archive must match the official filename and checksum", () => {
  const archive = Buffer.from("test runtime archive");
  const filename = "node-v24.21.0-win-x64.zip";
  const hash = crypto.createHash("sha256").update(archive).digest("hex");
  verifyRuntimeArchive(archive, `${hash}  ${filename}\n`, filename);
  assert.throws(() => verifyRuntimeArchive(Buffer.from("modified"), `${hash}  ${filename}`, filename), /SHA256/);
  assert.throws(() => verifyRuntimeArchive(archive, `${hash}  another.zip`, filename), /SHA256/);
});
