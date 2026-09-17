#!/usr/bin/env bash
# Stop hook: bloquea el stop si hay archivos de funcionalidad modificados
# sin que CLAUDE.md haya sido actualizado en el mismo turno
#
# Port a bash de check-update.ps1 (el original solo corría en Windows).

set -uo pipefail

[ -n "${CLAUDE_PROJECT_DIR:-}" ] || exit 0

flag="$CLAUDE_PROJECT_DIR/.claude/needs-update"
[ -f "$flag" ] || exit 0

TIMESTAMP=$(cat "$flag" 2>/dev/null) HOY=$(date '+%Y-%m-%d') python3 -c '
import json, os

contexto = """HOOK POST-TAREA (activado: {ts}):
Modificaste archivos de funcionalidad (index.html o supabase/functions/) pero CLAUDE.md no fue actualizado en este turno.

Antes de terminar, actualiza CLAUDE.md:
1. Marca la funcionalidad completada con ✅ y fecha ({hoy}).
2. Añade decisiones técnicas nuevas tomadas.
3. Actualiza el historial de commits con el hash nuevo.
4. Si hubo cambios en la BD, actualiza esa sección.

Luego haz commit y push de CLAUDE.md.
""".format(ts=os.environ.get("TIMESTAMP", ""), hoy=os.environ["HOY"])

print(json.dumps({
    "decision": "block",
    "reason": "CLAUDE.md no fue actualizado tras modificar archivos de funcionalidad",
    "hookSpecificOutput": {
        "hookEventName": "Stop",
        "additionalContext": contexto,
    },
}, ensure_ascii=False))
'

exit 0
