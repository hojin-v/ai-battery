#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { main, sameFilePath } from "../lib/cli.js";

export * from "../lib/cli.js";

if (process.argv[1] && sameFilePath(fileURLToPath(import.meta.url), process.argv[1])) {
  main().catch((error) => {
    console.error(`ai-battery: ${error.message}`);
    process.exit(1);
  });
}
