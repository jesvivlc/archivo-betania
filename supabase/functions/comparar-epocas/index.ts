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

interface Periodo   { inicio: number; fin: number; }

interface ChunkResult {
  chunk_id:         string;
  nombre_documento: string;
  drive_url:        string;
  contenido:        string;
  pagina:           number;
  similarity:       number;
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

async function buscarPeriodo(
  supa:      ReturnType<typeof createClient>,
  embedding: number[],
  periodo:   Periodo,
): Promise<ChunkResult[]> {
  const { data, error } = await supa.rpc("buscar_chunks_periodo", {
    query_embedding:      embedding,
    anio_ini:             periodo.inicio,
    anio_fin:             periodo.fin,
    match_count:          8,
    similarity_threshold: 0.25,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as ChunkResult[];
}

async function sintetizarComparacion(
  tema:      string,
  periodo_a: Periodo,
  chunks_a:  ChunkResult[],
  periodo_b: Periodo,
  chunks_b:  ChunkResult[],
  apiKey:    string,
): Promise<string> {
  const formatear = (chunks: ChunkResult[]) =>
    chunks.length > 0
      ? chunks.map((c) => `[${c.nombre_documento}, pág. ${c.pagina}]\n${c.contenido}`).join("\n\n---\n\n")
      : "No se encontraron fragmentos del archivo para este período.";

  const prompt = `Eres el archivero digital de la Provincia de Betania de las Escuelas Pías.
Analiza cómo evolucionó el tema "${tema}" entre dos períodos de la vida y obra de San José de Calasanz.
Usa ÚNICAMENTE los fragmentos del archivo proporcionados. No inventes datos ni fechas.
Cita siempre el documento y la página para cada afirmación.

El informe debe seguir EXACTAMENTE esta estructura markdown:

## ${periodo_a.inicio}–${periodo_a.fin}: Contexto y posición de Calasanz
## ${periodo_b.inicio}–${periodo_b.fin}: Contexto y posición de Calasanz
## Evolución: qué cambió y qué permaneció
## Citas literales representativas

FRAGMENTOS PERÍODO A (${periodo_a.inicio}–${periodo_a.fin}):
${formatear(chunks_a)}

FRAGMENTOS PERÍODO B (${periodo_b.inicio}–${periodo_b.fin}):
${formatear(chunks_b)}`;

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

serve(async (req: Request) => {
  const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
  const DB_SERVICE_KEY = Deno.env.get("DB_SERVICE_KEY") ?? "";
  const DB_URL         = Deno.env.get("DB_URL") ?? "";

  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const { tema, periodo_a, periodo_b } = await req.json() as {
      tema:      string;
      periodo_a: Periodo;
      periodo_b: Periodo;
    };

    if (!tema?.trim()) {
      return new Response(
        JSON.stringify({ error: "El campo 'tema' es obligatorio." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }
    if (!periodo_a?.inicio || !periodo_a?.fin || !periodo_b?.inicio || !periodo_b?.fin) {
      return new Response(
        JSON.stringify({ error: "periodo_a y periodo_b requieren inicio y fin." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const supa      = createClient(DB_URL, DB_SERVICE_KEY);
    const embedding = await generarEmbedding(tema.trim(), GEMINI_API_KEY);

    const [chunks_a, chunks_b] = await Promise.all([
      buscarPeriodo(supa, embedding, periodo_a).catch(() => [] as ChunkResult[]),
      buscarPeriodo(supa, embedding, periodo_b).catch(() => [] as ChunkResult[]),
    ]);

    if (chunks_a.length === 0 && chunks_b.length === 0) {
      return new Response(
        JSON.stringify({ error: `No se encontraron documentos sobre "${tema}" en ninguno de los dos períodos.` }),
        { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const comparacion = await sintetizarComparacion(
      tema.trim(), periodo_a, chunks_a, periodo_b, chunks_b, GEMINI_API_KEY,
    );

    const fuentes_a = chunks_a.map((c) => ({ nombre: c.nombre_documento, pagina: c.pagina, drive_url: c.drive_url }));
    const fuentes_b = chunks_b.map((c) => ({ nombre: c.nombre_documento, pagina: c.pagina, drive_url: c.drive_url }));

    return new Response(
      JSON.stringify({ comparacion, fuentes_a, fuentes_b }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err), stack: (err as Error)?.stack }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
