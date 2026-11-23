import { createClient } from "npm:@supabase/supabase-js@2";

// Lien ADE (emploi du temps ME4 / G4.3)
const ADE_URL = Deno.env.get("ADE_URL") ??
  "https://agenda-web-consult.univ-amu.fr/jsp/custom/modules/plannings/anonymous_cal.jsp?projectId=8&resources=17005&calType=ical&firstDate=2026-08-17&lastDate=2027-08-15";
// Rien n'est importé avant cette date
const CUTOFF = "2026-11-23T00:00:00Z";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function unesc(s: string) {
  return s.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}
function toIso(v: string): string | null {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}Z`;
}
function teachersFrom(desc: string) {
  return desc.split("\n").map((l) => l.trim()).filter((l) =>
    l && !/^\d+$/.test(l) && !/^\(Modifi/.test(l) && !/^[A-Z]{1,5}_?\d[A-Z0-9._]*$/.test(l)
  ).join(", ");
}

function parse(ics: string) {
  const text = ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const out: any[] = [];
  for (const block of text.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0];
    const f: Record<string, string> = {};
    for (const line of body.split("\n")) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const key = line.slice(0, i).split(";")[0].toUpperCase();
      if (!(key in f)) f[key] = line.slice(i + 1);
    }
    const start = toIso((f.DTSTART ?? "").trim());
    const end = toIso((f.DTEND ?? "").trim());
    if (!f.UID || !start || !end) continue;
    out.push({
      uid: f.UID.trim(),
      title: unesc(f.SUMMARY ?? "").trim().replace(/\s+/g, " ") || "Sans titre",
      location: unesc(f.LOCATION ?? "").trim() || null,
      teachers: teachersFrom(unesc(f.DESCRIPTION ?? "")) || null,
      start_at: start,
      end_at: end > start ? end : new Date(Date.parse(start) + 3600e3).toISOString(),
    });
  }
  return out;
}

async function fetchAde(): Promise<string> {
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(ADE_URL, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; planning-me4/1.0)",
          "Accept": "text/calendar, text/plain, */*",
        },
        signal: AbortSignal.timeout(40000),
      });
      const body = await res.text();
      if (res.ok && body.includes("BEGIN:VCALENDAR")) return body;
      last = `ADE a répondu ${res.status}`;
    } catch (e) {
      last = `ADE injoignable (${e instanceof Error ? e.message : e})`;
    }
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  throw new Error(last);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

  // Anti-spam : pas plus d'une synchro réussie par minute
  const { data: st } = await sb.from("sync_state").select("last_sync").eq("id", 1).single();
  if (st?.last_sync && Date.now() - Date.parse(st.last_sync) < 60e3) {
    return json({ ok: true, skipped: true, last_sync: st.last_sync });
  }

  try {
    const all = parse(await fetchAde());
    if (all.length === 0) throw new Error("Aucun événement dans le flux ADE");

    const { data: kw } = await sb.from("excluded_keywords").select("keyword");
    const excl = (kw ?? []).map((k: any) => k.keyword.toLowerCase());
    const kept = all.filter((e) =>
      e.start_at >= CUTOFF && !excl.some((k: string) => e.title.toLowerCase().includes(k))
    );

    if (kept.length) {
      const { error } = await sb.from("events").upsert(
        kept.map((e) => ({ ...e, source: "ade" })),
        { onConflict: "uid" },
      );
      if (error) throw error;
    }

    // Supprime les cours ADE à venir qui ont disparu du flux (ou qui sont filtrés)
    const keptUids = new Set(kept.map((e) => e.uid));
    const { data: existing } = await sb.from("events").select("id, uid")
      .eq("source", "ade").gte("start_at", new Date().toISOString());
    const stale = (existing ?? []).filter((r: any) => !keptUids.has(r.uid)).map((r: any) => r.id);
    if (stale.length) await sb.from("events").delete().in("id", stale);

    const now = new Date().toISOString();
    await sb.from("sync_state").update({ last_sync: now, last_count: kept.length, last_error: null }).eq("id", 1);
    return json({ ok: true, total: all.length, kept: kept.length, removed: stale.length, last_sync: now });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from("sync_state").update({ last_error: msg }).eq("id", 1);
    return json({ ok: false, error: msg }, 502);
  }
});
