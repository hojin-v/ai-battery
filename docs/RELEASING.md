# npm release

The prepared version is **0.1.29**, following the published 0.1.28. Preparing or pushing this release does not publish it to npm.

## Fixes in 0.1.29

- Change the GNOME extension UUID to `ai-battery@hnode`. Migrate the owned legacy `ai-battery@hnode.dev` directory and activation settings during HUD startup. Reset handles both identities and preserves unrelated files. GNOME may require a new login to discover the new UUID.

## Fixes in 0.1.28

- Restore the 0.1.24 automatic Codex wrapper default, including after reset. Keep the 0.1.26 non-destructive refresh behavior. Explicit opt-out skips setup without removing existing integrations.
- Diagnose visibility, TUI readiness and current-session attachment separately; report incomplete setup for missing prerequisites. Restore the 0.1.24 PTY EOF exit-status fix.
- See [the published-package regression audit](SETUP-REGRESSION.md). Test upgrades from the last working 0.1.24 and the current 0.1.27.

## Fixes in 0.1.27

- POSIX terminal rows measure Korean/full-width text in screen cells, retain colors while clipping, and clear the old tail without space padding. Repeated refreshes no longer wrap the bottom row and accumulate meter copies in the Codex screen or scrollback. Bounded rows show unavailable providers as `Codex --%` / `Claude --%`; detailed diagnostics retain localized errors.

The active runner keeps its Python code until the next launch. Updating the CLI formatter also mitigates the reported Korean-error overflow in already-running sessions, since each status poll loads the formatter again. Existing Codex processes need not be terminated.

## Fixes in 0.1.26

- `setup` no longer invokes Codex teardown. It refreshes previously selected wrappers in place and preserves PATH blocks, built-in status lines, original-command backups and compatibility paths cached by existing shells. Wrapper replacement is atomic so an already-open script keeps its original bytes. Integration removal is explicit through `reset`.
- POSIX setup persists the shell PATH block even when the current process already has the shim on PATH. A session-only environment no longer makes setup report success while fresh shells lose the integration.
- A fresh install still leaves Codex independent until `--wrap-codex` or `--configure-codex-statusline` is requested. Setup explains how to enable terminal display instead of implying that standalone configuration creates a terminal row.
- Previously selected tmux integration is refreshed by default setup, including after npm updates. Fully removed managed blocks can be installed again without discarding current user configuration. Partial/edited blocks and retargeted symlinks remain protected. tmux commands use the stable bin entrypoint and quote paths for the config parser.
- Setup inside tmux applies owned status options to the running server without sourcing unrelated user configuration. Setup outside tmux reports `configured` and `Start: tmux`; doctor distinguishes configuration from being inside a tmux session.
- The GNOME HUD popup removes both the content border and box-pointer border. Korean and English main/setup examples use `ai-battery setup tmux`.

## Validation and package preparation

```text
npm run check
npm run smoke:linux
mkdir -p .cache/releases/0.1.29
npm pack --dry-run --json
npm pack --pack-destination .cache/releases/0.1.29 --json
```

The regression suite includes real PTYs: an already-running wrapped Codex remains interactive during setup, the same Bash command cache launches it again, a fresh shell displays the usage row, and an attached tmux client displays the bar after live setup. An open wrapper reader retains its old bytes, compatibility command paths and recovery backups survive, and user Codex/shell/tmux settings are compared exactly.

POSIX screen regressions replay actual output into a terminal emulator and inspect the rendered rows, cursor and scrollback. They cover repeated Korean error rows, narrow widths, wide/combining characters, control sequences, shorter replacement text, resize and keyboard input through a live PTY.

Also install each of 0.1.24 and 0.1.27 into an isolated npm prefix, open the PTY fixture, upgrade that prefix to the exact 0.1.29 tarball, and run default setup while the original terminal remains open. Save the lifecycle report, package manifest, SHA256 checksum, installed-package smoke report and publish dry-run under `.cache/releases/0.1.29/`.

The Linux GUI smoke test opens the actual popup in an isolated GNOME 50.1 Wayland session, verifies zero border width for the content and box pointer, and saves a screenshot. It also checks shared macOS SVG size, provider visibility, extension fallback/reconnect and shutdown. Native Windows/macOS runtime tests require their respective environments; platform-neutral regressions still run here.

Inspect the tarball for runtime modules, stable bin entrypoints and required platform files. Exclude tests, logs, credentials, node_modules and `.cache`. Publish the exact tested tarball.

## Publish manually

```text
npm whoami
npm publish .cache/releases/0.1.29/ai-battery-0.1.29.tgz --access public --tag latest
npm view ai-battery version dist-tags --json
```

Authenticate with `npm login` if required, and complete npm 2FA when requested. If 0.1.29 is already published, increment the version and repeat verification. Tag the tested commit `v0.1.29` after publication.

## Update and enable terminal display

```text
npm install -g ai-battery@0.1.29
ai-battery setup
ai-battery setup tmux
tmux
```

Plain setup enables the Codex usage row outside tmux. Run the printed source command in existing shells. New shells load it automatically. Subsequent setup calls preserve that choice. Re-running setup does not require closing running Codex sessions.

GNOME caches loaded extension JavaScript. After its display code changes, sign out and back in when convenient, then start the HUD again. The terminal integration does not require a desktop restart.

Restore integrations before explicitly removing the npm package:

```text
ai-battery reset && npm uninstall -g ai-battery
```

Reset preserves edited/unrecognized files, incomplete recovery records and unrelated provider settings. It never invokes npm uninstall itself. Only explicit reset removes integrations; existing Bash terminals may then need `hash -r` (zsh: `rehash`).
