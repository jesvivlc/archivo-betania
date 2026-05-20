import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

interface Persona {
  id:      string;
  nombre:  string;
  rol:     string | null;
  periodo: string | null;
}

interface Relacion {
  persona_a: string;
  persona_b: string;
  tipo:      string | null;
}

serve(async (req: Request) => {
  const DB_SERVICE_KEY = Deno.env.get("DB_SERVICE_KEY") ?? "";
  const DB_URL         = Deno.env.get("DB_URL") ?? "";

  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const supa = createClient(DB_URL, DB_SERVICE_KEY);

    // Fetch all personas and relations in parallel
    const [pRes, rRes] = await Promise.all([
      supa.from("personas").select("id, nombre, rol, periodo"),
      supa.from("relaciones").select("persona_a, persona_b, tipo"),
    ]);

    if (pRes.error) throw new Error(pRes.error.message);
    if (rRes.error) throw new Error(rRes.error.message);

    const personas  = (pRes.data ?? []) as Persona[];
    const relaciones = (rRes.data ?? []) as Relacion[];

    if (personas.length === 0) {
      return new Response(
        JSON.stringify({
          nodos: [], enlaces: [],
          mensaje: "La red aún no ha sido extraída. Ejecuta extraer_personas.py primero.",
        }),
        { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // Compute degree for each persona
    const grado = new Map<string, number>();
    for (const r of relaciones) {
      grado.set(r.persona_a, (grado.get(r.persona_a) ?? 0) + 1);
      grado.set(r.persona_b, (grado.get(r.persona_b) ?? 0) + 1);
    }

    // Sort personas by degree desc, keep top 60
    const sorted = personas
      .map(p => ({ ...p, grado: grado.get(p.id) ?? 0 }))
      .sort((a, b) => b.grado - a.grado)
      .slice(0, 60);

    const topIds = new Set(sorted.map(p => p.id));

    const nodos = sorted.map(p => ({
      id:      p.id,
      nombre:  p.nombre,
      rol:     p.rol ?? "desconocido",
      periodo: p.periodo ?? "",
      grado:   p.grado,
    }));

    const enlaces = relaciones
      .filter(r => topIds.has(r.persona_a) && topIds.has(r.persona_b))
      .map(r => ({ source: r.persona_a, target: r.persona_b, tipo: r.tipo ?? "" }));

    return new Response(
      JSON.stringify({ nodos, enlaces }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
