// Syncs the vendored rowpty source from the upstream checkout:
//   node scripts/sync-rowpty.mjs [upstream-dir]
// The upstream checkout is located by, in order: the CLI argument, the
// ROWPTY_DIR environment variable, then the sibling directory ../rowpty.
// Copies <upstream>/src/RowPty.cs into vendor/rowpty/RowPty.cs with a
// provenance header carrying the upstream commit hash.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_DIR = path.resolve(process.argv[2] || process.env.ROWPTY_DIR || path.join(ROOT, "..", "rowpty"));
const UPSTREAM_SOURCE = path.join(UPSTREAM_DIR, "src", "RowPty.cs");
const VENDOR_SOURCE = path.join(ROOT, "vendor", "rowpty", "RowPty.cs");

if (!fs.existsSync(UPSTREAM_SOURCE)) {
  console.error(`sync-rowpty: upstream source not found: ${UPSTREAM_SOURCE}`);
  process.exit(1);
}

let commit = "unknown";
try {
  commit = execFileSync("git", ["-C", UPSTREAM_DIR, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["-C", UPSTREAM_DIR, "status", "--porcelain", "--", "src/RowPty.cs"], { encoding: "utf8" }).trim();
  if (dirty) {
    console.error("sync-rowpty: upstream src/RowPty.cs has uncommitted changes; commit them first so the provenance hash is meaningful.");
    process.exit(1);
  }
} catch {
  console.error("sync-rowpty: could not read upstream git state; continuing with commit=unknown");
}

const header = [
  `// Vendored from the rowpty project (commit ${commit}). Do not edit here -`,
  "// change it upstream in Projects/rowpty and run: node scripts/sync-rowpty.mjs",
  '// "ai-battery setup" compiles this file on the user machine with the in-box',
  "// .NET Framework csc.exe so no unsigned binary ships in the npm package.",
  ""
].join("\n");

fs.mkdirSync(path.dirname(VENDOR_SOURCE), { recursive: true });
fs.writeFileSync(VENDOR_SOURCE, header + fs.readFileSync(UPSTREAM_SOURCE, "utf8"));
console.log(`sync-rowpty: vendored ${UPSTREAM_SOURCE} @ ${commit} -> ${VENDOR_SOURCE}`);
