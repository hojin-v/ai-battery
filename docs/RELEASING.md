# npm release

The prepared version is **0.1.25**. The npm `latest` version was 0.1.24 when checked on 2026-11-05. Preparing or pushing this release does not publish it to npm.

## Changes in 0.1.25

- Ubuntu/Linux HUD uses the same SVG logos, meters and percentages as the macOS menu bar. Its native panel menu includes usage/reset details, Refresh and Quit. GJS and libdbusmenu connect to a StatusNotifier host, including Ubuntu AppIndicators. Snapshots run asynchronously, failures keep the last artwork with a retry message, and the service reconnects after unlock. XDG autostart, stop/status/reset and isolated state roots are supported; WSL continues to use the Windows HUD.
- Help, diagnostics, setup/reset results and errors use concise Korean or English messages. Locale selection follows `LANGUAGE`, `LC_ALL`, `LC_MESSAGES`, `LANG`, then Node's default locale. Unsupported languages fall back to English. Technical terms, paths, commands and external errors remain intact.
- Main help lists `setup`, `hud` and `on / off` first, with command and option headings. Detailed help only advertises relevant options and examples; native Windows HUD options are shown on Windows.
- **CLI behavior change:** running `ai-battery` without arguments opens help, and the `show` command is removed. Use an integrated status line, HUD or `--watch` for continuous usage display. Existing flag-based JSON, tmux, runner and macOS menu outputs remain available to integrations.
- `ai-battery reset` restores integrations and cleans owned files; targets can follow directly, for example `ai-battery reset claude`. `reset settings`, `reset config`, `teardown` and `uninstall` remain compatibility forms. Reset preserves npm packages and unrelated provider settings.
- `doctor` summarizes status without treating optional Codex wrappers/status lines as missing requirements. `doctor --json` retains full diagnostic data. JSON report keys and message values remain independent of the display locale.

## Validation

Run checks from this checkout and save release artifacts under `.cache/releases/0.1.25/`:

```text
npm run check
npm pack --dry-run --json
npm pack --pack-destination .cache/releases/0.1.25 --json
```

The regression suite covers locale precedence, command help, no-argument help, removed commands, bare and targeted reset, compatibility forms, localized runtime messages, file preservation and locale-independent JSON reports. Linux HUD tests cover real GJS registration/menu export on a private session bus, snapshot refresh, provider visibility, stale-data recovery, reconnect, restart, stop/reset and literal desktop-entry argument handling. Native Linux tests require GJS and libdbusmenu; other platform tests are skipped where their runtime is unavailable. Native Windows, macOS and Windows ARM64 require their own runtime validation.

On Ubuntu GNOME 50.1 / Wayland, the Linux HUD registered with the real AppIndicators host. While the desktop was locked, its waiting/reconnect state was verified; a private bus also verified host disappearance and return without changing the user's desktop.

Inspect the package manifest for the core CLI help/message/output modules, platform modules, stable bin entrypoints and required PowerShell files. Exclude tests, logs, credentials, node_modules and `.cache`. Install the exact tarball into an isolated npm prefix, with lifecycle scripts disabled for the smoke check, and verify:

- npm bin links and `--version` report 0.1.25;
- Korean and English main/command help show the intended commands and headings;
- setup, doctor, on/off and targeted reset work with temporary provider homes;
- invalid commands/configuration produce localized errors without changing the source file;
- JSON reports retain the same schema and values across locales.

Keep the tarball, manifest, checksum, test log, installed-package smoke report and publish dry-run output together. Publish that tested tarball rather than rebuilding it after validation.

## Publish manually

Publishing is a separate step. The current npm authentication check returned HTTP 401; authenticate before publishing:

```text
npm login
npm whoami
npm publish .cache/releases/0.1.25/ai-battery-0.1.25.tgz --access public --tag latest
npm view ai-battery version dist-tags --json
```

Complete npm authentication/2FA when requested. If 0.1.25 is already published by then, increment the version and rebuild and verify the package. After successful publication, tag the tested commit `v0.1.25`.

## Update or remove an installation

Run separately for Windows, WSL and each Node installation:

```text
npm install -g ai-battery@0.1.25
ai-battery setup
```

Default Codex setup preserves independent execution. It does not install a wrapper or modify Codex settings unless explicitly requested with `--wrap-codex` or `--configure-codex-statusline`. Use a supported desktop HUD or `--watch` for usage display. There is no built-in `ai-battery update` command.

Restore integrations before removing the package:

```text
ai-battery reset && npm uninstall -g ai-battery
```

For local installs use `npm uninstall ai-battery`. Reset keeps edited/unrecognized files and incomplete recovery records, and never invokes npm uninstall. Existing Bash terminals may need `hash -r` (zsh: `rehash`) after a legacy wrapper is removed; sessions already using a wrapper keep their terminal row until they exit.
