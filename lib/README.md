# Internal module layout

The bin directory contains stable executable entrypoints only. Runtime
implementation belongs under lib:

- core: provider-independent usage normalization and terminal formatting.
- hud: desktop HUD dispatch and shared snapshot prefetch.
- platforms/runtime.js: cross-platform environment detection helpers.
- platforms/process-scanner.js: Windows, WSL, macOS, and Linux process scans.
- platforms/macos: macOS menu bar integration.
- platforms/windows: Windows Codex runner, compositor, PATH integration, and
  HUD launcher.
- platforms/windows/hud: WinForms modules. dock.ps1 owns terminal attachment
  and AppBar behavior; windowing.ps1 owns desktop placement; snapshot.ps1 owns
  refresh; rendering.ps1 and controls.ps1 own UI drawing and updates;
  native.ps1 contains Win32 interop.

Keep public command paths and test imports pointed at bin. Those entrypoints
re-export implementation APIs so internal modules can move without breaking
installed commands or downstream imports.
