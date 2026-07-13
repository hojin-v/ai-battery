#!/usr/bin/env node

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { runDesktopHud } from "../lib/hud/launcher.js";

export * from "../lib/hud/launcher.js";

if (process.argv[1]) {
  try {
    if (fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
      runDesktopHud(process.argv.slice(2));
    }
  } catch {
    // Imported modules do not launch the desktop HUD.
  }
}
