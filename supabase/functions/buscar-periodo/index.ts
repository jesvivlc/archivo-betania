import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { proteger, corsHeaders, errorInterno, textoValido, json, LIMITES_LIGERO } from "../_shared/guard.ts";

const GEMINI_EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";

async function generarEmbedding(texto: string, apiKey: string): Promise<number[]> {
  const resp = await fetch(GEMINI_EMBED_URL, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model:   "models/gemini-embedding-001",
      content: { parts: [{ text: texto }] },
    }),
  });
  if (!resp.ok) throw new Error(`Gemini embed error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return (data.embedding.values as number[]).slice(0, 768);
}

serve(async (req: Request) => {
  const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
  const DB_SERVICE_KEY = Deno.env.get("DB_SERVICE_KEY") ?? "";
  const DB_URL         = Deno.env.get("DB_URL") ?? "";

  const g = await proteger(req, { funcion: "buscar-periodo", limites: LIMITES_LIGERO });
  if (!g.ok) return g.res;
  const CORS_HEADERS = corsHeaders(req);

  try {
    const { query, anio_ini, anio_fin } = g.body as {
      query:    string;
      anio_ini: number;
      anio_fin: number;
    };

    if (!textoValido(query)) {
      return new Response(
        JSON.stringify({ error: "El campo 'query' es obligatorio (máximo 500 caracteres)." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    if (!Number.isInteger(anio_ini) || !Number.isInteger(anio_fin) || anio_ini < 1500 || anio_fin > 1700 || anio_ini > anio_fin) {
      return json({ error: "anio_ini y anio_fin deben ser años enteros entre 1500 y 1700." }, 400, CORS_HEADERS);
    }

    const embedding = await generarEmbedding(query.trim(), GEMINI_API_KEY);
    const supa      = createClient(DB_URL, DB_SERVICE_KEY);

    const { data, error } = await supa.rpc("buscar_chunks_periodo", {
      query_embedding:      embedding,
      anio_ini:             anio_ini,
      anio_fin:             anio_fin,
      match_count:          10,
      similarity_threshold: 0.25,
    });

    if (error) throw new Error(error.message);

    return new Response(
      JSON.stringify({ resultados: data ?? [] }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return errorInterno(err, CORS_HEADERS);
  }
});
