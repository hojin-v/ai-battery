# Shared by setup, doctor and the self-contained installed wrapper.
# Resolve paths and bounded headers without running Codex or package managers.
ai_battery_readlink=$(command -v readlink) || ai_battery_readlink=/usr/bin/readlink
ai_battery_head=$(command -v head) || ai_battery_head=/usr/bin/head

ai_battery_realpath() {
  case "$1" in /*) ai_battery_link=$1 ;; *) ai_battery_link=$PWD/$1 ;; esac
  ai_battery_link_count=0
  while :; do
    ai_battery_link_dir=$(CDPATH= cd -P "${ai_battery_link%/*}" 2>/dev/null && pwd -P) || return 1
    ai_battery_link=$ai_battery_link_dir/${ai_battery_link##*/}
    if [ ! -L "$ai_battery_link" ]; then printf '%s\n' "$ai_battery_link"; return 0; fi
    ai_battery_link_count=$((ai_battery_link_count + 1))
    [ "$ai_battery_link_count" -le 40 ] || return 1
    ai_battery_link_text=$("$ai_battery_readlink" "$ai_battery_link" 2>/dev/null) || return 1
    case "$ai_battery_link_text" in
      /*) ai_battery_link=$ai_battery_link_text ;;
      *) ai_battery_link=$ai_battery_link_dir/$ai_battery_link_text ;;
    esac
  done
}

ai_battery_is_wrapper() {
  ai_battery_header=$("$ai_battery_head" -c 256 "$1" 2>/dev/null) || return 1
  case "$ai_battery_header" in
    *AI_BATTERY_MANAGED_CODEX_WRAPPER*) return 0 ;;
  esac
  return 1
}

ai_battery_nvm_node() {
  case "$1" in
    */versions/node/*)
      ai_battery_version_base=${1%%/versions/node/*}/versions/node/
      ai_battery_version_tail=${1#"$ai_battery_version_base"}
      ai_battery_version=${ai_battery_version_tail%%/*}
      ai_battery_owner_node=$ai_battery_version_base$ai_battery_version/bin/node
      if [ -f "$ai_battery_owner_node" ] && [ -x "$ai_battery_owner_node" ]; then
        printf '%s\n' "$ai_battery_owner_node"
        return 0
      fi
      ;;
  esac
  return 1
}

ai_battery_codex_uses_node() {
  ai_battery_first_line=${ai_battery_header%%'
'*}
  case "$ai_battery_first_line" in
    '#!'*/node|'#!'*' node'|'#!'*/node' '*|'#!'*' node '*) return 0 ;;
  esac
  return 1
}

