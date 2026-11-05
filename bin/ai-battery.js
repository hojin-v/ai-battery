#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { main, sameFilePath } from "../lib/cli.js";
import { errorText } from "../lib/core/cli-messages.js";

export * from "../lib/cli.js";

if (process.argv[1] && sameFilePath(fileURLToPath(import.meta.url), process.argv[1])) {
  main().catch((error) => {
    console.error(`ai-battery: ${errorText(error)}`);
    process.exit(1);
  });
}
