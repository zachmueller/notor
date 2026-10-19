#!/bin/sh
# Stand-in for macOS `say` used by the voice e2e scripts: records what would
# have been spoken (plus any -v/-r flags) instead of playing audio.
LOG="${NOTOR_E2E_SAY_LOG_FILE:-/tmp/notor-e2e-say.log}"
printf '%s\t' "$*" >> "$LOG"
cat >> "$LOG"
exit 0
