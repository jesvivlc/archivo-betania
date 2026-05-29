# CLAUDE.md — Archivo Digital · Provincia de Betania · Escuelas Pías

Contexto de proyecto para Claude Code. Lee este archivo al inicio de cada sesión.

---

## Propósito

Sistema de búsqueda semántica RAG sobre el fondo documental histórico de la
Provincia de Betania de las Escuelas Pías. Permite buscar y consultar los
10 volúmenes de la **Opera Omnia de San José de Calasanz (1557–1648)** —
fundador de la primera red de escuelas populares gratuitas de Europa.

Usuarios: investigadores, religiosos escolapios, docentes, estudiantes de historia.

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────┐
│  index.html  (Vercel · sitio estático · sin build step) │
│                                                         │
│  Pestañas: Búsqueda · Consultar · ✦ Pregunta a Calasanz │
│            Informes temáticos · Línea de tiempo ·       │
│            Comparador · Clase de historia · Mapa ·      │
│            Red de personas · Publicaciones · Stats      │
│  Home: grid de miniaturas Drive → abre visor PDF        │
└────────────────┬────────────────────────────────────────┘
                 │ fetch (CORS abierto, anon key pública)
    ┌────────────┼────────────────────┐
    ▼            ▼                    ▼
buscar-archivo  consultar-archivo  consultar-fundador
(Edge Fn·Deno) (Edge Fn·Deno)     (Edge Fn·Deno)
    │            │                    │
    │  Gemini    │  Gemini 2.5 Flash  │  Gemini 2.5 Flash
    │  emb-001   │  + func calling    │  + func calling
    │  768 dims  │  bucle agentic     │  persona Calasanz
    └────────────┴────────────────────┘
                 │
    ┌────────────┴────────────────────┐
    ▼                                 ▼
generar-informe                 modo-educativo
(Edge Fn·Deno)                  (Edge Fn·Deno)
    │                                 │
    │  6 subtemas paralelos           │  nivel: primaria/secundaria/univ
    │  top-20 chunks dedup            │  modo: explicar/actividad/quiz
    │  Gemini síntesis markdown       │  JSON quiz con extraerJSON()
    └─────────────────────────────────┘
                 ▼
    Supabase PostgreSQL + pgvector
    ┌──────────────────────────────┐
    │  documentos  (10 filas)      │
    │  chunks      (5.413 filas)   │
    │  buscar_chunks() RPC         │
    │  ivfflat · cosine · dim 768  │
    └──────────────────────────────┘
                 ▲
    indexar.py (Python · local)
    PyMuPDF · Google Drive API
    service account → credentials.json
