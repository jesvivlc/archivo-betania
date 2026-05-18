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
│            Publicaciones · Estadísticas                 │
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
- Funciones desplegadas: `buscar-archivo`, `consultar-archivo`, `consultar-fundador`
- Runtime: Deno (no necesita package.json)
- Vinculación: `.\supabase.exe link --project-ref afzemprkgxdqzqyqjtxt`

### Git / GitHub
- Repositorio: **https://github.com/jesvivlc/archivo-betania**
- Rama: `master`
- Commits:
  - `52dea53` — commit inicial con proyecto completo
  - `bacd112` — CLAUDE.md añadido (memoria del proyecto)
  - `e486b58` — Sprint 1 · Modo Fundador (#1)

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

#### 2. Buscador multilingüe
- **Qué:** Búsquedas en latín, italiano e inglés (Calasanz escribió en los tres).
- **Arquitectura:**
  - Los embeddings de Gemini ya son multilinguales — puede funcionar sin cambios.
  - Añadir detección de idioma en las Edge Functions y traducción opcional de la query a español antes del embedding.
  - UI: chips de idioma encima del buscador.
- **Schema:** sin cambios.
- **Esfuerzo estimado:** 3-4 horas.

### Sprint 2 — Impacto investigador alto

#### 3. Línea de tiempo interactiva
- **Qué:** Visualización horizontal 1597–1648 con los volúmenes y eventos clave.
- **Arquitectura:**
  - **Fase A (rápida):** Solo frontend, usa el array `OPERA_OMNIA` ya existente.
  - **Fase B (completa):** Añadir `anio_inicio INT` y `anio_fin INT` a `documentos`. Nueva función SQL `buscar_chunks_periodo()`. Filtrado temporal en el agente.
- **Schema:** Fase B requiere migración.
- **Esfuerzo estimado:** Fase A 4h · Fase B +4h.

#### 4. Informes automáticos por tema
- **Qué:** Genera un documento estructurado (resumen / detallado / académico) sobre cualquier tema del archivo.
- **Arquitectura:**
  - Nueva Edge Function `generar-informe`.
  - Recibe `{ tema, formato }`. Ejecuta 5-6 búsquedas paralelas. Gemini sintetiza en secciones.
  - Frontend: nuevo tab con selector de tema y botón de descarga.
- **Schema:** sin cambios.
- **Esfuerzo estimado:** 4-5 horas.

### Sprint 3 — Ampliar alcance

#### 5. Bot de Telegram
- **Qué:** Bot que responde preguntas sobre el archivo desde Telegram.
- **Arquitectura:**
  - Nueva Edge Function `telegram-bot` como webhook de Telegram.
  - Reutiliza la lógica RAG de `consultar-archivo`.
  - Registro del webhook con la Telegram Bot API.
- **Schema:** sin cambios.
- **Esfuerzo estimado:** 5-6 horas.

#### 6. Modo clase de historia
- **Qué:** Tres submodos — explicación por nivel de edad, generador de actividades, quiz.
- **Arquitectura:**
  - Nueva Edge Function `modo-educativo`.
  - Parámetros: `{ pregunta, nivel: "primaria"|"secundaria"|"universitario", modo: "explicar"|"quiz"|"actividad" }`.
  - Frontend: selector de nivel + renderizado especial para quizzes.
- **Schema:** sin cambios.
- **Esfuerzo estimado:** 6-8 horas.

### Sprint 4 — Herramientas de investigación

#### 7. Comparador de épocas
- **Qué:** Compara cómo evolucionó un tema a lo largo de la vida de Calasanz (ej. 1610 vs. 1645).
- **Dependencias:** Requiere Fase B de la línea de tiempo (columnas de fecha en `documentos`).
- **Arquitectura:**
  - Nueva Edge Function `comparar-epocas`.
  - Búsquedas paralelas filtradas por período. Gemini estructura tabla comparativa.
- **Schema:** requiere migración (igual que Línea de tiempo Fase B).
- **Esfuerzo estimado:** 5-6 horas (+ la migración de schema).

#### 8. Mapa geográfico de la Provincia
- **Qué:** Mapa interactivo con las fundaciones escolapias (Roma 1597, Nárni, Frascati, Florencia, Génova, Moravia, Polonia...).
- **Arquitectura:**
  - Sin nuevo backend. Datos geográficos históricos hardcodeados en JS.
  - Leaflet.js vía CDN. Al clicar un marcador busca chunks sobre esa ciudad.
  - Nuevo tab "Mapa" en `index.html`.
- **Schema:** sin cambios.
- **Esfuerzo estimado:** 5-6 horas.

### Sprint 5 — Largo plazo

#### 9. Red de personas y relaciones
- **Qué:** Grafo interactivo de personas mencionadas en los documentos y sus relaciones.
- **Arquitectura:**
  - Nuevo script Python `extraer_personas.py`: llama a Gemini sobre cada chunk, extrae entidades.
  - Nuevas tablas: `personas(id, nombre, rol, periodo)` y `relaciones(id, persona_a, persona_b, tipo, chunk_id)`.
  - Nueva Edge Function `red-personas`.
  - D3.js force-directed graph en el frontend.
- **Schema:** 2 tablas nuevas. Extracción ~2-4h de proceso (rate limits).
- **Esfuerzo estimado:** 12-16 horas total.

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
.\supabase.exe functions deploy buscar-archivo
.\supabase.exe functions deploy consultar-archivo
.\supabase.exe functions deploy consultar-fundador

# Ver secretos configurados
supabase secrets list

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

- **Chunks sin metadatos temporales:** No hay campo `fecha` en los chunks.
  Esto limita las funcionalidades de filtrado temporal hasta implementar la
  migración de schema (ver Línea de tiempo Fase B).
