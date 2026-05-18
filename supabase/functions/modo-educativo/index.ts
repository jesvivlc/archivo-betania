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

type Nivel = "primaria" | "secundaria" | "universitario";
type Modo  = "explicar" | "quiz" | "actividad";

interface ChunkResult {
  chunk_id:         number;
  nombre_documento: string;
  drive_url:        string;
  contenido:        string;
  pagina:           number;
}

interface QuizPregunta {
  pregunta:    string;
  opciones:    string[];
  correcta:    number;
  explicacion: string;
}

// ─── Instrucciones pedagógicas ───────────────────────────────────────────────

const NIVEL_DESC: Record<Nivel, string> = {
  primaria:
    "Tu audiencia son niños de 8 a 12 años. Usa palabras muy sencillas, frases cortas y ejemplos de la vida cotidiana. Haz la historia viva y accesible. Evita tecnicismos. Puedes usar comparaciones con situaciones familiares para los niños.",
  secundaria:
    "Tu audiencia son estudiantes de 12 a 18 años. Usa lenguaje claro e introduce vocabulario histórico explicándolo. Ofrece contexto y relaciona el pasado con preguntas del presente. Nivel de bachillerato.",
  universitario:
    "Tu audiencia son estudiantes universitarios. Usa terminología académica especializada, analiza causas y consecuencias, cita las fuentes con nombre de documento y página. Nivel de rigor historiográfico.",
};

const MODO_INSTRUCCION: Record<Modo, string> = {
  explicar:
    "Proporciona una explicación clara y pedagógica del tema en párrafos bien organizados.",
  actividad:
    `Diseña una actividad pedagógica práctica sobre el tema.
Estructura tu respuesta con EXACTAMENTE estas secciones en negrita:
**OBJETIVO DE APRENDIZAJE**
**DESCRIPCIÓN DE LA ACTIVIDAD** (con pasos numerados)
**MATERIALES NECESARIOS**
**CRITERIOS DE EVALUACIÓN**`,
  quiz:
    `Genera exactamente 3 preguntas tipo test sobre el tema, basándote en los fragmentos del archivo.
IMPORTANTE: Responde ÚNICAMENTE con un objeto JSON válido, sin markdown, sin bloques de código, sin texto antes ni después.
Formato exacto requerido:
{"preguntas":[{"pregunta":"texto completo de la pregunta","opciones":["A) primera opción","B) segunda opción","C) tercera opción","D) cuarta opción"],"correcta":0,"explicacion":"explicación breve de por qué esa es la respuesta correcta"}]}
El campo "correcta" es el índice (0, 1, 2 o 3) de la opción correcta en el array "opciones".`,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

async function buscarChunks(
  supa: ReturnType<typeof createClient>,
  pregunta: string,
  apiKey: string,
): Promise<ChunkResult[]> {
  const embedding = await generarEmbedding(pregunta, apiKey);
  const { data, error } = await supa.rpc("buscar_chunks", {
    query_embedding:      embedding,
    match_count:          8,
    similarity_threshold: 0.3,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as ChunkResult[];
}

async function llamarGemini(prompt: string, apiKey: string): Promise<string> {
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

function extraerJSON(texto: string): unknown {
  // Intenta parsear directamente
  try { return JSON.parse(texto.trim()); } catch { /* continúa */ }
  // Busca un bloque JSON entre llaves
  const m = texto.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* continúa */ }
  }
  throw new Error("La respuesta no contiene JSON válido.");
}

// ─── Handler ─────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
  const DB_SERVICE_KEY = Deno.env.get("DB_SERVICE_KEY") ?? "";
  const DB_URL         = Deno.env.get("DB_URL") ?? "";

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const {
      pregunta,
      nivel  = "secundaria",
      modo   = "explicar",
    } = await req.json() as { pregunta: string; nivel?: Nivel; modo?: Modo };

    if (!pregunta?.trim()) {
      return new Response(
        JSON.stringify({ error: "El campo 'pregunta' es obligatorio." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const supa = createClient(DB_URL, DB_SERVICE_KEY);

    // Recuperar fragmentos relevantes del archivo
    const chunks = await buscarChunks(supa, pregunta.trim(), GEMINI_API_KEY);

    if (chunks.length === 0) {
      return new Response(
        JSON.stringify({ error: "No se encontraron fragmentos relevantes en el archivo." }),
        { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const contexto = chunks
      .map((c) => `[${c.nombre_documento}, pág. ${c.pagina}]\n${c.contenido}`)
      .join("\n\n---\n\n");

    const prompt = `Eres un educador especializado en Historia de las Escuelas Pías y San José de Calasanz.
${NIVEL_DESC[nivel as Nivel]}
${MODO_INSTRUCCION[modo as Modo]}

Basa tu respuesta ÚNICAMENTE en los fragmentos del archivo histórico proporcionados.
Tema consultado: "${pregunta.trim()}"

FRAGMENTOS DEL ARCHIVO:
${contexto}`;

    const respuestaRaw = await llamarGemini(prompt, GEMINI_API_KEY);

    const fuentes = chunks.map((c) => ({
      nombre:    c.nombre_documento,
      pagina:    c.pagina,
      drive_url: c.drive_url,
    }));

    if (modo === "quiz") {
      let quiz: { preguntas: QuizPregunta[] };
      try {
        quiz = extraerJSON(respuestaRaw) as { preguntas: QuizPregunta[] };
        if (!Array.isArray(quiz?.preguntas)) throw new Error("Formato de quiz inválido.");
      } catch (e) {
        return new Response(
          JSON.stringify({ error: `Error al generar el quiz: ${e instanceof Error ? e.message : String(e)}` }),
          { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ quiz, fuentes }),
        { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ respuesta: respuestaRaw, fuentes }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err), stack: (err as Error)?.stack }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
