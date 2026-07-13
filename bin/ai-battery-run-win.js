#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { main, sameFilePath } from "../lib/platforms/windows/codex-runner.js";

export * from "../lib/platforms/windows/codex-runner.js";

if (process.argv[1] && sameFilePath(fileURLToPath(import.meta.url), process.argv[1])) {
  main().catch((error) => {
    console.error(`ai-battery-run-win: ${error.message}`);
    process.exit(1);
  });
}
