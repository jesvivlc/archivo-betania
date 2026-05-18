import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";
const GEMINI_CHAT_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

type Formato = "resumen" | "detallado" | "academico";

interface ChunkResult {
  chunk_id:         number;
  nombre_documento: string;
  drive_url:        string;
  contenido:        string;
  pagina:           number;
  similarity:       number;
}

const FORMATO_INSTRUCCION: Record<Formato, string> = {
  resumen:   "Genera un informe conciso de 400-500 palabras. Usa lenguaje claro y accesible. Cada sección debe ser breve pero informativa.",
  detallado: "Genera un informe completo de 800-1000 palabras. Desarrolla cada sección con profundidad e incluye múltiples citas textuales de los documentos.",
  academico: "Genera un informe académico riguroso de 1200-1500 palabras. Usa registro formal, referencia cada afirmación con el documento y la página exacta, e incluye análisis historiográfico y contextualización crítica de las fuentes.",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

async function generarSubtemas(tema: string, apiKey: string): Promise<string[]> {
  const resp = await fetch(GEMINI_CHAT_URL, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [{ text: `Dado el tema "${tema}" en el contexto histórico de las Escuelas Pías y San José de Calasanz (siglo XVII), genera exactamente 6 términos de búsqueda en español que capturen aspectos distintos del tema. Devuelve SOLO los 6 términos, uno por línea, sin numeración ni explicaciones.` }],
      }],
    }),
  });
  if (!resp.ok) return [tema];
  const data = await resp.json();
  const texto: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return texto.split("\n")
    .map((t: string) => t.trim())
    .filter((t: string) => t.length > 2)
    .slice(0, 6);
}

async function generarEmbedding(texto: string, apiKey: string): Promise<number[]> {
  const resp = await fetch(GEMINI_EMBED_URL, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model:   "models/gemini-embedding-001",
      content: { parts: [{ text: texto }] },
    }),
  });
  if (!resp.ok) throw new Error(`Gemini embed error ${resp.status}`);
  const data = await resp.json();
  return (data.embedding.values as number[]).slice(0, 768);
}

async function buscarTermino(
  supa: ReturnType<typeof createClient>,
  termino: string,
  apiKey: string,
): Promise<ChunkResult[]> {
  try {
    const embedding = await generarEmbedding(termino, apiKey);
    const { data, error } = await supa.rpc("buscar_chunks", {
      query_embedding:      embedding,
      match_count:          5,
      similarity_threshold: 0.3,
    });
    if (error) return [];
    return (data ?? []) as ChunkResult[];
  } catch {
    return [];
  }
}

async function sintetizarInforme(
  tema: string,
  formato: Formato,
  chunks: ChunkResult[],
  apiKey: string,
): Promise<string> {
  const contexto = chunks
    .map((c) => `[${c.nombre_documento}, pág. ${c.pagina}]\n${c.contenido}`)
    .join("\n\n---\n\n");

  const prompt = `Eres el archivero digital de la Provincia de Betania de las Escuelas Pías.
Genera un informe en markdown sobre el tema: "${tema}".
${FORMATO_INSTRUCCION[formato]}

El informe debe seguir EXACTAMENTE esta estructura markdown:
# ${tema}
## Contexto histórico
## Textos clave
## Análisis
## Citas literales
## Bibliografía interna

Normas:
- Usa SOLO la información de los fragmentos proporcionados. No inventes datos ni fechas.
- En "Citas literales", transcribe fragmentos textuales de los documentos entrecomillados, indicando fuente y página.
- En "Bibliografía interna", lista los documentos citados con formato: *Nombre del documento*, pág. X.

FRAGMENTOS DEL ARCHIVO:
${contexto}`;

  const resp = await fetch(GEMINI_CHAT_URL, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    }),
  });
  if (!resp.ok) throw new Error(`Gemini chat error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

// ─── Handler ────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
  const DB_SERVICE_KEY = Deno.env.get("DB_SERVICE_KEY") ?? "";
  const DB_URL         = Deno.env.get("DB_URL") ?? "";

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const { tema, formato = "detallado" } = await req.json() as {
      tema: string;
      formato?: Formato;
    };

    if (!tema?.trim()) {
      return new Response(
        JSON.stringify({ error: "El campo 'tema' es obligatorio." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const supa = createClient(DB_URL, DB_SERVICE_KEY);

    // Paso 1: generar sub-temas para las búsquedas paralelas
    const subtemas = await generarSubtemas(tema.trim(), GEMINI_API_KEY);

    // Paso 2: búsquedas paralelas
    const resultados = await Promise.allSettled(
      subtemas.map((t) => buscarTermino(supa, t, GEMINI_API_KEY)),
    );

    // Paso 3: deduplicar por chunk_id, conservar mayor similitud
    const chunksMap = new Map<number, ChunkResult>();
    for (const r of resultados) {
      if (r.status === "fulfilled") {
        for (const chunk of r.value) {
          const existing = chunksMap.get(chunk.chunk_id);
          if (!existing || chunk.similarity > existing.similarity) {
            chunksMap.set(chunk.chunk_id, chunk);
          }
        }
      }
    }

    const chunks = Array.from(chunksMap.values())
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 20);

    if (chunks.length === 0) {
      return new Response(
        JSON.stringify({ error: `No se encontraron documentos sobre "${tema}" en el archivo.` }),
        { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // Paso 4: síntesis con Gemini
    const informe = await sintetizarInforme(tema.trim(), formato as Formato, chunks, GEMINI_API_KEY);

    const fuentes = chunks.map((c) => ({
      nombre:    c.nombre_documento,
      pagina:    c.pagina,
      drive_url: c.drive_url,
    }));

    return new Response(
      JSON.stringify({ informe, fuentes }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err), stack: (err as Error)?.stack }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
