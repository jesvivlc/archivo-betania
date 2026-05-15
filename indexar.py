"""
Indexador de PDFs desde Google Drive → Supabase con embeddings de Gemini.
Un chunk = una página. Procesa 10 páginas por bloque.
"""

import math
import os
import time

import fitz  # PyMuPDF
import requests
from dotenv import load_dotenv
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

load_dotenv()

print(f"SUPABASE_URL: {os.getenv('SUPABASE_URL')}")
print(f"SERVICE_KEY inicio: {os.getenv('SUPABASE_SERVICE_KEY', '')[:30]}")

SUPABASE_URL    = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY    = os.environ["SUPABASE_SERVICE_KEY"]
GEMINI_API_KEY  = os.environ["GEMINI_API_KEY"]
DRIVE_FOLDER_ID = os.environ["DRIVE_FOLDER_ID"]

GEMINI_EMBED_URL = (
    "https://generativelanguage.googleapis.com/v1beta/"
    "models/gemini-embedding-001:embedContent"
)
EMBED_DELAY    = 10
MAX_REINTENTOS = 5
TEMP_PDF    = os.path.join(os.path.dirname(os.path.abspath(__file__)), "temp_pdf.pdf")

SUPA_HEADERS = {
    "apikey":        SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type":  "application/json",
    "Prefer":        "return=representation",
}


# ─────────────────────────────────────────
# Google Drive
# ─────────────────────────────────────────

def build_drive_service():
    scopes = ["https://www.googleapis.com/auth/drive.readonly"]
    creds  = service_account.Credentials.from_service_account_file(
        "credentials.json", scopes=scopes
    )
    return build("drive", "v3", credentials=creds)


def listar_pdfs(service, folder_id: str) -> list[dict]:
    pdfs = []
    _listar_recursivo(service, folder_id, pdfs)
    return pdfs


def _listar_recursivo(service, folder_id: str, acum: list):
    query      = f"'{folder_id}' in parents and trashed = false"
    page_token = None
    while True:
        resp = service.files().list(
            q=query,
            fields="nextPageToken, files(id, name, mimeType, webViewLink)",
            pageToken=page_token,
        ).execute()
        for f in resp.get("files", []):
            if f["mimeType"] == "application/vnd.google-apps.folder":
                _listar_recursivo(service, f["id"], acum)
            elif f["mimeType"] == "application/pdf":
                acum.append(f)
        page_token = resp.get("nextPageToken")
        if not page_token:
            break


def descargar_pdf_a_disco(service, file_id: str, ruta: str):
    request    = service.files().get_media(fileId=file_id)
    downloader = MediaIoBaseDownload(open(ruta, "wb"), request)
    done = False
    while not done:
        _, done = downloader.next_chunk()


# ─────────────────────────────────────────
# Procesamiento de texto
# ─────────────────────────────────────────

def extraer_chunks_paginas(doc: fitz.Document, inicio: int, fin: int) -> list[dict]:
    """
    Recibe un fitz.Document abierto y un rango de páginas [inicio, fin).
    Cada página con más de 100 caracteres es un chunk.
    Devuelve [{"texto": str, "pagina": int}].
    """
    chunks = []
    for i in range(inicio, min(fin, len(doc))):
        texto = doc[i].get_text().strip()
        if len(texto) > 100:
            chunks.append({"texto": texto, "pagina": i + 1})
    return chunks


# ─────────────────────────────────────────
# Embeddings Gemini
# ─────────────────────────────────────────

