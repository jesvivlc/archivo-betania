import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { proteger, textoValido, LIMITES_PESADO } from "./guard.ts";

Deno.env.set("DB_URL", "http://rpc.test");
Deno.env.set("DB_SERVICE_KEY", "k");

// Simula check_rate_limit con un contador en memoria por clave.
const contadores = new Map<string, number>();
let rpcCaido = false;
const fetchReal = globalThis.fetch;
globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("http://rpc.test")) return fetchReal(input, init);
  if (rpcCaido) return Promise.resolve(new Response("{}", { status: 500 }));
  const b = JSON.parse(String(init?.body));
  const k = `${b.p_clave}:${b.p_ventana_seg}`; // igual que check_rate_limit en SQL
  const n = (contadores.get(k) ?? 0) + 1;
  contadores.set(k, n);
  return Promise.resolve(new Response(JSON.stringify(n <= b.p_limite), { headers: { "Content-Type": "application/json" } }));
}) as typeof fetch;

const peticion = (body = '{"tema":"x"}', origin = "https://archivo-betania.vercel.app", method = "POST") =>
  new Request("http://f.test", { method, body: method === "POST" ? body : undefined, headers: { origin, "x-forwarded-for": "1.2.3.4" } });
const op = { funcion: "t", limites: LIMITES_PESADO };
const opAmplio = { funcion: "t", limites: { porMinuto: 99, porHora: 99, porDia: 99 } };

Deno.test("pasa y devuelve el cuerpo; la 4.ª en un minuto da 429", async () => {
  contadores.clear();
  for (let i = 0; i < 3; i++) assertEquals((await proteger(peticion(), op)).ok, true);
  const r = await proteger(peticion(), op);
  assertEquals(r.ok, false);
  if (!r.ok) { assertEquals(r.res.status, 429); assertEquals(r.res.headers.get("Retry-After"), "60"); }
});

Deno.test("CORS: origen desconocido no se refleja", async () => {
  contadores.clear();
  const r = await proteger(peticion("{}", "https://evil.example", "OPTIONS" as "POST"), op);
  if (!r.ok) assertEquals(r.res.headers.get("Access-Control-Allow-Origin"), "https://archivo-betania.vercel.app");
});

Deno.test("método incorrecto → 405, JSON inválido → 400, cuerpo grande → 413", async () => {
  contadores.clear();
  const m = await proteger(new Request("http://f.test", { method: "GET" }), opAmplio);
  if (!m.ok) assertEquals(m.res.status, 405);
  const j = await proteger(peticion("no es json"), opAmplio);
  if (!j.ok) assertEquals(j.res.status, 400);
  const a = await proteger(peticion("[1]"), opAmplio);
  if (!a.ok) assertEquals(a.res.status, 400);
  const g = await proteger(peticion(JSON.stringify({ tema: "x".repeat(9000) })), opAmplio);
  if (!g.ok) assertEquals(g.res.status, 413);
});

Deno.test("fail-open si el contador falla", async () => {
  rpcCaido = true;
  assertEquals((await proteger(peticion(), op)).ok, true);
  rpcCaido = false;
});

Deno.test("textoValido", () => {
  assertEquals(textoValido("  hola "), "hola");
  assertEquals(textoValido(""), null);
  assertEquals(textoValido(5), null);
  assertEquals(textoValido("x".repeat(501)), null);
  assertEquals(textoValido({ toString: () => "x" }), null);
});

Deno.test("origen no permitido → 403 (OPTIONS y POST)", async () => {
  for (const m of ["OPTIONS", "POST"]) {
    const r = await proteger(new Request("http://f.test", { method: m, body: m === "POST" ? "{}" : undefined, headers: { origin: "https://evil.example" } }), op);
    if (!r.ok) assertEquals(r.res.status, 403); else throw new Error("debía rechazar");
  }
});

Deno.test("x-forwarded-for: rotar el primer valor no da contador nuevo", async () => {
  contadores.clear();
  const con = (primero: string) => new Request("http://f.test", {
    method: "POST", body: "{}", headers: { "x-forwarded-for": `${primero}, 9.9.9.9` },
  });
  const lim = { funcion: "t", limites: { porMinuto: 2, porHora: 99, porDia: 99 } };
  await proteger(con("1.1.1.1"), lim); await proteger(con("2.2.2.2"), lim);
  const r = await proteger(con("3.3.3.3"), lim);
  assertEquals(r.ok, false);
});

Deno.test("sin DB_URL → 503 (fail-closed)", async () => {
  Deno.env.set("DB_URL", "");
  const r = await proteger(peticion(), op);
  if (!r.ok) assertEquals(r.res.status, 503); else throw new Error("debía rechazar");
  Deno.env.set("DB_URL", "http://rpc.test");
});