```

### Flujo de búsqueda simple (`buscar-archivo`)
1. Recibe `{ query: string }`
2. Genera embedding con Gemini `gemini-embedding-001` (768 dims, slice de la respuesta)
3. Llama a `buscar_chunks(embedding, match_count=10, threshold=0.3)` en Supabase
4. Devuelve `{ resultados: [{chunk_id, nombre_documento, drive_url, contenido, pagina, similarity}] }`

### Flujo del agente (`consultar-archivo`)
1. Recibe `{ pregunta: string }`
2. Envía la pregunta a Gemini 2.5 Flash con `TOOLS = [buscar_documentos]`
3. Bucle `while(true)`:
   - Si Gemini devuelve `functionCall`: ejecuta `buscarEnSupabase()` para ese término
   - Si Gemini devuelve texto final: sale del bucle
4. Devuelve `{ respuesta: string, fuentes: [{nombre, pagina, drive_url, contenido}] }`
5. El modelo decide cuántas búsquedas hacer (típicamente 2–4 por pregunta)

---

## Stack tecnológico

| Capa | Tecnología | Decisión |
|---|---|---|
| Frontend | HTML + CSS + JS vanilla (sin framework) | Sin build step, deploy instantáneo, sin dependencias |
| Hosting | Vercel (sitio estático) | CDN global, deploy con CLI en segundos |
| Backend compute | Supabase Edge Functions (Deno/TypeScript) | Colocadas junto a la BD, sin cold starts pesados |
| Base de datos | Supabase PostgreSQL + pgvector | RLS nativo, extensión vectorial madura, SDK JS/Python |
| Embeddings | Google Gemini `gemini-embedding-001` (768 dims) | Multilingüe (ES/LA/IT), gratuito en el tier actual |
| LLM agente | Google Gemini 2.5 Flash | Function calling nativo, relación coste/calidad óptima |
| Almacenamiento PDFs | Google Drive | Los PDFs ya estaban allí; viewer embed gratuito |
| Indexación | Python (PyMuPDF + google-api-python-client) | Acceso a Drive con service account, control total del proceso |
| Index vectorial | ivfflat (lists=100, cosine ops) | Eficiente para 5K-100K vectores; hnsw sería mejor a >100K |

### Decisiones técnicas relevantes

**1 chunk = 1 página**
Simplicidad sobre sofisticación. Una página de Calasanz es ~300-600 palabras,
dentro del rango óptimo para embeddings. No hay lógica de solapamiento.
Ventaja: `pagina` en el resultado coincide exactamente con la página del PDF.

**Embedding truncado a 768 dims**
Gemini `embedding-001` devuelve 768 dims. El código hace `.slice(0, 768)` por
compatibilidad con el schema (explícito aunque redundante). Si se migra a
`gemini-embedding-2-preview` (mayor dimensionalidad), hay que migrar el schema.

**Umbral de similitud 0.3 (coseno)**
Valor deliberadamente bajo para no perder resultados relevantes en textos históricos
con vocabulario arcaico. Subir a 0.5 si aparecen resultados irrelevantes.

**Sin autenticación**
Decisión explícita: el archivo es público. La `anon key` está en el HTML.
El acceso es de solo lectura (RLS: `SELECT` público, sin INSERT/UPDATE/DELETE).

**Gemini 2.5 Flash en el agente, no Pro**
El agente hace 2-4 llamadas de herramientas por pregunta. Flash es suficiente
para recuperar y sintetizar fragmentos históricos. Pro no aporta calidad
apreciable para este caso de uso con el coste adicional.

**Modo Fundador: persona histórica vía SYSTEM_INSTRUCTION**
Para el tab "✦ Pregunta a Calasanz" se reutiliza exactamente la misma arquitectura
agentic de `consultar-archivo`. El único cambio es el `SYSTEM_INSTRUCTION`:
posiciona a Calasanz como narrador en primera persona, obliga a citar solo textos
del corpus y a traducir fragmentos en latín/italiano. No se necesita una capa
extra de infraestructura — solo ingeniería de prompt.

**Paleta principal (rediseño 2026-05-29)**
Paleta navy + dorado en vez del azul plano + naranja original:
`--blue: #1a3a5c`, `--blue-dark: #0f2540`, `--orange: #c9973a` (dorado académico).
Fondo cálido `--gray-bg: #f5f3ee`. Tipografía `Lora` (serif, Google Fonts) para
títulos, headers de sección y el label "Opera Omnia". Tabs en fila única con
scroll horizontal (sin wrap). Hero con gradiente oscuro y textura geométrica sutil.

**Paleta sepia para el Modo Fundador**
Theming visual diferenciado mediante CSS custom properties:
`--sepia: #7B5E2A`, `--sepia-dark: #5C3D0F`, `--sepia-light: #FEF9EE`,
`--sepia-border: #DDD0A8`, `--sepia-muted: #9C7A3A`.
Permite distinguir visualmente el contexto histórico del buscador moderno.

**Supabase CLI: usar `.\supabase.exe` en PowerShell**
El binario `supabase.exe` está en la raíz del proyecto y no está en el PATH.
Siempre usar `.\supabase.exe functions deploy <nombre>` desde PowerShell.
Docker no es necesario para deploy remoto (solo para desarrollo local).
La advertencia `WARNING: Docker is not running` puede ignorarse en deploys remotos.

---

## Estructura de carpetas

