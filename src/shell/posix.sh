# Appends to the prompt hook instead of replacing it, so an existing
# PROMPT_COMMAND or precmd keeps running. Emitted by "aura shell-init".
AURA_CLI="__AURA_CLI__"

# Start second, because pids are recycled well inside the 48h state window.
if [ -z "$AURA_SESSION" ]; then
  AURA_SESSION="shell-$$-$(date +%s)"
fi
AURA_LAST_PATH=""

aura_mark_cwd() {
  # Rule 6: a broken aura must never break a prompt.
  [ "$PWD" = "$AURA_LAST_PATH" ] && return 0
  AURA_LAST_PATH="$PWD"
  aura_out=$(command node "$AURA_CLI" mark --write --cwd "$PWD" --session "$AURA_SESSION" 2>/dev/null)
  [ -n "$aura_out" ] && printf '%s' "$aura_out"
  return 0
}

if [ -n "$ZSH_VERSION" ]; then
  case " ${precmd_functions[*]} " in
    *" aura_mark_cwd "*) ;;
    *) precmd_functions+=(aura_mark_cwd) ;;
  esac
elif [ -n "$BASH_VERSION" ]; then
  case "$PROMPT_COMMAND" in
    *aura_mark_cwd*) ;;
    "") PROMPT_COMMAND="aura_mark_cwd" ;;
    *) PROMPT_COMMAND="aura_mark_cwd;$PROMPT_COMMAND" ;;
  esac
fi
