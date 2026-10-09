import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const WINDOWS_NODE_VERSION = "24.21.0";

function supportsWindowsVtInput(stream = process.stdin) {
  return Boolean(stream?.isTTY && "rawMode" in stream);
}

function windowsRuntimeRoot(env = process.env) {
  const data = env.AI_BATTERY_DATA_DIR || env.XDG_DATA_HOME && path.join(env.XDG_DATA_HOME, "ai-battery")
    || path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ai-battery");
  return path.join(data, "runtimes");
}

function runtimeNodePath(root = windowsRuntimeRoot(), arch = process.arch) {
  if (!["x64", "arm64"].includes(arch)) throw new Error(`Windows PTY runtime does not support architecture ${arch}`);
  return path.join(root, `node-v${WINDOWS_NODE_VERSION}-win-${arch}`, "node.exe");
}

function validRuntime(nodePath) {
  if (!fs.existsSync(nodePath)) return false;
  const result = spawnSync(nodePath, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  return result.status === 0 && result.stdout.trim() === `v${WINDOWS_NODE_VERSION}`;
}

function download(url, remainingRedirects = 3) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location && remainingRedirects) {
        response.resume();
        const next = new URL(response.headers.location, url);
        if (next.protocol !== "https:" || next.hostname !== "nodejs.org") return reject(new Error("Unexpected runtime download redirect"));
        download(next.href, remainingRedirects - 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Runtime download returned HTTP ${response.statusCode}`)); return; }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 100 * 1024 * 1024) { request.destroy(new Error("Runtime download exceeds size limit")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve(Buffer.concat(chunks)));
    });
    request.setTimeout(60000, () => request.destroy(new Error("Runtime download timed out")));
    request.on("error", reject);
  });
}

function verifyRuntimeArchive(archive, manifest, filename) {
  const line = String(manifest).split(/\r?\n/).find((entry) => entry.trim().split(/\s+/)[1] === filename);
  const expected = line?.trim().split(/\s+/)[0];
  const actual = crypto.createHash("sha256").update(archive).digest("hex");
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected) || actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("Node runtime SHA256 verification failed");
  }
}

async function ensureWindowsRuntime(options = {}) {
  const root = options.root || windowsRuntimeRoot();
  const arch = options.arch || process.arch;
  const nodePath = runtimeNodePath(root, arch);
  if (validRuntime(nodePath)) return nodePath;
  if (process.env.AI_BATTERY_RUNTIME_DOWNLOAD === "0") throw new Error("Private runtime is unavailable and automatic download is disabled");
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, `.node-${WINDOWS_NODE_VERSION}-${arch}.lock`);
  let fd;
  try { fd = fs.openSync(lock, "wx"); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (Date.now() - fs.statSync(lock).mtimeMs > 5 * 60 * 1000) {
      fs.rmSync(lock, { force: true });
      fd = fs.openSync(lock, "wx");
    } else {
      throw new Error("Another terminal is preparing the Node runtime; retry after it finishes");
    }
  }
  let staging;
  try {
    staging = fs.mkdtempSync(path.join(path.resolve(root), ".node-download-"));
    console.error(`AI Battery: preparing private Node ${WINDOWS_NODE_VERSION} for Windows terminal input (one-time download).`);
    const filename = `node-v${WINDOWS_NODE_VERSION}-win-${arch}.zip`;
    const base = `https://nodejs.org/dist/v${WINDOWS_NODE_VERSION}/`;
    const manifest = await download(`${base}SHASUMS256.txt`);
    const archive = await download(`${base}${filename}`);
    verifyRuntimeArchive(archive, manifest.toString("utf8"), filename);
    const zip = path.join(staging, filename);
    fs.writeFileSync(zip, archive);
    // Extract only node.exe; npm and the system installation remain untouched.
    const script = path.join(staging, "extract.ps1");
    fs.writeFileSync(script, [
      "param([string]$Archive, [string]$Destination, [string]$Entry)",
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      "$zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)",
      "try {",
      "  $file = $zip.GetEntry($Entry)",
      "  if (-not $file) { throw 'Node executable missing from official archive' }",
      "  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($file, $Destination, $true)",
      "} finally { $zip.Dispose() }", ""
    ].join("\n"));
    const candidate = path.join(staging, "node.exe");
    const extracted = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
      "-Archive", zip, "-Destination", candidate, "-Entry", filename.replace(/\.zip$/, "/node.exe")], {
      encoding: "utf8", windowsHide: true, timeout: 30000
    });
    if (extracted.status !== 0) throw new Error(`Runtime extraction failed: ${extracted.stderr || extracted.error?.message || extracted.status}`);
    if (!validRuntime(candidate)) throw new Error("Downloaded runtime failed its version check");
    fs.mkdirSync(path.dirname(nodePath), { recursive: true });
    fs.renameSync(candidate, nodePath);
    return nodePath;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
    if (staging && path.dirname(path.resolve(staging)) === path.resolve(root)) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}

export { WINDOWS_NODE_VERSION, ensureWindowsRuntime, runtimeNodePath, supportsWindowsVtInput, verifyRuntimeArchive, windowsRuntimeRoot };
