import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { respuestaSSE } from "../_shared/agente.ts";
import { proteger, corsHeaders, errorInterno, textoValido, json, LIMITES_AGENTE } from "../_shared/guard.ts";

// Tope de rondas del bucle agentic: evita gasto ilimitado de Gemini por petición.
const MAX_VUELTAS = 6;

const GEMINI_EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";
const GEMINI_CHAT_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

const SYSTEM_INSTRUCTION = `Eres José de Calasanz (Peralta de la Sal, Aragón, 1557 – Roma, 1648),
fundador de las Escuelas Pías, la primera red de escuelas populares gratuitas de Europa.

Hablas en primera persona, con el tono y el espíritu de tus propias cartas y escritos:
espiritual, paternal, directo, sereno ante el sufrimiento, firme en la misión.
Tu lema es "Piedad y Letras" (Pietas et Litterae).

Cuando alguien te pregunta:
1. Identifica 2-3 términos clave y usa buscar_documentos para encontrar
   lo que tú mismo escribiste sobre ese tema en tus cartas, constituciones o escritos.
2. Responde en primera persona, citando textualmente fragmentos de tus propias palabras.
3. Si el texto original está en latín o italiano, tradúcelo al español
   e indica entre paréntesis el idioma original.
4. Si no encuentras texto relevante en tus documentos, dilo con honestidad:
   no inventes ni atribuyas palabras que no hayas escrito.
5. Al final de tu respuesta, indica el documento y la página de cada cita.

Responde siempre en español.
No eres un asistente moderno: eres Calasanz, que habla desde sus escritos históricos.
Tu voz es la de un hombre que sufrió la persecución pero nunca abandonó la misión
de educar gratuitamente a los niños más pobres.`;

const TOOLS = [
  {
    functionDeclarations: [
      {
        name:        "buscar_documentos",
        description: "Busca en los escritos de Calasanz: cartas, constituciones y documentos históricos de las Escuelas Pías",
        parameters: {
          type: "object",
          properties: {
            termino: {
              type:        "string",
              description: "término o frase de búsqueda",
            },
          },
          required: ["termino"],
        },
      },
    ],
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

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

  const g = await proteger(req, { funcion: "consultar-fundador", limites: LIMITES_AGENTE });
  if (!g.ok) return g.res;
  const CORS_HEADERS = corsHeaders(req);

  try {
    const { pregunta } = g.body as { pregunta: string };

    if (!textoValido(pregunta)) {
      return new Response(
        JSON.stringify({ error: "El campo 'pregunta' es obligatorio (máximo 500 caracteres)." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const supa = createClient(DB_URL, DB_SERVICE_KEY);

    const contents: unknown[] = [
      { role: "user", parts: [{ text: pregunta.trim() }] },
    ];

    // Modo streaming (SSE): lo activa el frontend con { stream: true }.
    if (g.body.stream === true) {
      return respuestaSSE({
        contents, systemInstruction: SYSTEM_INSTRUCTION, tools: TOOLS, apiKey: GEMINI_API_KEY,
        maxVueltas: MAX_VUELTAS, cors: CORS_HEADERS,
        buscar: (termino) => buscarEnSupabase(supa, termino, GEMINI_API_KEY),
      });
    }

    const fuentesMap = new Map<string, Fuente>();

    for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
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
        const termino = textoValido(fc.args?.termino) ?? "";
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
          console.error(e);
          respContent = "Búsqueda no disponible en este momento.";
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
    throw new Error("El agente superó el máximo de rondas de búsqueda.");
  } catch (err) {
    return errorInterno(err, CORS_HEADERS);
  }
});
