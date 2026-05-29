"""
Extrae personas y relaciones de los chunks del archivo mediante Gemini,
e inserta los resultados en las tablas `personas` y `relaciones` de Supabase.

Reanudable: los chunk_id ya procesados se guardan en .temp/procesados.txt.
Errores detallados: .temp/errores.log

Ejecutar: python extraer_personas.py
"""

import os, time, json, re
from pathlib import Path
from datetime import datetime
from dotenv import load_dotenv
import requests
from supabase import create_client

load_dotenv()
SUPABASE_URL         = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
GEMINI_API_KEY       = os.environ["GEMINI_API_KEY"]

# gemini-2.5-flash: thinking blocks manejados por extraer_texto_respuesta()
GEMINI_CHAT_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-2.5-flash:generateContent"
)
PAUSA_SEGUNDOS  = 5   # 12 llamadas/min < 15 RPM del free tier

PROCESADOS_FILE = Path(".temp/procesados.txt")
ERRORES_FILE    = Path(".temp/errores.log")
PROCESADOS_FILE.parent.mkdir(exist_ok=True)

supa = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# Prompt sin .format() para evitar KeyError con llaves en el texto del chunk
PROMPT_INTRO = (
    "Analiza este fragmento de un documento histórico de las Escuelas Pías (siglo XVII).\n"
    "Extrae SOLO personas claramente nombradas en el texto y sus relaciones mutuas.\n\n"
    'Responde ÚNICAMENTE con JSON válido, sin markdown, sin texto adicional:\n'
    '{"personas":[{"nombre":"nombre completo o como aparece","rol":"cargo o función",'
    '"periodo":"años aproximados si se mencionan"}],'
    '"relaciones":[{"persona_a":"nombre exacto","persona_b":"nombre exacto",'
    '"tipo":"tipo de relación breve"}]}\n\n'
    'Si no hay personas o relaciones claras, devuelve: {"personas":[],"relaciones":[]}\n\n'
    "FRAGMENTO:\n"
)


# ── Logging ──────────────────────────────────────────────────────────────────

def log_error(chunk_id: str, mensaje: str):
    ts = datetime.now().strftime("%H:%M:%S")
    linea = f"[{ts}] chunk={chunk_id[:8]} | {mensaje}\n"
    with ERRORES_FILE.open("a", encoding="utf-8") as f:
        f.write(linea)


# ── Reanudación ───────────────────────────────────────────────────────────────

def cargar_procesados() -> set:
    if not PROCESADOS_FILE.exists():
        return set()
    return set(PROCESADOS_FILE.read_text(encoding="utf-8").splitlines())


def marcar_procesado(chunk_id: str):
    with PROCESADOS_FILE.open("a", encoding="utf-8") as f:
        f.write(chunk_id + "\n")


# ── Gemini ────────────────────────────────────────────────────────────────────

def extraer_texto_respuesta(resp_json: dict) -> str:
    """
    Extrae el texto de la respuesta de Gemini.
    Con gemini-2.5-flash, 'parts' puede incluir bloques de thinking
    ({"thought": true, "text": "..."}). Ignoramos esos y tomamos
    el primer part que NO sea thought.
    Con gemini-2.0-flash no hay thinking, pero el código es igualmente seguro.
    """
    parts = resp_json["candidates"][0]["content"]["parts"]
    for part in parts:
        if not part.get("thought", False) and "text" in part:
            return part["text"].strip()
    # fallback: último part
    return parts[-1].get("text", "").strip()


def limpiar_json(texto: str) -> str:
    """Elimina bloques markdown y extrae el primer objeto JSON."""
    # Quitar bloques ```json ... ``` o ``` ... ```
    texto = re.sub(r"```(?:json)?\s*", "", texto)
    texto = re.sub(r"```", "", texto).strip()
    # Extraer primer objeto JSON {...}
    m = re.search(r"\{[\s\S]*\}", texto)
    return m.group(0) if m else texto


def llamar_gemini(contenido: str, reintentos: int = 2) -> dict:
    prompt = PROMPT_INTRO + contenido
    body   = {"contents": [{"role": "user", "parts": [{"text": prompt}]}]}

    for intento in range(reintentos + 1):
        resp = requests.post(
            GEMINI_CHAT_URL,
            headers={"x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json"},
            json=body,
            timeout=60,
        )

        if resp.status_code == 429:
            espera = 60 * (intento + 1)   # 60s, 120s
            print(f"[429] rate limit — esperando {espera}s...")
            time.sleep(espera)
            continue

        if not resp.ok:
            raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")

        texto = extraer_texto_respuesta(resp.json())
        texto = limpiar_json(texto)
        return json.loads(texto)   # JSONDecodeError si aún no es JSON válido

    raise RuntimeError("Demasiados reintentos por rate limit (429)")


# ── Supabase ──────────────────────────────────────────────────────────────────

def upsert_persona(nombre: str, rol: str, periodo: str) -> str | None:
    nombre = nombre.strip()[:200]
    if not nombre:
        return None
    try:
        res = supa.table("personas").upsert(
            {
                "nombre":  nombre,
                "rol":     (rol     or "")[:100] or None,
                "periodo": (periodo or "")[:100] or None,
            },
            on_conflict="nombre",
        ).execute()
        return res.data[0]["id"] if res.data else None
    except Exception as e:
        print(f"    [WARN] upsert_persona '{nombre}': {type(e).__name__}: {e}")
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
        pass  # duplicados ignorados


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("Obteniendo chunks de Supabase...")
    res    = supa.table("chunks").select("id, contenido").order("id").execute()
    chunks = res.data
    print(f"Total chunks: {len(chunks)}")

    procesados = cargar_procesados()
    pendientes = [c for c in chunks if str(c["id"]) not in procesados]
    print(f"Ya procesados: {len(procesados)} | Pendientes: {len(pendientes)}")
    print(f"Log de errores: {ERRORES_FILE.resolve()}\n")

    nuevos  = 0
    errores = 0

    for i, chunk in enumerate(pendientes):
        chunk_id = str(chunk["id"])
        print(f"[{i+1}/{len(pendientes)}] {chunk_id[:8]}...", end=" ", flush=True)

        try:
            datos = llamar_gemini(chunk["contenido"])
        except json.JSONDecodeError as e:
            msg = f"JSONDecodeError: {e}"
            print(f"ERROR JSON — {msg}")
            log_error(chunk_id, msg)
            errores += 1
            time.sleep(PAUSA_SEGUNDOS)
            continue
        except Exception as e:
            msg = f"{type(e).__name__}: {e}"
            print(f"ERROR — {msg}")
            log_error(chunk_id, msg)
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
        nuevos  += 1
        time.sleep(PAUSA_SEGUNDOS)

    print(f"\nListo. Nuevos: {nuevos} | Errores: {errores} | Ya procesados: {len(procesados)}")
    if errores:
        print(f"Ver detalles en: {ERRORES_FILE.resolve()}")


if __name__ == "__main__":
    main()
