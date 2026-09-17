#!/usr/bin/env bash
# PostToolUse hook: rastrea si se modificaron archivos de funcionalidad
# Si se edita index.html o supabase/functions → activa flag
# Si se edita CLAUDE.md → desactiva flag
#
# Port a bash de mark-needs-update.ps1 (el original solo corría en Windows).

set -uo pipefail

[ -n "${CLAUDE_PROJECT_DIR:-}" ] || exit 0

flag="$CLAUDE_PROJECT_DIR/.claude/needs-update"

# El JSON del hook llega por stdin; si viene vacío o roto, no hacemos nada.
file_path=$(python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print((d.get("tool_input") or {}).get("file_path", ""))
' 2>/dev/null) || exit 0

[ -n "$file_path" ] || exit 0

case "$file_path" in
  *CLAUDE.md*)
    # CLAUDE.md fue actualizado — limpiar el flag
    rm -f "$flag"
    ;;
  *index.html*|*supabase/functions*|*.ts)
    # Archivo de funcionalidad modificado — activar flag
    date '+%Y-%m-%d %H:%M:%S' > "$flag"
    ;;
esac

exit 0
