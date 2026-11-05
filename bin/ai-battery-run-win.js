#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { main, sameFilePath } from "../lib/platforms/windows/codex-runner.js";
import { errorText } from "../lib/core/cli-messages.js";

export * from "../lib/platforms/windows/codex-runner.js";

if (process.argv[1] && sameFilePath(fileURLToPath(import.meta.url), process.argv[1])) {
  main().catch((error) => {
    console.error(`ai-battery-run-win: ${errorText(error)}`);
    process.exit(1);
  });
}
