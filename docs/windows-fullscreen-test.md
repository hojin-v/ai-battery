# Windows Fullscreen verification

The 0.1.19 default is PTY composition, with a private verified Node 24.21.0 when the caller lacks Windows VT input support. System Node, PATH, and the original Codex installation are preserved. Runtime installation or missing dependencies fall back to the native HUD.

Run `npm run check`, `npm run smoke:composite`, and `npm run smoke:codex-fullscreen-win`. The actual Codex test uses an isolated CODEX_HOME and a local mock Responses server, without consuming account quota. `--verify-matrix --modern-node <node.exe>` compares automatic legacy-runtime bootstrap with direct modern-runtime execution.

The test checks UTF-8 input, Backspace, resize, footer placement, scrolling, one battery row, and terminal restoration. Windows Terminal padding remains a user setting. ARM64 runtime selection is supported but has not been exercised on ARM64 hardware.

See [release instructions](RELEASING.md).