ai_battery_describe_codex() {
  [ -f "$1" ] && [ -x "$1" ] || return 1
  ai_battery_target=$(ai_battery_realpath "$1") || return 1
  ai_battery_is_excluded "$1" && return 1
  ai_battery_is_wrapper "$ai_battery_target" && return 1
  ai_battery_kind=standalone
  ai_battery_node=
  ai_battery_prefix=
  if ai_battery_codex_uses_node; then
    ai_battery_kind=node
    case "$ai_battery_target" in
      */lib/node_modules/@openai/codex/bin/codex.js)
        ai_battery_kind=npm
        ai_battery_prefix=${ai_battery_target%/lib/node_modules/@openai/codex/bin/codex.js}
        if [ -f "$ai_battery_prefix/bin/node" ] && [ -x "$ai_battery_prefix/bin/node" ]; then
          ai_battery_node=$ai_battery_prefix/bin/node
        fi
        ;;
    esac
    # Require the owning Node even when reached through an unrelated alias.
    case "$ai_battery_target" in
      */versions/node/*) ai_battery_node=$(ai_battery_nvm_node "$ai_battery_target") || return 1 ;;
    esac
    if [ -z "$ai_battery_node" ]; then
      case "$ai_battery_first_line" in
        '#!'/*/node) ai_battery_node=${ai_battery_first_line#'#!'} ;;
        *) ai_battery_node=$ai_battery_active_node ;;
      esac
      [ -f "$ai_battery_node" ] && [ -x "$ai_battery_node" ] || return 1
    fi
    # Unknown package managers retain their shebang and runtime options.
    # Only the npm layout provides enough ownership evidence to override it.
    if [ "$ai_battery_kind" != npm ]; then ai_battery_node=; fi
  else
    case "$ai_battery_target" in
      */Caskroom/codex/*) ai_battery_kind=homebrew; ai_battery_prefix=${ai_battery_target%/Caskroom/codex/*} ;;
      */Cellar/codex/*) ai_battery_kind=homebrew; ai_battery_prefix=${ai_battery_target%/Cellar/codex/*} ;;
    esac
  fi
}

ai_battery_usable_codex() {
  ai_battery_describe_codex "$1"
}

ai_battery_usable_runner() {
  [ -f "$1" ] && [ -x "$1" ] || return 1
  ai_battery_runner_target=$(ai_battery_realpath "$1") || return 1
  case "$ai_battery_runner_target" in
    */versions/node/*) ai_battery_nvm_node "$ai_battery_runner_target" >/dev/null ;;
    *) return 0 ;;
  esac
}

ai_battery_find_command() {
  ai_battery_remaining_path=$PATH
  while :; do
    case "$ai_battery_remaining_path" in
      *:*)
        ai_battery_dir=${ai_battery_remaining_path%%:*}
        ai_battery_remaining_path=${ai_battery_remaining_path#*:}
        ai_battery_more=1
        ;;
      *)
        ai_battery_dir=$ai_battery_remaining_path
        ai_battery_more=0
        ;;
    esac
    ai_battery_candidate=${ai_battery_dir:-.}/$1
    if [ -f "$ai_battery_candidate" ] && [ -x "$ai_battery_candidate" ]; then
      if { [ "$1" != codex ] || ai_battery_usable_codex "$ai_battery_candidate"; } \
        && { [ "$1" != ai-battery-run ] || ai_battery_usable_runner "$ai_battery_candidate"; }; then
        printf '%s\n' "$ai_battery_candidate"
        return 0
      fi
    fi
    [ "$ai_battery_more" = 1 ] || break
  done
  return 1
}

ai_battery_saved_nvm_dir=
case "$ai_battery_configured_codex" in
  */versions/node/*) ai_battery_saved_nvm_dir="$ai_battery_configured_codex"; ai_battery_saved_nvm_dir=${ai_battery_saved_nvm_dir%%/versions/node/*} ;;
esac
ai_battery_nvm_dir=${NVM_DIR:-${ai_battery_saved_nvm_dir:-${HOME:-}/.nvm}}

ai_battery_find_nvm_command() {
  ai_battery_best_command=
  ai_battery_best_major=-1
  ai_battery_best_minor=-1
  ai_battery_best_patch=-1
  for ai_battery_candidate in "$ai_battery_nvm_dir"/versions/node/v*/bin/"$1"; do
    [ -f "$ai_battery_candidate" ] && [ -x "$ai_battery_candidate" ] || continue
    if [ "$1" = codex ]; then
      ai_battery_usable_codex "$ai_battery_candidate" || continue
    else
      ai_battery_nvm_node "$ai_battery_candidate" >/dev/null || continue
    fi
    ai_battery_version_path=${ai_battery_candidate#"$ai_battery_nvm_dir"/versions/node/v}
    ai_battery_version_text=${ai_battery_version_path%%/*}
    ai_battery_version_number=$ai_battery_version_text
    ai_battery_major=${ai_battery_version_text%%.*}
    ai_battery_version_text=${ai_battery_version_text#*.}
    ai_battery_minor=${ai_battery_version_text%%.*}
    ai_battery_patch=${ai_battery_version_text#*.}
    [ "$ai_battery_version_number" = "$ai_battery_major.$ai_battery_minor.$ai_battery_patch" ] || continue
    case "$ai_battery_major:$ai_battery_minor:$ai_battery_patch" in
      *[!0-9:]*|:*|*::*|*:) continue ;;
    esac
    if [ "$ai_battery_major" -gt "$ai_battery_best_major" ] \
      || { [ "$ai_battery_major" -eq "$ai_battery_best_major" ] && [ "$ai_battery_minor" -gt "$ai_battery_best_minor" ]; } \
      || { [ "$ai_battery_major" -eq "$ai_battery_best_major" ] && [ "$ai_battery_minor" -eq "$ai_battery_best_minor" ] && [ "$ai_battery_patch" -gt "$ai_battery_best_patch" ]; }; then
      ai_battery_best_command=$ai_battery_candidate
      ai_battery_best_major=$ai_battery_major
      ai_battery_best_minor=$ai_battery_minor
      ai_battery_best_patch=$ai_battery_patch
    fi
  done
  [ -n "$ai_battery_best_command" ] || return 1
  printf '%s\n' "$ai_battery_best_command"
}

ai_battery_find_tool() {
  if [ -n "$ai_battery_active_node" ]; then
    ai_battery_active_candidate=$ai_battery_active_bin/$1
    case "$1" in
      codex)
        # Only a verified npm installation overrides ordinary PATH order.
        if ai_battery_describe_codex "$ai_battery_active_candidate" && [ "$ai_battery_kind" = npm ]; then
          ai_battery_owner_bin=$(CDPATH= cd -P "$ai_battery_prefix/bin" 2>/dev/null && pwd -P) || ai_battery_owner_bin=
          if [ "$ai_battery_owner_bin" = "$ai_battery_active_bin_physical" ]; then
            printf '%s\n' "$ai_battery_active_candidate"
            return 0
          fi
        fi
        ;;
      ai-battery-run) ai_battery_usable_runner "$ai_battery_active_candidate" && { printf '%s\n' "$ai_battery_active_candidate"; return 0; } ;;
    esac
  fi
  ai_battery_find_command "$1"
}

# Recover old saved version paths through the installer's stable public entry.
# Do not guess a package version or traverse private installation trees.
ai_battery_find_saved_codex() {
  case "$ai_battery_configured_codex" in
    */Caskroom/codex/*) ai_battery_saved_prefix=${ai_battery_configured_codex%/Caskroom/codex/*} ;;
    */Cellar/codex/*) ai_battery_saved_prefix=${ai_battery_configured_codex%/Cellar/codex/*} ;;
    *) ai_battery_saved_prefix= ;;
  esac
  if [ -n "$ai_battery_saved_prefix" ]; then
    for ai_battery_saved_entry in "$ai_battery_saved_prefix/bin/codex" "$ai_battery_saved_prefix/opt/codex/bin/codex"; do
      if ai_battery_describe_codex "$ai_battery_saved_entry" && [ "$ai_battery_kind" = homebrew ] \
        && [ "$ai_battery_prefix" = "$ai_battery_saved_prefix" ]; then
        printf '%s\n' "$ai_battery_saved_entry"
        return 0
      fi
    done
  fi
  if ai_battery_usable_codex "$ai_battery_configured_codex"; then
    printf '%s\n' "$ai_battery_configured_codex"
    return 0
  fi
  return 1
}

ai_battery_find_stable_codex() {
  for ai_battery_stable_prefix in "${HOMEBREW_PREFIX:-}" /opt/homebrew /usr/local /home/linuxbrew/.linuxbrew; do
    [ -n "$ai_battery_stable_prefix" ] || continue
    ai_battery_stable_entry=$ai_battery_stable_prefix/bin/codex
    if ai_battery_describe_codex "$ai_battery_stable_entry" && [ "$ai_battery_kind" = homebrew ]; then
      printf '%s\n' "$ai_battery_stable_entry"
      return 0
    fi
  done
  ai_battery_stable_entry=${HOME:-}/.local/bin/codex
  if ai_battery_usable_codex "$ai_battery_stable_entry"; then
    printf '%s\n' "$ai_battery_stable_entry"
    return 0
  fi
  return 1
}

ai_battery_resolve() {
  ai_battery_active_node=$(ai_battery_find_command node) || ai_battery_active_node=
  ai_battery_active_bin=${ai_battery_active_node%/*}
  ai_battery_active_bin_physical=$(CDPATH= cd -P "$ai_battery_active_bin" 2>/dev/null && pwd -P) || ai_battery_active_bin_physical=
  ai_battery_codex_source=path
  ai_battery_codex=$(ai_battery_find_tool codex) || ai_battery_codex=
  if [ -z "$ai_battery_codex" ]; then
    ai_battery_codex_source=saved
    ai_battery_codex=$(ai_battery_find_saved_codex) || ai_battery_codex=
  fi
  if [ -z "$ai_battery_codex" ]; then
    ai_battery_codex_source=stable
    ai_battery_codex=$(ai_battery_find_stable_codex) || ai_battery_codex=
  fi
  if [ -z "$ai_battery_codex" ]; then
    ai_battery_codex_source=other-node
    ai_battery_codex=$(ai_battery_find_nvm_command codex) || ai_battery_codex=
  fi
  ai_battery_target= ai_battery_kind= ai_battery_node= ai_battery_prefix=
  if [ -n "$ai_battery_codex" ]; then ai_battery_describe_codex "$ai_battery_codex" || return 1; fi
  ai_battery_codex_target=$ai_battery_target
  ai_battery_codex_kind=$ai_battery_kind
  ai_battery_codex_node=$ai_battery_node
  ai_battery_codex_prefix=$ai_battery_prefix
  ai_battery_scoped_update=0
  if [ "$ai_battery_codex_kind" = npm ]; then
    ai_battery_active_target=$(ai_battery_realpath "$ai_battery_active_bin/codex") || ai_battery_active_target=
    ai_battery_path_npm=$(ai_battery_find_command npm) || ai_battery_path_npm=
    ai_battery_path_npm_target=$(ai_battery_realpath "$ai_battery_path_npm") || ai_battery_path_npm_target=
    ai_battery_owner_npm_target=$(ai_battery_realpath "$ai_battery_codex_prefix/bin/npm") || ai_battery_owner_npm_target=
    if [ "$ai_battery_active_target" != "$ai_battery_codex_target" ] \
      || [ -z "$ai_battery_path_npm" ] \
      || [ "$ai_battery_path_npm_target" != "$ai_battery_owner_npm_target" ]; then
      ai_battery_scoped_update=1
    fi
  elif [ "$ai_battery_codex_kind" = homebrew ]; then
    ai_battery_path_brew=$(ai_battery_find_command brew) || ai_battery_path_brew=
    ai_battery_path_brew_target=$(ai_battery_realpath "$ai_battery_path_brew") || ai_battery_path_brew_target=
    ai_battery_owner_brew_target=$(ai_battery_realpath "$ai_battery_codex_prefix/bin/brew") || ai_battery_owner_brew_target=
    if [ -z "$ai_battery_owner_brew_target" ] || [ "$ai_battery_path_brew_target" != "$ai_battery_owner_brew_target" ]; then
      ai_battery_scoped_update=1
    fi
  fi
  ai_battery_runner=$(ai_battery_find_tool ai-battery-run) || ai_battery_runner=
  if [ -z "$ai_battery_runner" ]; then
    if ai_battery_usable_runner "$ai_battery_configured_runner"; then
      ai_battery_runner=$ai_battery_configured_runner
    else
      ai_battery_runner=$(ai_battery_find_nvm_command ai-battery-run) || ai_battery_runner=
    fi
  fi
  ai_battery_runner_node=
  if [ -n "$ai_battery_runner" ]; then
    ai_battery_runner_target=$(ai_battery_realpath "$ai_battery_runner") || ai_battery_runner_target=
    ai_battery_runner_node=$(ai_battery_nvm_node "$ai_battery_runner_target") || ai_battery_runner_node=
  fi
}

ai_battery_resolve || exit 127
if [ "${AI_BATTERY_CODEX_RESOLVE_ONLY:-}" = 1 ]; then
  printf '%s\000' "$ai_battery_codex" "$ai_battery_codex_target" "$ai_battery_codex_kind" \
    "$ai_battery_codex_node" "$ai_battery_codex_prefix" "$ai_battery_codex_source" \
    "$ai_battery_runner" "$ai_battery_runner_node" "$ai_battery_active_node" "$ai_battery_scoped_update"
  exit 0
fi

ai_battery_tui=0
if [ -t 0 ] && [ -t 1 ]; then
  ai_battery_tui=1
  ai_battery_option_value=0
  ai_battery_position_seen=0
  for ai_battery_arg in "$@"; do
    if [ "$ai_battery_option_value" = 1 ]; then
      ai_battery_option_value=0
      continue
    fi
    case "$ai_battery_arg" in
      -c|--config|-m|--model|-p|--profile|-C|--cd|-i|--image|--add-dir|--enable|--disable|--remote|--remote-auth-token-env|-s|--sandbox|-a|--ask-for-approval|--local-provider)
        ai_battery_option_value=1
        ;;
      -h|--help|-V|--version)
        ai_battery_tui=0
        ;;
      --) break ;;
      -*) ;;
      *)
        if [ "$ai_battery_position_seen" = 0 ]; then
          ai_battery_position_seen=1
          case "$ai_battery_arg" in
            help|exec|e|review|completion|mcp|mcp-server|app-server|exec-server|login|logout|update|doctor|sandbox|debug|apply|a|features|queue|archive|delete|unarchive|migrate-rollouts|plugin|remote-control)
              ai_battery_tui=0
              ;;
          esac
        fi
        ;;
    esac
  done
fi
ai_battery_interactive=$ai_battery_tui
if [ "${AI_BATTERY_CODEX_RECOVERY:-ask}" = off ]; then ai_battery_interactive=0; fi

# Missing commands can be repaired before launching Codex, without rerunning setup.
# An installer is only invoked after explicit selection in a real terminal.
ai_battery_recover_codex() {
  printf '\nai-battery: codex was not found on PATH.\n' >&2
  printf '%s\n' 'No usable existing installation or saved entrypoint was found.' 'Install command: npm install -g @openai/codex@latest' >&2
  printf '%s\n' 'Other supported installations: brew install --cask codex, or the standalone installer at https://learn.chatgpt.com/docs/codex/cli#getting-started' >&2

  if [ "$ai_battery_interactive" != 1 ]; then
    printf '%s\n' 'The saved command is also unavailable. Install the package or add it to PATH, then retry.' >&2
    return 127
  fi

  ai_battery_npm=$(ai_battery_find_command npm) || ai_battery_npm=
  ai_battery_brew=$(ai_battery_find_command brew) || ai_battery_brew=
  while :; do
    ai_battery_default_choice=0
    if [ -n "$ai_battery_npm" ]; then
      printf '\n  1) Install using the current npm and retry\n' >&2
    fi
    if [ -n "$ai_battery_brew" ]; then printf '\n  2) Install using Homebrew and retry\n' >&2; fi
    printf '  0) Exit\nChoice [%s]: ' "$ai_battery_default_choice" >&2
    IFS= read -r ai_battery_choice || ai_battery_choice=0
    ai_battery_choice=${ai_battery_choice:-$ai_battery_default_choice}
    case "$ai_battery_choice" in
      1)
        if [ -z "$ai_battery_npm" ]; then
          printf '%s\n' 'npm is unavailable. Choose one of the displayed options.' >&2
          continue
        fi
        printf '\nai-battery: running npm install -g @openai/codex@latest\n' >&2
        if "$ai_battery_npm" install -g @openai/codex@latest >&2; then
          ai_battery_resolve || return 127
          if [ -n "$ai_battery_codex" ]; then
            printf 'Ready: %s\n' "$ai_battery_codex" >&2
            return 0
          fi
          printf '%s\n' 'npm finished, but the command is still missing from PATH. Check npm prefix -g and add its bin directory to PATH.' >&2
        else
          printf '%s\n' 'Installation failed. Check the npm output above, or choose another option.' >&2
        fi
        ;;
      2)
        if [ -z "$ai_battery_brew" ]; then
          printf '%s\n' 'Homebrew is unavailable. Choose one of the displayed options.' >&2
          continue
        fi
        if "$ai_battery_brew" install --cask codex >&2; then
          ai_battery_resolve || return 127
          if [ -n "$ai_battery_codex" ]; then return 0; fi
          printf '%s\n' 'Homebrew finished, but codex is still unavailable. Check its bin directory on PATH.' >&2
        else
          printf '%s\n' 'Installation failed. Check the Homebrew output above, or choose another option.' >&2
        fi
        ;;
      0) exit 0 ;;
      *) printf '%s\n' 'Choose one of the displayed options.' >&2 ;;
    esac
  done
}

if [ -z "$ai_battery_codex" ]; then
  ai_battery_recover_codex || exit $?
  [ -n "$ai_battery_codex" ] || exit 127
elif [ "$ai_battery_codex_source" != path ]; then
  printf 'ai-battery: Reusing codex at %s (%s)\n' "$ai_battery_codex" "$ai_battery_codex_kind" >&2
fi

if [ "$ai_battery_interactive" = 1 ]; then
  if [ -z "$ai_battery_runner" ]; then
    printf '%s\n' 'ai-battery: No usable runner is available; continuing without the AI Battery row.' 'To restore the row: npm install -g ai-battery@latest' >&2
  elif [ "$ai_battery_runner" != "$ai_battery_active_bin/ai-battery-run" ]; then
    printf 'ai-battery: Reusing ai-battery-run at %s\n' "$ai_battery_runner" >&2
  fi
  if [ "$ai_battery_codex_kind" = homebrew ]; then
    printf 'ai-battery: Using Homebrew Codex at %s\n' "$ai_battery_codex" >&2
  fi
fi
export AI_BATTERY_ORIGINAL_CODEX="$ai_battery_codex"
unset AI_BATTERY_WRAPPED_CODEX
# A native installation must not inherit a parent npm launcher's update owner.
case "$ai_battery_codex_kind" in
  standalone|homebrew)
    unset CODEX_MANAGED_BY_NPM CODEX_MANAGED_BY_BUN CODEX_MANAGED_BY_PNPM CODEX_MANAGED_BY_VITE_PLUS CODEX_MANAGED_PACKAGE_ROOT
    ;;
esac

# Use a quoted, prefix-scoped npm command for updates to a reused installation.
# Never redirect the project's PATH or global npm prefix during normal work.
ai_battery_quote() {
  ai_battery_quote_rest=$1
  printf "'"
  while :; do
    case "$ai_battery_quote_rest" in
      *"'"*)
        printf '%s' "${ai_battery_quote_rest%%"'"*}"
        printf '%s' "'\\''"
        ai_battery_quote_rest=${ai_battery_quote_rest#*"'"}
        ;;
      *) printf "%s'" "$ai_battery_quote_rest"; return ;;
    esac
  done
}
ai_battery_active_node_target=$(ai_battery_realpath "$ai_battery_active_node") || ai_battery_active_node_target=
ai_battery_codex_node_target=$(ai_battery_realpath "$ai_battery_codex_node") || ai_battery_codex_node_target=
if [ -n "$ai_battery_codex_node" ] && [ "$ai_battery_codex_node_target" != "$ai_battery_active_node_target" ]; then
  printf 'ai-battery: Codex is using another Node installation: %s\n' "$ai_battery_codex_node" >&2
  printf 'Project Node remains: %s\n' "${ai_battery_active_node:-not found on PATH}" >&2
fi
ai_battery_update_prefix=$ai_battery_codex_prefix
ai_battery_update_npm=$ai_battery_update_prefix/lib/node_modules/npm/bin/npm-cli.js
if [ ! -f "$ai_battery_update_npm" ]; then
  ai_battery_update_npm=${ai_battery_codex_node%/bin/node}/lib/node_modules/npm/bin/npm-cli.js
fi
if [ "$ai_battery_scoped_update" = 1 ] && [ "$ai_battery_codex_kind" = npm ]; then
  if [ -f "$ai_battery_update_npm" ]; then
    if [ "$#" = 1 ] && [ "$1" = update ]; then
      printf 'ai-battery: Updating the reused Codex installation at %s\n' "$ai_battery_update_prefix" >&2
      PATH="${ai_battery_codex_node%/*}:$PATH" exec "$ai_battery_codex_node" "$ai_battery_update_npm" install -g --prefix "$ai_battery_update_prefix" @openai/codex@latest
    fi
    {
      printf 'To update this installation, run codex update or:\n  PATH='
      ai_battery_quote "${ai_battery_codex_node%/*}"
      printf ':"$PATH" '
      ai_battery_quote "$ai_battery_codex_node"
      printf ' '
      ai_battery_quote "$ai_battery_update_npm"
      printf ' install -g --prefix '
      ai_battery_quote "$ai_battery_update_prefix"
      printf ' @openai/codex@latest\n'
    } >&2
  else
    printf '%s\n' 'The reused Node installation has no npm CLI. Restore its npm, or install Codex in the current npm environment to switch.' >&2
    if [ "$#" = 1 ] && [ "$1" = update ]; then exit 127; fi
  fi
elif [ "$ai_battery_codex_kind" = homebrew ]; then
  ai_battery_update_brew=$ai_battery_codex_prefix/bin/brew
  ai_battery_brew_type=--cask
  case "$ai_battery_codex_target" in */Cellar/codex/*) ai_battery_brew_type=--formula ;; esac
  if [ "$#" = 1 ] && [ "$1" = update ]; then
    if [ -f "$ai_battery_update_brew" ] && [ -x "$ai_battery_update_brew" ]; then
      exec "$ai_battery_update_brew" upgrade "$ai_battery_brew_type" codex
    fi
    printf 'ai-battery: Restore Homebrew at %s to update this installation.\n' "$ai_battery_update_brew" >&2
    exit 127
  fi
  if [ "$ai_battery_scoped_update" = 1 ]; then
    { printf 'To update this installation, run codex update or: '; ai_battery_quote "$ai_battery_update_brew"; printf ' upgrade %s codex\n' "$ai_battery_brew_type"; } >&2
  fi
fi
if [ "$ai_battery_scoped_update" = 1 ] && [ "$ai_battery_tui" = 1 ]; then
  # Replace a manager command that could update a different installation.
  set -- -c check_for_update_on_startup=false "$@"
fi
if [ -n "$ai_battery_codex_node" ]; then
  set -- "$ai_battery_codex_node" "$ai_battery_codex" "$@"
else
  set -- "$ai_battery_codex" "$@"
fi
if [ -t 0 ] && [ -t 1 ] && [ -x "$ai_battery_runner" ]; then
  unset AI_BATTERY_NODE
  if [ -n "$ai_battery_runner_node" ]; then export AI_BATTERY_NODE="$ai_battery_runner_node"; fi
  export AI_BATTERY_WRAPPED_CODEX=1
  exec "$ai_battery_runner" --provider all -- "$@"
fi
exec "$@"
