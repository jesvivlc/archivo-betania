# PostToolUse hook: rastrea si se modificaron archivos de funcionalidad
# Si se edita index.html o supabase/functions → activa flag
# Si se edita CLAUDE.md → desactiva flag

$rawInput = [Console]::In.ReadToEnd()
$hookInput = $rawInput | ConvertFrom-Json -ErrorAction SilentlyContinue

$projectDir = $env:CLAUDE_PROJECT_DIR
if (-not $projectDir) { exit 0 }

$flagFile = Join-Path $projectDir ".claude\needs-update"
$filePath = $hookInput.tool_input.file_path

if (-not $filePath) { exit 0 }

if ($filePath -match "CLAUDE\.md") {
    # CLAUDE.md fue actualizado — limpiar el flag
    Remove-Item -Path $flagFile -ErrorAction SilentlyContinue
} elseif ($filePath -match "index\.html|supabase[/\\]functions|\.ts$") {
    # Archivo de funcionalidad modificado — activar flag
    Set-Content -Path $flagFile -Value (Get-Date -Format "yyyy-MM-dd HH:mm:ss") -Encoding utf8
}

exit 0
