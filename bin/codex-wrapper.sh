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

# Codex follows the caller's PATH and its own launcher. Only AI Battery
# wrappers are skipped, so npm, Homebrew and standalone installs behave alike.
ai_battery_find_command() {
  ai_battery_remaining_path=$PATH
  while :; do
    case "$ai_battery_remaining_path" in
      *:*)
        ai_battery_dir=${ai_battery_remaining_path%%:*}
        ai_battery_remaining_path=${ai_battery_remaining_path#*:}
        ai_battery_more=1 ;;
      *) ai_battery_dir=$ai_battery_remaining_path; ai_battery_more=0 ;;
    esac
    ai_battery_candidate=${ai_battery_dir:-.}/$1
    if [ -f "$ai_battery_candidate" ] && [ -x "$ai_battery_candidate" ]; then
      if [ "$1" = codex ]; then
        ai_battery_target=$(ai_battery_realpath "$ai_battery_candidate") || ai_battery_target=$ai_battery_candidate
        if ! ai_battery_is_excluded "$ai_battery_candidate" && ! ai_battery_is_wrapper "$ai_battery_target"; then
          printf '%s\n' "$ai_battery_candidate"
          return 0
        fi
      elif [ "$1" != ai-battery-run ] || ai_battery_usable_runner "$ai_battery_candidate"; then
        printf '%s\n' "$ai_battery_candidate"
        return 0
      fi
    fi
    [ "$ai_battery_more" = 1 ] || break
  done
  return 1
}

ai_battery_usable_runner() {
  [ -f "$1" ] && [ -x "$1" ] || return 1
  ai_battery_runner_target=$(ai_battery_realpath "$1") || return 1
  ai_battery_runner_header=$("$ai_battery_head" -c 64 "$ai_battery_runner_target" 2>/dev/null) || return 1
  case "$ai_battery_runner_header" in
    '#!/usr/bin/env python3'*) command -v python3 >/dev/null 2>&1 || return 1 ;;
  esac
  case "$ai_battery_runner_target" in
    */versions/node/*) ai_battery_nvm_node "$ai_battery_runner_target" >/dev/null ;;
    *) return 0 ;;
  esac
}

ai_battery_codex=$(ai_battery_find_command codex) || ai_battery_codex=
ai_battery_codex_target=
if [ -n "$ai_battery_codex" ]; then
  ai_battery_codex_target=$(ai_battery_realpath "$ai_battery_codex") || ai_battery_codex_target=$ai_battery_codex
fi
ai_battery_active_node=$(ai_battery_find_command node) || ai_battery_active_node=
ai_battery_runner=$(ai_battery_find_command ai-battery-run) || ai_battery_runner=
if [ -z "$ai_battery_runner" ] && ai_battery_usable_runner "$ai_battery_configured_runner"; then
  ai_battery_runner=$ai_battery_configured_runner
fi
ai_battery_runner_node=
if [ -n "$ai_battery_runner" ]; then
  ai_battery_runner_target=$(ai_battery_realpath "$ai_battery_runner") || ai_battery_runner_target=
  ai_battery_runner_node=$(ai_battery_nvm_node "$ai_battery_runner_target") || ai_battery_runner_node=
fi

if [ "${AI_BATTERY_CODEX_RESOLVE_ONLY:-}" = 1 ]; then
  printf '%s\000' "$ai_battery_codex" "$ai_battery_codex_target" "$ai_battery_runner" "$ai_battery_runner_node" "$ai_battery_active_node"
  exit 0
fi
if [ -z "$ai_battery_codex" ]; then
  printf '%s\n' 'codex: command not found on PATH' >&2
  exit 127
fi
export AI_BATTERY_ORIGINAL_CODEX="$ai_battery_codex"
unset AI_BATTERY_WRAPPED_CODEX
if [ -t 0 ] && [ -t 1 ] && [ -x "$ai_battery_runner" ]; then
  # This runtime is for usage polling only. Codex keeps its own shebang and PATH.
  unset AI_BATTERY_NODE
  if [ -n "$ai_battery_runner_node" ]; then export AI_BATTERY_NODE="$ai_battery_runner_node"; fi
  export AI_BATTERY_WRAPPED_CODEX=1
  exec "$ai_battery_runner" --provider all -- "$ai_battery_codex" "$@"
fi
exec "$ai_battery_codex" "$@"