```
archivo-betania/
│
├── index.html                    # Frontend completo (único archivo web)
│   ├── <style>                   # ~400 líneas CSS (variables, componentes)
│   ├── <body>                    # Header · Hero · 4 paneles tab · Modal PDF · Footer
│   └── <script>                  # ~400 líneas JS:
│       ├── OPERA_OMNIA[]         # Datos de los 10 volúmenes (drive_id, chunks, etc.)
│       ├── PREGUNTAS_EJEMPLO[]   # 5 preguntas demo para el agente
│       ├── cambiarPestana()      # Sistema de tabs
│       ├── ejecutarBusqueda()    # Llama a buscar-archivo
│       ├── ejecutarConsulta()    # Llama a consultar-archivo
│       ├── verPDF() / cerrarPDF()# Modal visor Google Drive
│       ├── irAlHome()            # Restaura vista inicial
│       ├── renderHomeVolumes()   # Grid miniaturas (Drive thumbnail API)
│       ├── renderPublicaciones() # Grid completo pestaña Publicaciones
│       └── renderEstadisticas()  # Tabla chunks + barras animadas
│
├── schema.sql                    # DDL completo de Supabase
│   ├── CREATE TABLE documentos   # id, nombre, drive_file_id, drive_url, total_paginas
│   ├── CREATE TABLE chunks       # id, documento_id, contenido, pagina, chunk_index, embedding(768)
│   ├── CREATE INDEX ivfflat      # cosine ops, lists=100
│   ├── CREATE FUNCTION buscar_chunks()  # RPC principal
│   └── ALTER TABLE ... RLS       # Lectura pública, sin escritura
│
├── indexar.py                    # Script de indexación (ejecutar localmente)
│   ├── build_drive_service()     # Service account → Drive API
│   ├── listar_pdfs()             # Recursivo en DRIVE_FOLDER_ID
│   ├── estado_documento()        # "nuevo" | "sin_chunks" | "completo" (reanudable)
│   ├── extraer_chunks_paginas()  # PyMuPDF, 1 chunk = 1 página, min 100 chars
│   └── generar_embedding()       # Gemini API, rate limit: 10s entre llamadas
│
├── supabase/
│   └── functions/
│       ├── buscar-archivo/
│       │   └── index.ts          # Búsqueda semántica simple (sin LLM en respuesta)
│       ├── consultar-archivo/
│       │   └── index.ts          # Agente RAG con Gemini 2.5 Flash + function calling
│       └── consultar-fundador/
│           └── index.ts          # Agente RAG · Calasanz en 1ª persona (Sprint 1 ✅)
│
├── listar_modelos.py             # Utilidad: lista modelos Gemini de embedding
├── listar_modelos_chat.py        # Utilidad: lista modelos Gemini con generateContent
├── test_embedding.py             # Prueba gemini-embedding-2-preview (no en producción)
│
├── .env                          # NO en git — variables locales para indexar.py
├── credentials.json              # NO en git — service account Google Drive
├── .gitignore                    # Excluye: .env, credentials.json, supabase.exe, .temp/
├── .vercelignore                 # Excluye: todo excepto index.html
├── README.md                     # Guía de setup paso a paso (para humanos)
└── CLAUDE.md                     # Este archivo (para Claude Code)
```

---

## Base de datos

### Tabla `documentos` (10 filas — Opera Omnia completa)

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | bigint PK | Auto-generado |
| `nombre` | text | Nombre del PDF en Drive |
| `drive_file_id` | text UNIQUE | ID del archivo en Google Drive |
| `drive_url` | text | URL `webViewLink` de Drive |
| `total_paginas` | int | Total de páginas del PDF |
| `created_at` | timestamptz | Fecha de indexación |

### Tabla `chunks` (5.413 filas)

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | bigint PK | Auto-generado |
| `documento_id` | bigint FK | Referencia a `documentos` |
| `contenido` | text | Texto de la página |
| `pagina` | int | Número de página en el PDF |
| `chunk_index` | int | Índice secuencial dentro del documento |
| `embedding` | vector(768) | Embedding Gemini gemini-embedding-001 |
| `created_at` | timestamptz | — |

### Función SQL `buscar_chunks()`

```sql
buscar_chunks(
  query_embedding    vector(768),
  match_count        int     DEFAULT 10,
  similarity_threshold float  DEFAULT 0.3
)
-- Devuelve: chunk_id, documento_id, nombre_documento, drive_url,
--           contenido, pagina, similarity (float 0-1)
-- Ordenado por similitud coseno descendente
```

### Metadatos pendientes (sin implementar aún)

La tabla `chunks` no tiene campos de `fecha`, `lugar` ni `persona`.
Añadirlos requeriría una migración + re-procesamiento o extracción posterior con Gemini.

---

## Variables de entorno

### Para Edge Functions (secretos de Supabase)

```
GEMINI_API_KEY      → API key de Google AI Studio
DB_SERVICE_KEY      → service_role key de Supabase (en funciones se llama así)
DB_URL              → https://afzemprkgxdqzqyqjtxt.supabase.co
```

Gestión: `supabase secrets set GEMINI_API_KEY=...`

### Para indexar.py (archivo .env local)

