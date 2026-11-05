# Codex setup regression: 0.1.24 to 0.1.27

The Linux HUD feature did not require a change to Codex terminal setup. The
0.1.25 release nevertheless lost the default setup behavior shipped in 0.1.24.
This was a release regression, not a Linux limitation or a user configuration
requirement.

## Evidence

The published npm tarballs for all four versions were inspected, including
`lib/cli.js` and `bin/ai-battery-run`:

| Version | Default Codex wrapper | Setup can remove an existing wrapper | PTY EOF preserves child exit status |
| --- | --- | --- | --- |
| 0.1.24 | enabled | yes, with explicit opt-out | yes |
| 0.1.25 | disabled | yes, during default setup | no |
| 0.1.26 | disabled | no | no |
| 0.1.27 | disabled | no | no |
| 0.1.28 | enabled | no; removal uses reset | yes |

Commit `869683e` restored automatic display, the `--no-wrap-codex` option and
PTY exit handling for 0.1.24 on `fix/setup-codex-defaults`. That branch was not
merged into main before the 0.1.25 Linux HUD release. Main continued from
`98ae375` (0.1.23); the published 0.1.25 package also has `wrapCodex: false`.

0.1.26 (`2307c89`) stopped setup from consuming recovery records and deleting
wrapper paths. It preserved an existing integration but did not restore the
0.1.24 default. Therefore a reset, which correctly removes the integration,
followed by plain setup still produced a standalone Codex command. 0.1.27
fixed Korean row wrapping but retained that setup regression.

## Why diagnosis and testing missed it

`providerEnabled` is an on/off visibility preference. It defaults to true even
without an installed integration. The concise doctor formatter displayed it
as `Codex: on`, while suppressing the missing-wrapper note. That made a display
preference look like a successful installation.

Most live setup tests explicitly passed `--wrap-codex`. Another test asserted
that default setup should leave Codex standalone. They tested the regressed
behavior rather than the setup contract of the last working release.

## Restored contract

- Plain setup and setup codex install or refresh the managed PATH wrapper.
  The original Codex executable, Codex configuration and session history are
  preserved. New tmux integration remains explicit.
- Setup never detaches an existing integration. `--no-wrap-codex` skips wrapper
  setup and preserves existing files; reset is the removal operation.
- Reset followed by plain setup restores the terminal row for new sessions.
  An already-running Codex keeps running through both operations.
- Missing Codex, Python or runner prerequisites produce incomplete setup and a
  failing exit status, with a cause and next step.
- Doctor reports visibility, integration readiness and current-session
  attachment separately. Missing integration, PATH mismatch, missing runner,
  missing Python and missing original Codex each have their own state and
  action. A missing optional Codex built-in status line is not a wrapper error.
- Claude diagnosis distinguishes an installed hook waiting for first-use data
  from missing, external, outdated or invalid settings.

Release checks now cover default setup without opt-in flags, reset/setup,
fresh shells, live terminals and upgrades from both 0.1.24 and 0.1.27. Package
validation uses the exact npm tarball, in addition to source tests.
