import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const GEMINI_EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";
const GEMINI_CHAT_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const RESEND_API_URL = "https://api.resend.com/emails";

// Temas rotativos — se seleccionan 3 por número de semana
const TEMAS: string[] = [
  "educación popular gratuita para niños pobres",
  "fundaciones de escuelas pías en Europa",
  "espiritualidad y vida interior de Calasanz",
  "persecución e Inquisición contra las Escuelas Pías",
  "métodos pedagógicos y didáctica escolapia",
  "relaciones de Calasanz con papas y la curia romana",
  "vida comunitaria y gobierno de la Orden",
  "cartas y correspondencia de Calasanz con superiores",
];

interface Fragmento {
  tema:             string;
  nombre_documento: string;
  drive_url:        string;
  contenido:        string;
  pagina:           number;
}

// ─── Gemini helpers ──────────────────────────────────────────────────────────

async function generarEmbedding(texto: string, apiKey: string): Promise<number[]> {
  const resp = await fetch(GEMINI_EMBED_URL, {
    method:  "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body:    JSON.stringify({ model: "models/gemini-embedding-001", content: { parts: [{ text: texto }] } }),
  });
  if (!resp.ok) throw new Error(`Gemini embed error ${resp.status}`);
  const data = await resp.json();
  return (data.embedding.values as number[]).slice(0, 768);
}

