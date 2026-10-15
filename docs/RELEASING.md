# npm release

The current release candidate is **0.1.22**. It includes the 0.1.21 usage-refresh fixes and changes the default Codex integration to preserve independent execution. Preparing a tarball does not publish it to npm.

## Changes in 0.1.22

- Default `setup codex` restores legacy AI Battery integrations without creating a Codex wrapper, adding PATH entries or configuring Codex's status line. Use an independent watcher/HUD, or explicitly launch a runner for one session. `--wrap-codex` and `--configure-codex-statusline` are separate opt-ins.
- Full `ai-battery uninstall` restores integrations, selectively removes verified caches and private runtimes, removes aliases belonging to this installation, and runs npm uninstall against the owning prefix. Other npm packages are preserved. `teardown` and targeted uninstall retain the package; development checkouts and npx do not remove an npm project.
- Shell and tmux recovery records preserve exact original content, permissions and file absence. User edits outside managed blocks survive repeated setup and uninstall. Edited blocks, retargeted symlinks and unresolved recovery records prevent unsafe removal.
- Windows PATH cleanup preserves unrelated whitespace and separators and reports failed writes. HUD cleanup verifies its Run value and launcher ownership and preserves unknown files. macOS LaunchAgent cleanup refuses foreign files and symlinks.
- Existing Bash terminals can cache a deleted legacy Codex wrapper. Run `hash -r` (zsh: `rehash`) or open a new terminal. A child CLI cannot clear its parent shell's command cache. A POSIX wrapper whose Python runner cannot start because Python is absent now runs the original Codex directly.

## Validation

Checked on 2026-10-15:

| Environment | Result |
| --- | --- |
| WSL `npm run check` | 155 passed, 16 platform skips, 0 failures |
| Windows native Node 22.23.2 full suite | 132 passed, 39 platform skips, 0 failures |

Validation results and tarball manifests are stored in `.cache/releases/0.1.22/`. The regression suite covers default command/config preservation, exact shell restoration, user edits, symlinks, custom integration paths, incomplete recovery, npm failure, global/local prefix selection, actual self-uninstall in isolated installations, and Windows registry ownership. Desktop operations in the npm self-uninstall fixture are stubbed; Windows autostart cleanup is separately exercised against a temporary registry key and profile.

The current WSL installation was removed with the new cleanup helpers after successful teardown. Original shell, Codex and Claude settings and the original Codex launcher were byte-identical afterward. Codex and Claude still ran successfully. Previous manual test backups were preserved under `.cache/uninstall-audit/preserved-local-test-backups/`.

Native Windows validation uses x64 Node 22.23.2. macOS LaunchAgent ownership and file handling are tested through an isolated fixture; native macOS and Windows ARM64 are not verified here.

## Prepare

```text
npm run check
npm pack --dry-run
npm pack --pack-destination .cache/releases/0.1.22
```

Inspect the package file list. Include the core cleanup/recovery modules, platform modules, bin entrypoints and required PowerShell files. Exclude screenshots, logs, credentials, local runtime binaries, tests and `.cache`. Verify the exact tarball using an isolated npm prefix and provider homes. Release 0.1.21 fullscreen/compositor reports remain under `.cache/releases/0.1.21/`; this release changes setup/removal rather than terminal composition.

## Publish manually

```text
npm login
npm whoami
npm publish .cache/releases/0.1.22/ai-battery-0.1.22.tgz --access public --tag latest
npm view ai-battery version dist-tags --json
```

Publish the exact tested tarball. Complete npm authentication/2FA when requested. If the version is already published, increment it and repeat preparation. After publication, tag the tested commit (`v0.1.22`) and integrate the release branch into main.

## Update or remove an installation

Run separately for Windows and WSL:

```text
npm install -g ai-battery@0.1.22
ai-battery setup codex
```

Default setup detaches a legacy wrapper. In an existing Bash terminal run `hash -r`; zsh uses `rehash`. Plain `codex` then runs independently. Display usage with `ai-battery --watch 2` or a supported desktop HUD. There is no built-in `ai-battery update` command.

To remove the installation including npm:

```text
ai-battery uninstall
```

Modified or unrecognized files are preserved and listed. A running wrapped session retains its loaded code until it exits. Cleanup of one npm prefix does not uninstall another Windows/WSL or Node-version installation.