```
SUPABASE_URL        → https://afzemprkgxdqzqyqjtxt.supabase.co
SUPABASE_SERVICE_KEY→ service_role key
GEMINI_API_KEY      → igual que arriba
DRIVE_FOLDER_ID     → ID de la carpeta raíz en Google Drive
```

### En el frontend (hardcodeadas en index.html)

```javascript
EDGE_BUSCAR    = "https://afzemprkgxdqzqyqjtxt.supabase.co/functions/v1/buscar-archivo"
EDGE_CONSULTAR = "https://afzemprkgxdqzqyqjtxt.supabase.co/functions/v1/consultar-archivo"
EDGE_FUNDADOR  = "https://afzemprkgxdqzqyqjtxt.supabase.co/functions/v1/consultar-fundador"
EDGE_INFORME   = "https://afzemprkgxdqzqyqjtxt.supabase.co/functions/v1/generar-informe"
EDGE_EDUCATIVO = "https://afzemprkgxdqzqyqjtxt.supabase.co/functions/v1/modo-educativo"
EDGE_PERIODO   = "https://afzemprkgxdqzqyqjtxt.supabase.co/functions/v1/buscar-periodo"
EDGE_COMPARADOR= "https://afzemprkgxdqzqyqjtxt.supabase.co/functions/v1/comparar-epocas"
EDGE_RED       = "https://afzemprkgxdqzqyqjtxt.supabase.co/functions/v1/red-personas"
ANON_KEY       = "eyJhbG..."   // anon key pública, solo lectura
```

Son públicas por diseño (archivo de acceso libre, RLS protege escritura).

---

## Datos estáticos en el frontend

El array `OPERA_OMNIA` en `index.html` tiene los 10 volúmenes hardcodeados:

```javascript
{ vol: "I",    titulo: "Constituciones Generales",           anio: "1621",      paginas: 342, chunks: 489,  drive_id: "12KpZu9..." }
{ vol: "II",   titulo: "Escritos Espirituales y Pedagógicos",anio: "c. 1615",   paginas: 287, chunks: 398,  drive_id: "1dv3RDf..." }
{ vol: "III",  titulo: "Epistolario I · 1600–1612",          anio: "1600–1612", paginas: 456, chunks: 621,  drive_id: "11DWqPL..." }
{ vol: "IV",   titulo: "Epistolario II · 1613–1619",         anio: "1613–1619", paginas: 421, chunks: 573,  drive_id: "13o3Rq0..." }
{ vol: "V",    titulo: "Epistolario III · 1620–1625",        anio: "1620–1625", paginas: 478, chunks: 652,  drive_id: "1TBsYnW..." }
{ vol: "VI",   titulo: "Epistolario IV · 1626–1630",         anio: "1626–1630", paginas: 398, chunks: 541,  drive_id: "1iW4h0P..." }
{ vol: "VII",  titulo: "Epistolario V · 1631–1636",          anio: "1631–1636", paginas: 387, chunks: 527,  drive_id: "1xZjmcr..." }
{ vol: "VIII", titulo: "Epistolario VI · 1637–1641",         anio: "1637–1641", paginas: 412, chunks: 563,  drive_id: "1H603yL..." }
{ vol: "IX",   titulo: "Epistolario VII · 1642–1648",        anio: "1642–1648", paginas: 443, chunks: 604,  drive_id: "1oj7o7n..." }
{ vol: "X",    titulo: "Documentos, Actas y Memoriales",     anio: "1617–1648", paginas: 325, chunks: 445,  drive_id: "1vIxFSZ..." }
```

Totales: 10 volúmenes · 3.949 páginas · 5.413 chunks indexados.

---

## Despliegue

### Frontend (Vercel)
- URL producción: **https://archivo-betania.vercel.app**
- Proyecto: `archivo-betania` (`prj_TWtzF5GYkpo3q3XnAWYDR0n6kIoN`)
- Org: `brunos-projects-94a4248c`
- Deploy: `vercel --prod` desde la raíz del proyecto
- Solo sube `index.html` (`.vercelignore` excluye el resto)

### Edge Functions (Supabase)
- Proyecto ref: `afzemprkgxdqzqyqjtxt`
- Deploy: `.\supabase.exe functions deploy <nombre>` (PowerShell desde raíz del proyecto)
- Funciones desplegadas: `buscar-archivo`, `consultar-archivo`, `consultar-fundador`, `generar-informe`, `modo-educativo`, `buscar-periodo`, `comparar-epocas`, `red-personas`
- Runtime: Deno (no necesita package.json)
- Vinculación: `.\supabase.exe link --project-ref afzemprkgxdqzqyqjtxt`

