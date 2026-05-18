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

// ─── Helpers ────────────────────────────────────────────────────────────────

async function traducirAEspanol(texto: string, apiKey: string): Promise<string> {
  const resp = await fetch(GEMINI_CHAT_URL, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [{ text: `Traduce al español. Devuelve SOLO la traducción, sin explicaciones ni texto adicional.\n\n${texto}` }],
      }],
    }),
  });
  if (!resp.ok) return texto;
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? texto;
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
  if (!resp.ok) throw new Error(`Gemini error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return (data.embedding.values as number[]).slice(0, 768);
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
    const { query, idioma } = await req.json() as { query: string; idioma?: string };

    if (!query?.trim()) {
      return new Response(
        JSON.stringify({ error: "El campo 'query' es obligatorio." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // Traducir al español si la query viene en otro idioma
    const necesitaTraduccion = idioma && idioma !== "es";
    const queryBusqueda = necesitaTraduccion
      ? await traducirAEspanol(query.trim(), GEMINI_API_KEY)
      : query.trim();

    const embedding = await generarEmbedding(queryBusqueda, GEMINI_API_KEY);

    const supa = createClient(DB_URL, DB_SERVICE_KEY);
    const { data, error } = await supa.rpc("buscar_chunks", {
      query_embedding:      embedding,
      match_count:          10,
      similarity_threshold: 0.3,
    });

    if (error) throw new Error(error.message);

    return new Response(
      JSON.stringify({ resultados: data ?? [] }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err), stack: (err as Error)?.stack }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
