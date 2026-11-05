// The native panel requests one snapshot, keeping provider scans off its event loop.
import { desktopHudSnapshot } from "../../cli.js";
import { errorText } from "../../core/cli-messages.js";

try {
  console.log(JSON.stringify(desktopHudSnapshot(process.argv[2] || "all")));
} catch (error) {
  console.error(errorText(error));
  process.exitCode = 1;
}