### Git / GitHub
- Repositorio: **https://github.com/jesvivlc/archivo-betania**
- Rama: `master`
- Commits:
  - `52dea53` — commit inicial con proyecto completo
  - `bacd112` — CLAUDE.md añadido (memoria del proyecto)
  - `e486b58` — Sprint 1 · Modo Fundador (#1)
  - `da1c17a` — Multilingüe: chips ES/LA/IT/EN + traducción automática (#2)
  - `602a364` — Informes temáticos: generar-informe Edge Fn + tab (#4)
  - `6ee0515` — Línea de tiempo interactiva Fase A (#3)
  - `b0e3e3b` — Clase de historia: modo-educativo Edge Fn + tab (#6)
  - `25d48c4` — Mapa geográfico de fundaciones con Leaflet.js (#8)
  - `5621c51` — Comparador de épocas + Línea de tiempo Fase B (#7 + #3B)
  - `59c1c45` — Red de personas y relaciones: D3 graph + Edge Fn (#9)
  - `45ac890` — fix: schema.sql — buscar_chunks_periodo + tablas personas/relaciones (auditoría bugs)
  - `e5c040b` — fix: indexar.py — reanudación por página para documentos parcialmente indexados
  - `7394892` — fix: extraer_personas.py — gemini-2.0-flash descontinuado, cambio a gemini-2.5-flash
  - (rediseño visual) — paleta navy+dorado, tipografía Lora, tabs scroll, hero mejorado

---

## Funcionalidades pendientes

Ordenadas por impacto (ver análisis completo en el historial de conversación).

### Sprint 1 — Bajo esfuerzo, impacto máximo

#### ✅ 1. Modo "¿Qué diría el Fundador?" — COMPLETADO (2026-05-18)
- **Qué:** Chat en primera persona como Calasanz, basado en sus propios textos.
- **Implementado:**
  - Edge Function `consultar-fundador` desplegada en Supabase (ref `afzemprkgxdqzqyqjtxt`).
  - Tab "✦ Pregunta a Calasanz" en `index.html` con paleta sepia, biografía introductoria, 5 preguntas de ejemplo.
  - JS: `ejecutarFundador()`, `initEjemplosFundador()`, constante `EDGE_FUNDADOR`.
  - Commit: `e486b58` | Vercel deploy: `dpl_3HhMcsDvrJS4yXkw9pfpb4N2e1nm`
- **Schema:** sin cambios.

#### ✅ 2. Buscador multilingüe — COMPLETADO (2026-05-19)
- **Qué:** Búsquedas en latín, italiano e inglés (Calasanz escribió en los tres).
- **Implementado:**
  - Chips ES/LA/IT/EN en la barra de búsqueda y en el panel Consultar.
  - `buscar-archivo` y `consultar-archivo` aceptan `{ idioma? }` y llaman a `traducirAEspanol()` si `idioma !== "es"`.
  - `SYSTEM_INSTRUCTION` del agente actualizada para forzar términos de búsqueda en español.
  - `ejecutarFundador()` NO recibe parámetro `idioma` (constraint explícito del usuario).
  - Commit: `da1c17a`
- **Schema:** sin cambios.

### Sprint 2 — Impacto investigador alto

#### ✅ 3. Línea de tiempo interactiva — COMPLETADO Fase A+B (2026-05-21)
- **Qué:** Visualización horizontal 1597–1648 con los volúmenes y eventos clave.
- **Implementado (Fase A — 2026-05-19):**
  - Tab "Línea de tiempo" con lazy init (`inicializarTimeline()` en `cambiarPestana`).
  - Eje de años (1597–1648), 5 eventos históricos marcados, 10 filas de volúmenes color-coded.
  - `tlParsearAnios()` maneja fechas aproximadas (`c. 1615`) y rangos con en-dash.
  - Commit: `6ee0515`
- **Implementado (Fase B — 2026-05-21):**
  - `documentos` tiene columnas `anio_inicio` y `anio_fin` (SMALLINT, rellenadas para los 10 volúmenes).
  - `buscar_chunks_periodo()` RPC en Supabase con solapamiento de intervalos.
  - `filtrarTimeline(volNum)` llama a `ejecutarBusquedaPeriodo()` con el rango exacto del volumen.
  - Los resultados muestran badge azul "Período XXXX–XXXX".
  - Commit: `5621c51`
- **Schema:** `ALTER TABLE documentos ADD COLUMN anio_inicio/anio_fin SMALLINT` + índice `idx_documentos_periodo`.

#### ✅ 4. Informes automáticos por tema — COMPLETADO (2026-05-19)
- **Qué:** Genera un documento estructurado (resumen / detallado / académico) sobre cualquier tema del archivo.
- **Implementado:**
  - Edge Function `generar-informe`: genera 6 subtemas → búsquedas paralelas → dedup por `chunk_id` → top-20 → síntesis Gemini en markdown (5 secciones fijas).
  - Tab "Informes temáticos" con chips de formato (Resumen/Detallado/Académico), botón descarga `.md`.
  - `markdownAHtml()`: renderer línea a línea (H1-H3, UL/LI, bold, italic, párrafos).
  - Commit: `602a364`
- **Schema:** sin cambios.

### Sprint 3 — Ampliar alcance

#### 5. Bot de Telegram
- **Qué:** Bot que responde preguntas sobre el archivo desde Telegram.
- **Arquitectura:**
  - Nueva Edge Function `telegram-bot` como webhook de Telegram.
  - Reutiliza la lógica RAG de `consultar-archivo`.
  - Registro del webhook con la Telegram Bot API.
- **Schema:** sin cambios.
- **Esfuerzo estimado:** 5-6 horas.

#### ✅ 6. Modo clase de historia — COMPLETADO (2026-05-19)
- **Qué:** Tres submodos — explicación por nivel de edad, generador de actividades, quiz.
- **Implementado:**
  - Edge Function `modo-educativo`: `NIVEL_DESC` (primaria/secundaria/universitario) + `MODO_INSTRUCCION` (explicar/actividad/quiz). Quiz retorna JSON estructurado; `extraerJSON()` como fallback parser.
  - Tab "Clase de historia" con chips de nivel y tipo, textarea, renderizado de quiz interactivo.
  - `renderizarQuiz()`: 3 preguntas con 4 opciones cada una, feedback inmediato por opción, explicación al responder, puntuación final.
  - `responderQuiz(qi, oi)`: desactiva opciones, marca correcto/incorrecto, muestra explicación.
  - Commit: `b0e3e3b`
- **Schema:** sin cambios.

### Sprint 4 — Herramientas de investigación

#### ✅ 7. Comparador de épocas — COMPLETADO (2026-05-21)
- **Qué:** Compara cómo evolucionó un tema entre dos períodos de la vida de Calasanz.
- **Implementado:**
  - Edge Function `buscar-periodo`: wrapper de `buscar_chunks_periodo` (threshold 0.25, match_count 10).
  - Edge Function `comparar-epocas`: `Promise.all` para buscar en ambos períodos en paralelo → Gemini síntesis con 4 secciones fijas (contexto A, contexto B, evolución, citas).
  - Tab "Comparador" con 4 períodos predefinidos por lado (Fundación/Reconocimiento/Consolidación/Crisis), chips de color azul (A) y violeta (B), resultado en markdown con fuentes en dos columnas.
  - Commit: `5621c51`
- **Schema:** usa `buscar_chunks_periodo()` ya creada. Sin cambios adicionales.

#### ✅ 8. Mapa geográfico de la Provincia — COMPLETADO (2026-05-20)
- **Qué:** Mapa interactivo con las fundaciones escolapias (Roma 1597, Nárni, Frascati, Florencia, Génova, Moravia, Polonia...).
- **Implementado:**
  - Leaflet.js vía CDN (v1.9.4, OpenStreetMap tiles, sin API key).
  - `FUNDACIONES` array: 10 localizaciones (Roma 1597 → Podolinec 1642) con `{ nombre, lat, lon, anio, termino, descripcion }`.
  - Tab "Mapa" con layout grid (mapa izq + panel lateral der). Lazy init en `cambiarPestana`.
  - Marcador personalizado SVG azul. Click marker → llama `buscar-archivo` con `termino` → muestra top-6 chunks + info card en el panel.
  - Commit: `25d48c4`
- **Schema:** sin cambios.

### Sprint 5 — Largo plazo

#### ✅ 9. Red de personas y relaciones — COMPLETADO (2026-05-21)
- **Qué:** Grafo interactivo de personas mencionadas en los documentos y sus relaciones.
- **Implementado:**
  - Tablas `personas(id UUID, nombre UNIQUE, rol, periodo)` y `relaciones(id UUID, persona_a, persona_b, tipo, chunk_id)` creadas en Supabase con RLS pública.
  - `extraer_personas.py`: reanudable via `.temp/procesados.txt`; itera 5413 chunks, extrae JSON de personas+relaciones con Gemini 2.5 Flash (rate limit 6s), upsert por nombre único. Ejecutar localmente antes de usar el grafo.
  - Edge Function `red-personas` (GET): devuelve top-60 personas por grado + sus relaciones como `{nodos, enlaces}`.
  - Frontend: pestaña "Red de personas" con grafo D3.js v7 force-directed. Nodos coloreados por rol, tamaño por grado, drag+zoom, clic → tarjeta de información con lista de relaciones. Inicialización lazy.
  - Commit: `59c1c45`
- **Para poblar la BD:** ejecutar `python extraer_personas.py` (~8h a 5s/chunk). Reanudable: guarda progreso en `.temp/procesados.txt`. Proceso iniciado 2026-05-29 (105 chunks ya procesados al inicio).

#### 10. Resumen semanal por email
- **Qué:** Email automático semanal con fragmentos destacados del archivo.
- **Arquitectura:**
  - Nueva tabla `suscriptores(id, email, nombre, activo)`.
  - Scheduler: `pg_cron` en Supabase (plan Pro) o cron externo.
  - Edge Function `enviar-resumen`: genera contenido con Gemini → envía con Resend API.
  - Formulario de suscripción en el footer del frontend.
- **Schema:** 1 tabla nueva.
- **Esfuerzo estimado:** 10-12 horas + configuración de pg_cron y Resend.

---

## Comandos frecuentes

```bash
# Desplegar frontend
vercel --prod

# Desplegar una Edge Function (PowerShell, desde raíz del proyecto)
# IMPORTANTE: el CLI de Supabase debe estar logueado con jesvivlc@gmail.com
# Si da 403: .\supabase.exe logout → .\supabase.exe login → .\supabase.exe link --project-ref afzemprkgxdqzqyqjtxt
.\supabase.exe functions deploy buscar-archivo
.\supabase.exe functions deploy consultar-archivo
.\supabase.exe functions deploy consultar-fundador
.\supabase.exe functions deploy generar-informe
.\supabase.exe functions deploy modo-educativo
.\supabase.exe functions deploy buscar-periodo
.\supabase.exe functions deploy comparar-epocas
.\supabase.exe functions deploy red-personas

# Ver secretos configurados
.\supabase.exe secrets list

# Indexar nuevos PDFs
python indexar.py

# Comprobar qué modelos Gemini están disponibles
python listar_modelos.py        # solo embedding
python listar_modelos_chat.py   # solo chat

# Git
git add index.html supabase/functions/...
git commit -m "descripción"
git push
```

---

## Limitaciones conocidas

- **Rate limit Gemini:** el indexador espera 10s entre embeddings. Con 5.413 chunks
  tardó varias horas en la indexación inicial. Para re-indexar, usar el mecanismo
  de reanudación (`estado_documento()` detecta "sin_chunks" y continúa).

- **ivfflat vs hnsw:** el índice actual (ivfflat, lists=100) es adecuado para
  5K-50K vectores. Si el corpus crece a >100K chunks, migrar a `hnsw` para
  mejor recall. Requiere `DROP INDEX` + `CREATE INDEX ... USING hnsw`.

- **Contexto del agente:** Gemini 2.5 Flash tiene ventana de 1M tokens pero
  el bucle agentic no usa historial multi-turno — cada pregunta es una conversación
  nueva. No hay memoria entre preguntas del usuario.

- **Sin streaming:** `consultar-archivo` devuelve la respuesta completa al final.
  Para preguntas complejas (4+ búsquedas internas) puede tardar 8-15 segundos.
  Implementar streaming con SSE mejoraría la UX percibida.

- **Metadatos temporales a nivel documento, no chunk:** `anio_inicio`/`anio_fin` están en la tabla `documentos`, no en `chunks`. El filtrado temporal funciona a nivel de volumen completo (todos los chunks del Epistolario III, por ejemplo). No hay fechas específicas por carta/chunk.
