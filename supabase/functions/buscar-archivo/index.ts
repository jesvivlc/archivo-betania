import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";

async function generarEmbedding(texto: string, apiKey: string): Promise<number[]> {
  const resp = await fetch(GEMINI_EMBED_URL, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type":   "application/json",
    },
    body: JSON.stringify({
      model:   "models/gemini-embedding-001",
      content: { parts: [{ text: texto }] },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const embedding = (data.embedding.values as number[]).slice(0, 768);
  return embedding;
}

serve(async (req: Request) => {
  const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
  const DB_SERVICE_KEY = Deno.env.get("DB_SERVICE_KEY") ?? "";
  const DB_URL = Deno.env.get("DB_URL") ?? "";

  console.log("Keys check - Gemini:", GEMINI_API_KEY.length, "DB:", DB_SERVICE_KEY.length);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const { query } = await req.json() as { query: string };

    if (!query?.trim()) {
      return new Response(
        JSON.stringify({ error: "El campo 'query' es obligatorio." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // Generar embedding de la consulta
    const embedding = await generarEmbedding(query.trim(), GEMINI_API_KEY);

    // Buscar en Supabase
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
