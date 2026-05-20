"""
Extrae personas y relaciones de los chunks del archivo mediante Gemini,
e inserta los resultados en las tablas `personas` y `relaciones` de Supabase.

Reanudable: los chunk_id ya procesados se guardan en .temp/procesados.txt.
Ejecutar: python extraer_personas.py
"""

import os, time, json, re
from pathlib import Path
from dotenv import load_dotenv
import requests
from supabase import create_client

load_dotenv()
SUPABASE_URL      = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
GEMINI_API_KEY    = os.environ["GEMINI_API_KEY"]
GEMINI_CHAT_URL   = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
PAUSA_SEGUNDOS    = 6   # rate limit Gemini

PROCESADOS_FILE = Path(".temp/procesados.txt")
PROCESADOS_FILE.parent.mkdir(exist_ok=True)

supa = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

PROMPT = """\
Analiza este fragmento de un documento histórico de las Escuelas Pías (siglo XVII).
Extrae SOLO personas claramente nombradas en el texto y sus relaciones mutuas.

Responde ÚNICAMENTE con JSON válido, sin markdown, sin texto adicional:
{{"personas":[{{"nombre":"nombre completo o como aparece","rol":"cargo o función","periodo":"años aproximados si se mencionan"}}],"relaciones":[{{"persona_a":"nombre exacto","persona_b":"nombre exacto","tipo":"tipo de relación breve"}}]}}

Si no hay personas o no hay relaciones claras, devuelve: {{"personas":[],"relaciones":[]}}

FRAGMENTO:
{contenido}"""


def cargar_procesados() -> set:
    if not PROCESADOS_FILE.exists():
        return set()
    return set(PROCESADOS_FILE.read_text(encoding="utf-8").splitlines())


def marcar_procesado(chunk_id: str):
    with PROCESADOS_FILE.open("a", encoding="utf-8") as f:
        f.write(chunk_id + "\n")


def llamar_gemini(contenido: str) -> dict:
    body = {"contents": [{"role": "user", "parts": [{"text": PROMPT.format(contenido=contenido)}]}]}
    resp = requests.post(
        GEMINI_CHAT_URL,
        headers={"x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json"},
        json=body,
        timeout=60,
    )
    if not resp.ok:
        raise RuntimeError(f"Gemini error {resp.status_code}: {resp.text[:200]}")
    texto = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    texto = re.sub(r"^```(?:json)?\s*", "", texto)
    texto = re.sub(r"\s*```$", "", texto.strip())
    return json.loads(texto)


def upsert_persona(nombre: str, rol: str, periodo: str) -> str | None:
    nombre = nombre.strip()[:200]
    if not nombre:
        return None
    try:
        res = supa.table("personas").upsert(
            {
                "nombre": nombre,
                "rol":    (rol    or "")[:100] or None,
                "periodo":(periodo or "")[:100] or None,
            },
            on_conflict="nombre",
        ).execute()
        return res.data[0]["id"] if res.data else None
    except Exception as e:
        print(f"    [WARN] upsert persona '{nombre}': {e}")
        return None


def insertar_relacion(id_a: str, id_b: str, tipo: str, chunk_id: str):
    if id_a == id_b:
        return
    try:
        supa.table("relaciones").insert({
            "persona_a": id_a,
            "persona_b": id_b,
            "tipo":      (tipo or "relacionado con")[:100],
            "chunk_id":  chunk_id,
        }).execute()
    except Exception:
        pass  # duplicados o constraint violations se ignoran


def main():
    print("Obteniendo chunks de Supabase...")
    res = supa.table("chunks").select("id, contenido").order("id").execute()
    chunks = res.data
    print(f"Total chunks: {len(chunks)}")

    procesados = cargar_procesados()
    print(f"Ya procesados: {len(procesados)}")

    nuevos = 0
    errores = 0
    for i, chunk in enumerate(chunks):
        chunk_id = str(chunk["id"])
        if chunk_id in procesados:
            continue

        print(f"[{i+1}/{len(chunks)}] chunk {chunk_id[:8]}...", end=" ", flush=True)
        try:
            datos = llamar_gemini(chunk["contenido"])
        except Exception as e:
            print(f"ERROR Gemini: {e}")
            errores += 1
            time.sleep(PAUSA_SEGUNDOS)
            continue

        nombre_a_id: dict[str, str] = {}
        for p in datos.get("personas", []):
            pid = upsert_persona(p.get("nombre", ""), p.get("rol", ""), p.get("periodo", ""))
            if pid:
                nombre_a_id[p["nombre"].strip()] = pid

        for r in datos.get("relaciones", []):
            na = r.get("persona_a", "").strip()
            nb = r.get("persona_b", "").strip()
            if na in nombre_a_id and nb in nombre_a_id:
                insertar_relacion(nombre_a_id[na], nombre_a_id[nb], r.get("tipo", ""), chunk_id)

        np = len(datos.get("personas", []))
        nr = len(datos.get("relaciones", []))
        print(f"→ {np}p {nr}r")

        marcar_procesado(chunk_id)
        nuevos += 1
        time.sleep(PAUSA_SEGUNDOS)

    print(f"\nListo. Nuevos procesados: {nuevos}, Errores: {errores}, Omitidos: {len(procesados)}")


if __name__ == "__main__":
    main()
