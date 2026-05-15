# Archivo Digital · Provincia de Betania · Escuelas Pías

Sistema de búsqueda semántica sobre el fondo documental de la Provincia,
basado en Google Drive + Gemini Embeddings + Supabase pgvector + Gemini 2.0 Flash (agente RAG).

---

## Requisitos previos

- Python 3.10+
- Node.js (solo para la CLI de Supabase)
- `credentials.json` en la raíz del proyecto (cuenta de servicio de Google con acceso a Drive)
- Proyecto Supabase creado (ref: `rflfsbrdmgaidhvbuvwb`)

---

## Paso 1 — Rellenar las variables de entorno

Edita el archivo `.env` con tus credenciales (SUPABASE_URL y DRIVE_FOLDER_ID ya están rellenos):

```
SUPABASE_SERVICE_KEY=<service_role_key>
SUPABASE_ANON_KEY=<anon_key>
GEMINI_API_KEY=<tu_clave_de_gemini>
```

---

## Paso 2 — Ejecutar el schema en Supabase

1. Abre el **SQL Editor** de tu proyecto en [supabase.com](https://supabase.com).
2. Pega el contenido de `schema.sql` y ejecútalo.

Esto crea la extensión `vector`, las tablas `documentos` y `chunks`,
el índice ivfflat y la función `buscar_chunks`, con RLS y lectura pública.

---

## Paso 3 — Instalar dependencias de Python

```bash
pip install google-auth google-auth-oauthlib google-api-python-client \
            pymupdf supabase python-dotenv requests
```

---

## Paso 4 — Indexar los PDFs

```bash
python indexar.py
```

El script:
- Lista recursivamente todos los PDFs en `DRIVE_FOLDER_ID`
- Salta los que ya están indexados
- Extrae texto página a página con PyMuPDF
- Divide en chunks de 500 palabras (50 de solapamiento)
- Genera embeddings con `text-embedding-004` (768 dimensiones)
- Muestra progreso: chunk actual / total y porcentaje
- Guarda documentos y chunks en Supabase

Puedes ejecutarlo varias veces; nunca duplica documentos.

---

## Paso 5 — Autenticarse en Supabase CLI

```bash
supabase login
```

---

## Paso 6 — Vincular el proyecto

```bash
supabase link --project-ref rflfsbrdmgaidhvbuvwb
```

---

## Paso 7 — Configurar los secretos de las Edge Functions

```bash
supabase secrets set \
  GEMINI_API_KEY=<tu_clave_gemini> \
  SUPABASE_URL=https://rflfsbrdmgaidhvbuvwb.supabase.co \
  SUPABASE_SERVICE_KEY=<service_role_key>
```

---

## Paso 8 — Desplegar la función de búsqueda simple

```bash
supabase functions deploy buscar-archivo
```

---

## Paso 9 — Desplegar la función del agente

```bash
supabase functions deploy consultar-archivo
```

Tras el despliegue, las URLs tienen el formato:
```
https://rflfsbrdmgaidhvbuvwb.supabase.co/functions/v1/buscar-archivo
https://rflfsbrdmgaidhvbuvwb.supabase.co/functions/v1/consultar-archivo
```

---

## Paso 10 — Configurar el frontend

Edita `index.html` y sustituye las constantes al inicio del bloque `<script>`:

```js
const EDGE_BUSCAR    = "https://rflfsbrdmgaidhvbuvwb.supabase.co/functions/v1/buscar-archivo";
const EDGE_CONSULTAR = "https://rflfsbrdmgaidhvbuvwb.supabase.co/functions/v1/consultar-archivo";
```

---

## Paso 11 — Publicar el frontend en Vercel

```bash
# Opción A: arrastrar index.html al dashboard de Vercel (vercel.com/new)
# Opción B: desde la CLI
npx vercel --prod
```

---

## Estructura del proyecto

```
archivo-betania/
├── .env                          # Variables de entorno (no subir a git)
├── credentials.json              # Cuenta de servicio de Google Drive
├── schema.sql                    # DDL de Supabase
├── indexar.py                    # Script de indexación
├── index.html                    # Frontend (single-file)
├── README.md
└── supabase/
    └── functions/
        ├── buscar-archivo/
        │   └── index.ts          # Edge Function: búsqueda semántica simple
        └── consultar-archivo/
            └── index.ts          # Edge Function: agente RAG con Gemini 2.0 Flash
```

---

## Arquitectura

```
Usuario
  │
  ▼
index.html (Vercel)
  │
  ├─► buscar-archivo (Edge Function)
  │     └─ Gemini text-embedding-004 → buscar_chunks (Supabase RPC)
  │
  └─► consultar-archivo (Edge Function)
        └─ Gemini 2.0 Flash (function calling)
             └─ [bucle] buscar_documentos
                   └─ Gemini text-embedding-004 → buscar_chunks (Supabase RPC)
```

---

## Notas

- La indexación espera 1 s entre llamadas a Gemini para respetar los rate limits.
- El índice ivfflat necesita al menos ~1 000 vectores para ser eficiente.
- El umbral de similitud por defecto es 0,3 (coseno). Auméntalo si los resultados son poco precisos.
- Las Edge Functions de Supabase ejecutan Deno; no se necesita `package.json`.
- Todo el sistema usa exclusivamente la API de Google (Drive + Gemini); no hay dependencias de Anthropic ni OpenAI.
