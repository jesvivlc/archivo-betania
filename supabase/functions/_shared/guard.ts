// Protección común de las Edge Functions: CORS restringido, método, tamaño de
// cuerpo, rate limiting por IP (ventanas de minuto y hora) y tope global diario.
// Los contadores viven en Postgres (check_rate_limit, ver schema.sql) porque los
// isolates de Deno no comparten memoria.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ORIGENES_PERMITIDOS = [
  "https://archivo-betania.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
];

const MAX_BODY_BYTES = 8 * 1024;
export const MAX_TEXTO = 500;

export interface Limites {
  porMinuto: number; // por IP
  porHora:   number; // por IP
  porDia:    number; // global, todas las IPs: tope de gasto de la API de Gemini
}

// Funciones que llaman a Gemini en bucle o varias veces por petición: las más caras.
export const LIMITES_PESADO: Limites = { porMinuto: 3,  porHora: 20,  porDia: 1000 };
export const LIMITES_AGENTE: Limites = { porMinuto: 6,  porHora: 60,  porDia: 3000 };
export const LIMITES_LIGERO: Limites = { porMinuto: 30, porHora: 300, porDia: 20000 };

export function corsHeaders(req: Request, metodos = "POST, OPTIONS"): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin":  ORIGENES_PERMITIDOS.includes(origin) ? origin : ORIGENES_PERMITIDOS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": metodos,
    "Vary": "Origin",
  };
}

export function json(body: unknown, status: number, cors: Record<string, string>, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", ...extra },
  });
}

// Detalle solo en los logs de la función; el cliente recibe un mensaje genérico.
export function errorInterno(err: unknown, cors: Record<string, string>): Response {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  return json({ error: "Error interno. Inténtalo de nuevo en unos minutos." }, 500, cors);
}

async function hashIp(ip: string): Promise<string> {
  const sal = Deno.env.get("RATE_LIMIT_SALT") ?? "archivo-betania";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${sal}:${ip}`));
  return Array.from(new Uint8Array(buf)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ipCliente(req: Request): string {
  return req.headers.get("cf-connecting-ip")
    ?? req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() // el último lo añade el proxy; el primero lo controla el cliente
    ?? "desconocida";
}

type Resultado = { ok: true; body: Record<string, unknown> } | { ok: false; res: Response };

interface Opciones {
  funcion: string;
  limites: Limites;
  metodo?: "POST" | "GET";
}

export async function proteger(req: Request, op: Opciones): Promise<Resultado> {
  const metodo = op.metodo ?? "POST";
  const cors = corsHeaders(req, `${metodo}, OPTIONS`);

  const origin = req.headers.get("origin");
  if (origin && !ORIGENES_PERMITIDOS.includes(origin)) {
    return { ok: false, res: json({ error: "Origen no permitido." }, 403, cors) };
  }
  if (req.method === "OPTIONS") return { ok: false, res: new Response(null, { headers: cors }) };
  if (req.method !== metodo) return { ok: false, res: json({ error: "Método no permitido." }, 405, cors) };

  const DB_URL         = Deno.env.get("DB_URL") ?? "";
  const DB_SERVICE_KEY = Deno.env.get("DB_SERVICE_KEY") ?? "";
  if (!DB_URL || !DB_SERVICE_KEY) {
    console.error("Faltan DB_URL o DB_SERVICE_KEY: sin contador no se atiende (fail-closed).");
    return { ok: false, res: json({ error: "Servicio no disponible." }, 503, cors) };
  }
  const supa = createClient(DB_URL, DB_SERVICE_KEY);
  const ip = await hashIp(ipCliente(req));

  const comprobaciones: Array<[string, number, number, string]> = [
    [`${op.funcion}:ip:${ip}`,  op.limites.porMinuto, 60,    "Demasiadas consultas seguidas. Espera un minuto."],
    [`${op.funcion}:ip:${ip}`,  op.limites.porHora,   3600,  "Has alcanzado el límite horario de consultas. Vuelve más tarde."],
    [`${op.funcion}:global`,    op.limites.porDia,    86400, "El servicio ha alcanzado su límite diario de consultas. Vuelve mañana."],
  ];

  for (const [clave, limite, ventana, mensaje] of comprobaciones) {
    const { data, error } = await supa.rpc("check_rate_limit", {
      p_clave: clave, p_limite: limite, p_ventana_seg: ventana,
    });
    if (error) {
      // Fail-open: una caída del contador no debe tumbar el archivo.
      console.error(`check_rate_limit: ${error.message}`);
      break;
    }
    if (data === false) {
      return { ok: false, res: json({ error: mensaje }, 429, cors, { "Retry-After": String(Math.min(ventana, 3600)) }) };
    }
  }

  if (metodo === "GET") return { ok: true, body: {} };

  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return { ok: false, res: json({ error: "Petición demasiado grande." }, 413, cors) };
  }
  const texto = await req.text();
  if (new TextEncoder().encode(texto).length > MAX_BODY_BYTES) {
    return { ok: false, res: json({ error: "Petición demasiado grande." }, 413, cors) };
  }
  try {
    const body = JSON.parse(texto);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
    return { ok: true, body };
  } catch {
    return { ok: false, res: json({ error: "El cuerpo debe ser un JSON válido." }, 400, cors) };
  }
}

// Devuelve el texto recortado, o null si no es una cadena válida / supera MAX_TEXTO.
export function textoValido(v: unknown, max = MAX_TEXTO): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : null;
}
