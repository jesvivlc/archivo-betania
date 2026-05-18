# Stop hook: bloquea el stop si hay archivos de funcionalidad modificados
# sin que CLAUDE.md haya sido actualizado en el mismo turno

$projectDir = $env:CLAUDE_PROJECT_DIR
if (-not $projectDir) { exit 0 }

$flagFile = Join-Path $projectDir ".claude\needs-update"

if (Test-Path $flagFile) {
    $timestamp = Get-Content $flagFile -ErrorAction SilentlyContinue

    $output = @{
        decision = "block"
        reason   = "CLAUDE.md no fue actualizado tras modificar archivos de funcionalidad"
        hookSpecificOutput = @{
            hookEventName   = "Stop"
            additionalContext = @"
HOOK POST-TAREA (activado: $timestamp):
Modificaste archivos de funcionalidad (index.html o supabase/functions/) pero CLAUDE.md no fue actualizado en este turno.

Antes de terminar, actualiza CLAUDE.md:
1. Marca la funcionalidad completada con ✅ y fecha ($(Get-Date -Format 'yyyy-MM-dd')).
2. Añade decisiones técnicas nuevas tomadas.
3. Actualiza el historial de commits con el hash nuevo.
4. Si hubo cambios en la BD, actualiza esa sección.

Luego haz commit y push de CLAUDE.md.
"@
        }
    } | ConvertTo-Json -Depth 5

    Write-Output $output
    exit 0
}

exit 0