async function generarSintesis(fragmentos: Fragmento[], apiKey: string): Promise<string> {
  const ctx = fragmentos.map(f =>
    `[${f.nombre_documento}, pág. ${f.pagina}]\n${f.contenido.slice(0, 400)}`
  ).join("\n\n---\n\n");

  const prompt = `Eres el archivero digital de la Provincia de Betania de las Escuelas Pías.
Escribe un párrafo breve (4-5 frases) que conecte los tres fragmentos del archivo que aparecen a continuación,
destacando qué nos dicen juntos sobre San José de Calasanz y su obra.
Tono: cercano, culto, evocador. No uses listas ni títulos. Solo prosa fluida.

FRAGMENTOS:
${ctx}`;

  const resp = await fetch(GEMINI_CHAT_URL, {
    method:  "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body:    JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
  });
  if (!resp.ok) return "";
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

// ─── Email builder ───────────────────────────────────────────────────────────

function escaparHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function construirEmail(nombre: string, fragmentos: Fragmento[], sintesis: string, unsubUrl: string): string {
  const fragmentosHtml = fragmentos.map(f => `
    <tr><td style="padding:0 0 20px">
      <div style="border-left:3px solid #7B5E2A;padding:12px 16px;background:#fefce8;border-radius:0 6px 6px 0">
        <p style="margin:0 0 6px;font-size:11px;color:#9C7A3A;font-weight:bold;text-transform:uppercase;letter-spacing:1px">
          ${escaparHtml(f.nombre_documento)} · Pág. ${f.pagina}
        </p>
        <p style="margin:0 0 6px;font-size:11px;color:#6b7280;font-style:italic">Tema: ${escaparHtml(f.tema)}</p>
        <p style="margin:0;font-size:14px;color:#374151;line-height:1.75;font-style:italic">
          "${escaparHtml(f.contenido.slice(0, 320))}${f.contenido.length > 320 ? "…" : ""}"
        </p>
        <p style="margin:8px 0 0">
          <a href="${escaparHtml(f.drive_url)}" style="font-size:12px;color:#2563eb">Ver documento completo →</a>
        </p>
      </div>
    </td></tr>`).join("");

  const sintesissHtml = sintesis ? `
    <tr><td style="padding:0 0 28px">
      <div style="background:#eff6ff;border-radius:8px;padding:20px 24px">
        <p style="margin:0 0 8px;font-size:11px;font-weight:bold;color:#2563eb;text-transform:uppercase;letter-spacing:1px">Del archivero</p>
        <p style="margin:0;font-size:14px;color:#1e3a5f;line-height:1.8">${escaparHtml(sintesis)}</p>
      </div>
    </td></tr>` : "";

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Archivo Betania · Fragmentos de la semana</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Georgia,Times,'Times New Roman',serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

        <!-- Cabecera -->
        <tr><td style="background:#1e3a5f;padding:28px 32px;text-align:center;border-radius:8px 8px 0 0">
          <p style="margin:0 0 4px;font-size:10px;color:rgba(255,255,255,.55);letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif">Provincia de Betania · Escuelas Pías</p>
          <h1 style="margin:0;font-size:22px;color:#fff;font-weight:normal;letter-spacing:.5px">Archivo Digital</h1>
          <p style="margin:8px 0 0;font-size:13px;color:rgba(255,255,255,.7);font-family:Arial,sans-serif">Fragmentos destacados de la semana</p>
        </td></tr>

        <!-- Cuerpo -->
        <tr><td style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none">
          <table width="100%" cellpadding="0" cellspacing="0">

            <tr><td style="padding:0 0 24px">
              <p style="margin:0;font-size:15px;color:#374151;line-height:1.6">
                Estimado/a <strong>${escaparHtml(nombre)}</strong>,<br><br>
                El archivo de la Provincia de Betania te acerca esta semana tres fragmentos del corpus de San José de Calasanz.
              </p>
            </td></tr>

            ${fragmentosHtml}
            ${sintesissHtml}

            <tr><td style="text-align:center;padding:8px 0 0">
              <a href="https://archivo-betania.vercel.app"
                 style="display:inline-block;background:#1e3a5f;color:#fff;text-decoration:none;padding:13px 30px;border-radius:6px;font-size:14px;font-family:Arial,sans-serif;letter-spacing:.3px">
                Explorar el archivo completo
              </a>
            </td></tr>

          </table>
        </td></tr>

        <!-- Pie -->
        <tr><td style="padding:18px 32px;text-align:center;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;background:#f9fafb">
          <p style="margin:0;font-size:11px;color:#9ca3af;font-family:Arial,sans-serif;line-height:1.7">
            Recibes este correo porque te suscribiste al Archivo Digital de la Provincia de Betania.<br>
            <a href="${escaparHtml(unsubUrl)}" style="color:#9ca3af">Cancelar suscripción</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Handler: dar de baja (GET ?unsub=base64email) ───────────────────────────

async function handleUnsubscribe(req: Request, supa: ReturnType<typeof createClient>): Promise<Response> {
  const url     = new URL(req.url);
  const encoded = url.searchParams.get("unsub") ?? "";
  if (!encoded) return new Response("Parámetro inválido.", { status: 400 });

  let email: string;
  try {
    email = atob(encoded);
  } catch {
    return new Response("Enlace inválido.", { status: 400 });
  }

  await supa.from("suscriptores").update({ activo: false }).eq("email", email);

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<title>Baja confirmada · Archivo Betania</title>
<style>body{font-family:Georgia,serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f3f4f6}
.box{text-align:center;padding:48px 40px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;max-width:420px}
h1{font-size:1.4rem;color:#1e3a5f;margin:0 0 12px}p{color:#6b7280;line-height:1.7;margin:0 0 24px}
a{color:#2563eb;font-size:.9rem}</style></head>
<body><div class="box">
<h1>Suscripción cancelada</h1>
<p>Tu dirección <strong>${escaparHtml(email)}</strong> ha sido eliminada de la lista de envío del Archivo Digital.</p>
<a href="https://archivo-betania.vercel.app">Volver al archivo →</a>
</div></body></html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ─── Handler: envío semanal (POST) ───────────────────────────────────────────

async function handleSend(
  req:         Request,
  supa:        ReturnType<typeof createClient>,
  geminiKey:   string,
  resendKey:   string,
  fromEmail:   string,
  cronSecret:  string,
  fnBaseUrl:   string,
): Promise<Response> {
  // Verificar secreto del cron
  const provided = req.headers.get("x-cron-secret") ?? "";
  if (cronSecret && provided !== cronSecret) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  // 1. Suscriptores activos
  const { data: suscriptores, error: sErr } = await supa
    .from("suscriptores").select("email, nombre").eq("activo", true);
  if (sErr) throw new Error(sErr.message);
  if (!suscriptores || suscriptores.length === 0) {
    return new Response(
      JSON.stringify({ mensaje: "Sin suscriptores activos." }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  // 2. Elegir 3 temas rotativos según número de semana
  const weekSeed = Math.floor(Date.now() / (7 * 24 * 3600 * 1000));
  const temasElegidos = [0, 1, 2].map(i => TEMAS[(weekSeed + i) % TEMAS.length]);

  // 3. Buscar fragmento representativo para cada tema
  const fragmentos: Fragmento[] = [];
  for (const tema of temasElegidos) {
    try {
      const emb = await generarEmbedding(tema, geminiKey);
      const { data } = await supa.rpc("buscar_chunks", {
        query_embedding:      emb,
        match_count:          1,
        similarity_threshold: 0.25,
      });
      if (data?.[0]) {
        fragmentos.push({
          tema,
          nombre_documento: data[0].nombre_documento,
          drive_url:        data[0].drive_url,
          contenido:        data[0].contenido,
          pagina:           data[0].pagina,
        });
      }
    } catch { /* ignora errores por tema individual */ }
  }

  if (fragmentos.length === 0) {
    return new Response(
      JSON.stringify({ error: "No se encontraron fragmentos en el archivo." }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  // 4. Síntesis con Gemini
  const sintesis = await generarSintesis(fragmentos, geminiKey).catch(() => "");

  // 5. Enviar a cada suscriptor
  const resultados: { email: string; ok: boolean; status: number }[] = [];
  for (const s of suscriptores) {
    const nombre    = s.nombre || "amigo/a del archivo";
    const unsubUrl  = `${fnBaseUrl}?unsub=${btoa(s.email)}`;
    const htmlEmail = construirEmail(nombre, fragmentos, sintesis, unsubUrl);

    const res = await fetch(RESEND_API_URL, {
      method:  "POST",
      headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body:    JSON.stringify({
        from:    fromEmail,
        to:      [s.email],
        subject: `Archivo Betania · Fragmentos de la semana`,
        html:    htmlEmail,
      }),
    });
    resultados.push({ email: s.email, ok: res.ok, status: res.status });
  }

  const enviados = resultados.filter(r => r.ok).length;
  const errores  = resultados.filter(r => !r.ok).length;

  return new Response(
    JSON.stringify({ enviados, errores, detalle: resultados }),
    { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
}

// ─── Serve ───────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
  const DB_SERVICE_KEY = Deno.env.get("DB_SERVICE_KEY") ?? "";
  const DB_URL         = Deno.env.get("DB_URL") ?? "";
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
  const FROM_EMAIL     = Deno.env.get("FROM_EMAIL") ?? "Archivo Betania <onboarding@resend.dev>";
  const CRON_SECRET    = Deno.env.get("CRON_SECRET") ?? "";

  // URL base de esta función (para el enlace de baja)
  const FN_BASE_URL = `${DB_URL.replace("https://", "https://").split(".supabase.co")[0]}.supabase.co/functions/v1/enviar-resumen`;

  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const supa = createClient(DB_URL, DB_SERVICE_KEY);

  try {
    if (req.method === "GET")  return await handleUnsubscribe(req, supa);
    if (req.method === "POST") return await handleSend(req, supa, GEMINI_API_KEY, RESEND_API_KEY, FROM_EMAIL, CRON_SECRET, FN_BASE_URL);

    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err), stack: (err as Error)?.stack }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
