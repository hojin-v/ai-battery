# npm release

The current release candidate is **0.1.24**, based on the 0.1.23 main branch. Preparing this tarball does not publish it to npm.

## Changes in 0.1.24

- `ai-battery setup` once again configures both the Claude statusLine and automatic Codex usage display. `setup codex` also enables the Codex wrapper without extra flags.
- Codex runs through a separate managed PATH wrapper. The original executable, existing Codex configuration, session history and npm packages are preserved. Repeated setup remains restorable with `reset settings`.
- `--no-wrap-codex` explicitly disables the automatic integration. `--wrap-codex` remains compatible. `--configure-codex-statusline` only controls Codex's optional built-in model/directory/branch row and is not required for usage display.
- The POSIX runner preserves the original command's exit code when PTY EOF arrives before the child exit is observed. Usage polling failure still allows Codex to run.
- Settings restoration remains separate from npm removal. `reset settings` / `reset config`, with `uninstall` / `teardown` compatibility aliases, do not uninstall packages.

## Validation

Results are saved under `.cache/releases/0.1.24/`. Tests cover plain setup and targeted setup, original executable/config/session preservation, repeated setup and exact restoration, terminal meter rendering, query failures, exit status propagation, and explicit standalone mode. Native Windows checks use isolated profile/data directories and skip writes to the real user PATH. Desktop cleanup tests use a temporary registry key; macOS ownership tests use a filesystem fixture.

Native macOS and Windows ARM64 are not verified here.

## Prepare and publish

```text
npm run check
npm pack --pack-destination .cache/releases/0.1.24
npm publish .cache/releases/0.1.24/ai-battery-0.1.24.tgz --access public --tag latest
```

Verify the exact tarball in isolated Windows and POSIX prefixes before publishing. Check that packed files match the tested commit and exclude tests, logs, screenshots, caches and credentials. Complete npm authentication/2FA when requested. If this version is already published, increment it and repeat preparation.

## Setup and removal

Run in each installation (Windows and WSL are separate):

```text
npm install -g ai-battery@0.1.24
ai-battery setup
```

Open a new terminal, or apply the shell reload instructions from setup and clear Bash's command cache with `hash -r` (zsh: `rehash`). Windows users open a new cmd/PowerShell. A child CLI cannot change the PATH or command cache of its parent shell. The existing 0.1.23 installation can enable Codex integration with `ai-battery setup codex --wrap-codex` before this release is published.

Reset and remove a global package separately:

```text
ai-battery reset settings && npm uninstall -g ai-battery
```

For a local package use `npm uninstall ai-battery`. Edited or unrecognized files and unresolved recovery records are preserved and reported. A running wrapped session retains its loaded code until it exits.
