// Bucle agentic con respuesta en streaming (Server-Sent Events) para
// consultar-archivo y consultar-fundador. Eventos, uno por línea `data: {json}`:
//   {tipo:"estado", texto}   progreso ("Buscando «…»")
//   {tipo:"texto",  texto}   fragmento de la respuesta
//   {tipo:"fin",    fuentes} cierre correcto
//   {tipo:"error",  error}   fallo (mensaje genérico; el detalle va a los logs)
import { textoValido } from "./guard.ts";

const GEMINI_STREAM_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse";

export interface Fuente {
  nombre:    string;
  pagina:    number;
  drive_url: string;
  contenido: string;
}

const TIMEOUT_GEMINI_MS = 60_000;

type Parte = Record<string, unknown>;

interface Opciones {
  contents:          unknown[];
  systemInstruction: string;
  tools:             unknown;
  apiKey:            string;
  maxVueltas:        number;
  buscar:            (termino: string) => Promise<Array<Record<string, unknown>>>;
  cors:              Record<string, string>;
}

// Itera los eventos `data:` de una respuesta SSE de Gemini.
async function* eventosGemini(resp: Response, ctrl: AbortController): AsyncGenerator<Record<string, unknown>> {
  const lector = resp.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const linea = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (linea.startsWith("data:")) {
        try { yield JSON.parse(linea.slice(5)); } catch { /* línea parcial o ruido */ }
      }
    }
  }
  } finally {
    ctrl.abort();
    lector.cancel().catch(() => {});
  }
}

export function respuestaSSE(op: Opciones): Response {
  const enc = new TextEncoder();
  let cancelado = false;
  const ctrl = new AbortController(); // se aborta si el cliente cierra la conexión

  const stream = new ReadableStream({
    async start(controller) {
      const enviar = (obj: unknown) => {
        if (cancelado) return;
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch { cancelado = true; }
      };
      const fuentes = new Map<string, Fuente>();

      try {
        for (let vuelta = 0; vuelta < op.maxVueltas && !cancelado; vuelta++) {
          const ronda = new AbortController(); // se aborta al acabar de leer esta ronda
          const resp = await fetch(GEMINI_STREAM_URL, {
            method: "POST",
            headers: { "x-goog-api-key": op.apiKey, "Content-Type": "application/json" },
            signal: AbortSignal.any([ctrl.signal, ronda.signal, AbortSignal.timeout(TIMEOUT_GEMINI_MS)]),
            body: JSON.stringify({
              system_instruction: { parts: [{ text: op.systemInstruction }] },
              tools:    op.tools,
              contents: op.contents,
            }),
          });
          if (!resp.ok) throw new Error(`Gemini stream error ${resp.status}: ${await resp.text()}`);

          const partes: Parte[] = [];
          for await (const ev of eventosGemini(resp, ronda)) {
            const nuevas = ((ev.candidates as Array<{ content?: { parts?: Parte[] } }> | undefined)?.[0]
              ?.content?.parts ?? []);
            for (const p of nuevas) {
              partes.push(p);
              if (typeof p.text === "string" && p.text && !p.thought) enviar({ tipo: "texto", texto: p.text });
            }
            if (cancelado) return;
          }
          if (partes.length === 0) throw new Error("Gemini no devolvió contenido.");

          op.contents.push({ role: "model", parts: partes });
          const llamadas = partes.filter((p) => p.functionCall !== undefined);

          if (llamadas.length === 0) {
            enviar({ tipo: "fin", fuentes: Array.from(fuentes.values()) });
            return;
          }

          const respuestas: unknown[] = [];
          for (const parte of llamadas) {
            const fc = parte.functionCall as { name: string; args?: { termino?: unknown } };
            const termino = textoValido(fc.args?.termino);
            let contenido: string;
            if (!termino) {
              contenido = "Término de búsqueda no válido.";
            } else if (cancelado) {
              return;
            } else {
              enviar({ tipo: "estado", texto: `Buscando «${termino}»…` });
              try {
                const resultados = await op.buscar(termino);
                for (const r of resultados) {
                  const key = `${r.chunk_id}`;
                  if (!fuentes.has(key)) {
                    fuentes.set(key, {
                      nombre: r.nombre_documento as string, pagina: r.pagina as number,
                      drive_url: r.drive_url as string, contenido: r.contenido as string,
                    });
                  }
                }
                contenido = resultados.length > 0
                  ? resultados.map((r) => `[Doc: ${r.nombre_documento}, pág. ${r.pagina}]\n${r.contenido}`).join("\n\n---\n\n")
                  : "No se encontraron fragmentos relevantes para este término.";
              } catch (e) {
                console.error(e);
                contenido = "Búsqueda no disponible en este momento.";
              }
            }
            respuestas.push({ functionResponse: { name: fc.name, response: { content: contenido } } });
          }
          op.contents.push({ role: "user", parts: respuestas });
          enviar({ tipo: "estado", texto: "Redactando la respuesta…" });
        }
        throw new Error("El agente superó el máximo de rondas de búsqueda.");
      } catch (err) {
        console.error(err);
        enviar({ tipo: "error", error: "Error interno. Inténtalo de nuevo en unos minutos." });
      } finally {
        try { controller.close(); } catch { /* ya cerrado */ }
      }
    },
    cancel() { cancelado = true; ctrl.abort(); },
  });

  return new Response(stream, {
    headers: { ...op.cors, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}
