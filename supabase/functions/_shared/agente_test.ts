import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { respuestaSSE } from "./agente.ts";

const sse = (...evs: unknown[]) => new Response(evs.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(""));
const cand = (...parts: unknown[]) => ({ candidates: [{ content: { role: "model", parts } }] });

async function leer(resp: Response) {
  const out: Array<Record<string, unknown>> = [];
  for (const bloque of (await resp.text()).split("\n\n")) {
    if (bloque.startsWith("data: ")) out.push(JSON.parse(bloque.slice(6)));
  }
  return out;
}

function simular(respuestas: Response[]) {
  const real = globalThis.fetch;
  const cuerpos: unknown[] = [];
  globalThis.fetch = ((_u: unknown, init?: RequestInit) => {
    cuerpos.push(JSON.parse(String(init?.body)));
    return Promise.resolve(respuestas.shift()!);
  }) as typeof fetch;
  return { cuerpos, restaurar: () => { globalThis.fetch = real; } };
}

const base = (buscar: (t: string) => Promise<Array<Record<string, unknown>>>) => ({
  contents: [{ role: "user", parts: [{ text: "hola" }] }] as unknown[],
  systemInstruction: "sys", tools: [], apiKey: "k", maxVueltas: 3, buscar, cors: {},
});

Deno.test("búsqueda + respuesta en varios fragmentos + fuentes", async () => {
  const s = simular([
    sse(cand({ functionCall: { name: "buscar_documentos", args: { termino: "escuelas" } } })),
    sse(cand({ text: "Las escue" }), cand({ text: "las son…" })),
  ]);
  try {
    const ev = await leer(respuestaSSE(base(() => Promise.resolve([
      { chunk_id: 1, nombre_documento: "Vol I", pagina: 3, drive_url: "u", contenido: "c" },
    ]))));
    assertEquals(ev.map((e) => e.tipo), ["estado", "estado", "texto", "texto", "fin"]);
    assertEquals(ev[0].texto, "Buscando «escuelas»…");
    assertEquals(ev.filter((e) => e.tipo === "texto").map((e) => e.texto).join(""), "Las escuelas son…");
    assertEquals((ev[4].fuentes as unknown[]).length, 1);
    // la 2.ª llamada a Gemini lleva la functionResponse
    const c2 = (s.cuerpos[1] as { contents: Array<{ parts: Array<Record<string, unknown>> }> }).contents;
    assertEquals(c2.length, 3);
    assertEquals("functionResponse" in c2[2].parts[0], true);
  } finally { s.restaurar(); }
});

Deno.test("término no válido no llama a buscar; fallo de búsqueda no revela detalle", async () => {
  let llamadas = 0;
  const s = simular([
    sse(cand({ functionCall: { name: "b", args: { termino: "x".repeat(600) } } })),
    sse(cand({ functionCall: { name: "b", args: { termino: "ok" } } })),
    sse(cand({ text: "fin" })),
  ]);
  try {
    const ev = await leer(respuestaSSE(base(() => { llamadas++; return Promise.reject(new Error("secreto interno")); })));
    assertEquals(llamadas, 1);
    assertEquals(ev.at(-1)?.tipo, "fin");
    assertEquals(JSON.stringify(ev).includes("secreto"), false);
  } finally { s.restaurar(); }
});

Deno.test("error de Gemini → evento error genérico; tope de vueltas", async () => {
  let s = simular([new Response("boom con clave", { status: 500 })]);
  try {
    const ev = await leer(respuestaSSE(base(() => Promise.resolve([]))));
    assertEquals(ev.at(-1)?.tipo, "error");
    assertEquals(JSON.stringify(ev).includes("clave"), false);
  } finally { s.restaurar(); }
  const llamada = () => sse(cand({ functionCall: { name: "b", args: { termino: "t" } } }));
  s = simular([llamada(), llamada(), llamada()]);
  try {
    const ev = await leer(respuestaSSE(base(() => Promise.resolve([]))));
    assertEquals(ev.at(-1)?.tipo, "error");
    assertEquals(s.cuerpos.length, 3);
  } finally { s.restaurar(); }
});
