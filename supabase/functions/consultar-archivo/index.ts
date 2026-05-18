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

const SYSTEM_INSTRUCTION = `Eres el archivero digital de la Provincia de Betania de las Escuelas Pías.
Tienes acceso a todos los documentos publicados por la provincia a través de la herramienta buscar_documentos.
Cuando el usuario hace una pregunta:
1. Identifica 2-4 términos de búsqueda relevantes
2. Usa buscar_documentos con cada término para encontrar fragmentos
3. Analiza los fragmentos encontrados
4. Responde de forma clara citando siempre el documento y página de cada afirmación
Los términos que pases a buscar_documentos deben ser siempre en español, independientemente del idioma de la pregunta.
Responde siempre en español. Si no encuentras información suficiente, indícalo.`;

const TOOLS = [
  {
    functionDeclarations: [
      {
        name:        "buscar_documentos",
        description: "Busca fragmentos relevantes en el archivo de documentos de la provincia de Betania",
        parameters: {
          type: "object",
          properties: {
            termino: {
              type:        "string",
              description: "término o frase de búsqueda en español",
            },
          },
          required: ["termino"],
        },
      },
    ],
  },
];

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
  if (!resp.ok) throw new Error(`Gemini embed error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return (data.embedding.values as number[]).slice(0, 768);
}

async function llamarGemini(contents: unknown[], apiKey: string): Promise<unknown> {
  const resp = await fetch(GEMINI_CHAT_URL, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      tools:    TOOLS,
      contents,
    }),
  });
  if (!resp.ok) throw new Error(`Gemini chat error ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function buscarEnSupabase(
  supa: ReturnType<typeof createClient>,
  termino: string,
  apiKey: string,
): Promise<Array<Record<string, unknown>>> {
  const embedding = await generarEmbedding(termino, apiKey);
  const { data, error } = await supa.rpc("buscar_chunks", {
    query_embedding:      embedding,
    match_count:          5,
    similarity_threshold: 0.3,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<Record<string, unknown>>;
}

interface Fuente {
  nombre:    string;
  pagina:    number;
  drive_url: string;
  contenido: string;
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
    const { pregunta, idioma } = await req.json() as { pregunta: string; idioma?: string };

    if (!pregunta?.trim()) {
      return new Response(
        JSON.stringify({ error: "El campo 'pregunta' es obligatorio." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // Traducir al español si la pregunta viene en otro idioma
    const necesitaTraduccion = idioma && idioma !== "es";
    const preguntaBusqueda = necesitaTraduccion
      ? await traducirAEspanol(pregunta.trim(), GEMINI_API_KEY)
      : pregunta.trim();

    const supa = createClient(DB_URL, DB_SERVICE_KEY);

    const contents: unknown[] = [
      { role: "user", parts: [{ text: preguntaBusqueda }] },
    ];

    const fuentesMap = new Map<string, Fuente>();

    while (true) {
      const geminiData = await llamarGemini(contents, GEMINI_API_KEY) as {
        candidates: Array<{
          content: { role: string; parts: Array<Record<string, unknown>> };
          finishReason: string;
        }>;
      };

      const candidate = geminiData.candidates?.[0];
      if (!candidate) throw new Error("Gemini no devolvió candidatos.");

      const modelContent = candidate.content;
      contents.push(modelContent);

      const functionCalls = modelContent.parts.filter((p) => p.functionCall !== undefined);

      if (functionCalls.length === 0) {
        const textoFinal = modelContent.parts
          .filter((p) => typeof p.text === "string")
          .map((p) => p.text as string)
          .join("\n");

        return new Response(
          JSON.stringify({ respuesta: textoFinal, fuentes: Array.from(fuentesMap.values()) }),
          { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
        );
      }

      const functionResponseParts: unknown[] = [];

      for (const part of functionCalls) {
        const fc      = part.functionCall as { name: string; args: { termino: string } };
        const termino = fc.args.termino;
        let respContent: string;

        try {
          const resultados = await buscarEnSupabase(supa, termino, GEMINI_API_KEY);

          for (const r of resultados) {
            const key = `${r.chunk_id}`;
            if (!fuentesMap.has(key)) {
              fuentesMap.set(key, {
                nombre:    r.nombre_documento as string,
                pagina:    r.pagina as number,
                drive_url: r.drive_url as string,
                contenido: r.contenido as string,
              });
            }
          }

          respContent = resultados.length > 0
            ? resultados
                .map((r) => `[Doc: ${r.nombre_documento}, pág. ${r.pagina}]\n${r.contenido}`)
                .join("\n\n---\n\n")
            : "No se encontraron fragmentos relevantes para este término.";
        } catch (e) {
          respContent = `Error al buscar: ${e instanceof Error ? e.message : String(e)}`;
        }

        functionResponseParts.push({
          functionResponse: {
            name:     fc.name,
            response: { content: respContent },
          },
        });
      }

      contents.push({ role: "user", parts: functionResponseParts });
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err), stack: (err as Error)?.stack }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