def generar_embedding(texto: str) -> list[float]:
    resp = requests.post(
        GEMINI_EMBED_URL,
        headers={"Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY},
        json={
            "model":   "models/gemini-embedding-001",
            "content": {"parts": [{"text": texto}]},
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["embedding"]["values"]


# ─────────────────────────────────────────
# Supabase REST
# ─────────────────────────────────────────

def estado_documento(drive_file_id: str) -> tuple[str, int | None]:
    """
    Devuelve ("nuevo", None), ("sin_chunks", doc_id) o ("completo", doc_id).
    - "nuevo"      → no existe en documentos, hay que crearlo e indexar.
    - "sin_chunks" → existe en documentos pero no tiene chunks, indexar usando el id existente.
    - "completo"   → existe y tiene chunks, saltar.
    """
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/documentos",
        headers=SUPA_HEADERS,
        params={"drive_file_id": f"eq.{drive_file_id}", "select": "id"},
        timeout=15,
    )
    resp.raise_for_status()
    filas = resp.json()

    if not filas:
        return "nuevo", None

    doc_id = filas[0]["id"]

    resp2 = requests.get(
        f"{SUPABASE_URL}/rest/v1/chunks",
        headers=SUPA_HEADERS,
        params={"documento_id": f"eq.{doc_id}", "select": "id", "limit": 1},
        timeout=15,
    )
    resp2.raise_for_status()

    if resp2.json():
        return "completo", doc_id

    return "sin_chunks", doc_id


def insertar_documento(nombre: str, drive_file_id: str,
                       drive_url: str, total_paginas: int) -> int:
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/documentos",
        headers=SUPA_HEADERS,
        json={
            "nombre":        nombre,
            "drive_file_id": drive_file_id,
            "drive_url":     drive_url,
            "total_paginas": total_paginas,
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()[0]["id"]


def guardar_chunk(doc_id: int, chunk: dict, embedding: list[float], chunk_index: int):
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/chunks",
        headers=SUPA_HEADERS,
        json={
            "documento_id": doc_id,
            "contenido":    chunk["texto"],
            "pagina":       chunk["pagina"],
            "chunk_index":  chunk_index,
            "embedding":    embedding,
        },
        timeout=30,
    )
    resp.raise_for_status()


# ─────────────────────────────────────────
# Flujo principal
# ─────────────────────────────────────────

def main():
    print("=== Indexador de Archivo Betania ===\n")

    if os.path.exists(TEMP_PDF):
        os.remove(TEMP_PDF)
        print("  ⚠ temp_pdf.pdf residual eliminado.\n")

    drive = build_drive_service()

    print(f"Listando PDFs en carpeta {DRIVE_FOLDER_ID}...")
    pdfs = listar_pdfs(drive, DRIVE_FOLDER_ID)
    print(f"  → {len(pdfs)} PDF(s) encontrados.\n")

    for num, archivo in enumerate(pdfs, 1):
        nombre        = archivo["name"]
        drive_file_id = archivo["id"]
        drive_url     = archivo.get("webViewLink", "")

        print(f"[{num}/{len(pdfs)}] {nombre}")

        estado, doc_id = estado_documento(drive_file_id)

        if estado == "completo":
            print("  ✓ Ya indexado. Saltando.\n")
            continue
        if estado == "sin_chunks":
            print(f"  ↻ Documento ya existe (id={doc_id}) pero sin chunks — reanudando indexación.")

        print("  ↓ Descargando a disco...")
        descargar_pdf_a_disco(drive, drive_file_id, TEMP_PDF)

        doc           = fitz.open(TEMP_PDF)
        total_paginas = len(doc)
        print(f"  ✎ {total_paginas} página(s).")

        if total_paginas == 0:
            print("  ⚠ Sin páginas. Saltando.\n")
            doc.close()
            os.remove(TEMP_PDF)
            continue

        if estado == "nuevo":
            doc_id = insertar_documento(nombre, drive_file_id, drive_url, total_paginas)
        chunk_index   = 0
        total_errores = 0

        for inicio in range(0, total_paginas, 10):
            fin    = min(inicio + 10, total_paginas)
            chunks = extraer_chunks_paginas(doc, inicio, fin)

            for chunk in chunks:
                for intento in range(1, MAX_REINTENTOS + 1):
                    try:
                        embedding = generar_embedding(chunk["texto"])
                        embedding = embedding[:768]
                        guardar_chunk(doc_id, chunk, embedding, chunk_index)
                        chunk_index += 1
                        print(f"  pág {chunk['pagina']} OK", flush=True)
                        break
                    except requests.exceptions.HTTPError as e:
                        if e.response is not None and e.response.status_code == 429:
                            print(f"  ⚠ pág {chunk['pagina']} — 429 rate limit, esperando 60 s (intento {intento}/{MAX_REINTENTOS})...", flush=True)
                            time.sleep(60)
                            if intento == MAX_REINTENTOS:
                                print(f"  ✗ pág {chunk['pagina']} — saltando tras {MAX_REINTENTOS} reintentos.", flush=True)
                                total_errores += 1
                        else:
                            print(f"  ⚠ pág {chunk['pagina']} ERROR: {e}", flush=True)
                            total_errores += 1
                            break
                    except Exception as e:
                        print(f"  ⚠ pág {chunk['pagina']} ERROR: {e}", flush=True)
                        total_errores += 1
                        break
                time.sleep(EMBED_DELAY)

        doc.close()
        os.remove(TEMP_PDF)

        estado = "✓ Completado" if total_errores == 0 else f"⚠ Completado con {total_errores} error(es)"
        print(f"  {estado}\n")

    print("=== Indexación finalizada ===")


if __name__ == "__main__":
    main()
