// Rekordník: synchronizační Worker pro Cloudflare + D1
//
// Společná evidence atletických výkonů žáků pro učitele TV na ZŠ Mendelova.
//
// Bezpečnost:
// - Každý učitel má osobní kód. Na serveru je jen jeho SHA-256 otisk v tabulce `ucitele`.
//   Správce (Karel) je v tabulce `ucitele` se spravce = 1 (id "spravce"); secret SPRAVCE_KOD je jen
//   nepovinná záloha. V aplikaci zakládá kódy ostatním.
//   Kód vzniká v aplikaci správce, server dostane otisk a kopii zašifrovanou heslem kolektivu.
// - Jména žáků i držitelů rekordů přicházejí zašifrovaná heslem kolektivu (AES-GCM),
//   server vidí jen bajty. Heslo nikdy neopustí telefon.
// - Seznam žáků, rekordy a nastavení šifrování smí měnit jen správce.
//   Výkon smí změnit nebo smazat jen ten, kdo ho zapsal, nebo správce.
//
// Protokol (stejný jako u Cvičky): POST /sync, jedno kolo = odeslat své změny, natáhnout cizí.
//   požadavek  { od: <kurzor>, zmeny: [ { store, rid, data: {...}|null, updatedAt } ] }
//   odpověď    { verze, vic, zmeny: [...], odmitnuto: [ "store|rid", ... ] }

const DAVKA = 500;
const MAX_PRIJEM = 2000;
const STORY = new Set(["zaci", "vykony", "rekordy", "sys"]);
const JEN_SPRAVCE = new Set(["zaci", "rekordy", "sys"]);

const HLAVICKY = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-max-age": "86400"
};

const odpoved = (telo, status = 200) =>
  new Response(JSON.stringify(telo), {
    status,
    headers: { ...HLAVICKY, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });

async function sha256(text) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function kdoJe(req, env) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return null;
  const kod = h.slice(7).trim().toLowerCase();
  if (!kod) return null;
  if (env.SPRAVCE_KOD && kod === String(env.SPRAVCE_KOD).trim().toLowerCase()) {
    return { id: "spravce", jmeno: env.SPRAVCE_JMENO || "Správce", spravce: true };
  }
  const r = await env.DB.prepare("SELECT id, jmeno, spravce FROM ucitele WHERE kod_hash = ?1 AND aktivni = 1")
    .bind(await sha256(kod)).first();
  return r ? { id: r.id, jmeno: r.jmeno, spravce: !!r.spravce } : null;
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HLAVICKY });

    const cesta = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
    try {
      const ja = await kdoJe(req, env);
      if (!ja) return odpoved({ chyba: "Neplatný nebo zrušený kód." }, 401);

      if (cesta === "/ja") return odpoved({ ok: true, ...ja });
      if (cesta === "/stav") return odpoved(await stav(env));
      if (cesta === "/sync" && req.method === "POST") return odpoved(await sync(env, ja, await req.json()));
      if (cesta === "/ucitele") {
        if (!ja.spravce) return odpoved({ chyba: "Jen pro správce." }, 403);
        if (req.method === "GET") return odpoved(await ucitele(env));
        if (req.method === "POST") return odpoved(await ucitelZmena(env, await req.json()));
      }
    } catch (e) {
      return odpoved({ chyba: String((e && e.message) || e) }, 500);
    }
    return odpoved({ chyba: "neznámý endpoint" }, 404);
  }
};

async function stav(env) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS radku, COALESCE(MAX(seq), 0) AS verze FROM zaznamy").first();
  return { ok: true, radku: r.radku, verze: r.verze };
}

async function ucitele(env) {
  const r = await env.DB.prepare("SELECT id, jmeno, spravce, aktivni, vytvoreno, kod_enc FROM ucitele WHERE id <> 'spravce' ORDER BY vytvoreno").all();
  return { ok: true, ucitele: (r.results || []).map((u) => ({ ...u, spravce: !!u.spravce, aktivni: !!u.aktivni })) };
}

// Kód vytváří aplikace správce. Server dostane jen otisk (na přihlášení) a kód zašifrovaný
// heslem kolektivu (aby se na něj správce mohl později podívat). Čitelný kód se neukládá.
function kodZTela(telo) {
  const h = String(telo.kod_hash || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) return null;
  const enc = telo.kod_enc == null ? null : String(telo.kod_enc).slice(0, 2000);
  return { h, enc };
}

async function ucitelZmena(env, telo) {
  const akce = telo && telo.akce;
  const id = String((telo && telo.id) || "");
  if (id === "spravce") return { chyba: "Účet správce se tady měnit nedá." };
  if (akce === "pridat") {
    const jmeno = String(telo.jmeno || "").trim().slice(0, 80);
    if (!jmeno) return { chyba: "Chybí jméno." };
    const k = kodZTela(telo);
    if (!k) return { chyba: "Chybí otisk kódu, obnov aplikaci na novou verzi." };
    const noveId = "u_" + (await sha256(k.h + Date.now())).slice(0, 12);
    await env.DB.prepare("INSERT INTO ucitele (id, jmeno, kod_hash, kod_enc, spravce, aktivni, vytvoreno) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)")
      .bind(noveId, jmeno, k.h, k.enc, telo.spravce ? 1 : 0, Date.now()).run();
    return { ok: true, id: noveId, jmeno };
  }
  if (akce === "novy-kod") {
    const k = kodZTela(telo);
    if (!k) return { chyba: "Chybí otisk kódu, obnov aplikaci na novou verzi." };
    await env.DB.prepare("UPDATE ucitele SET kod_hash = ?1, kod_enc = ?2, aktivni = 1 WHERE id = ?3").bind(k.h, k.enc, id).run();
    return { ok: true };
  }
  if (akce === "zrusit" || akce === "obnovit") {
    await env.DB.prepare("UPDATE ucitele SET aktivni = ?1 WHERE id = ?2").bind(akce === "obnovit" ? 1 : 0, id).run();
    return { ok: true };
  }
  if (akce === "smazat") {
    await env.DB.prepare("DELETE FROM ucitele WHERE id = ?1").bind(id).run();
    return { ok: true };
  }
  return { chyba: "neznámá akce" };
}

async function stavajici(env, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const kus = ids.slice(i, i + 90);
    const r = await env.DB.prepare(`SELECT id, data FROM zaznamy WHERE id IN (${kus.map((_, j) => "?" + (j + 1)).join(",")})`)
      .bind(...kus).all();
    for (const x of r.results || []) out.set(x.id, x.data ? JSON.parse(x.data) : null);
  }
  return out;
}

async function sync(env, ja, telo) {
  const od = Number(telo && telo.od) || 0;
  const zmeny = Array.isArray(telo && telo.zmeny) ? telo.zmeny : [];
  if (zmeny.length > MAX_PRIJEM) return { chyba: "příliš velká dávka, maximum je " + MAX_PRIJEM };
  const odmitnuto = [];

  const platne = [];
  for (const z of zmeny) {
    if (!z || typeof z.store !== "string" || typeof z.rid !== "string" || !STORY.has(z.store)) continue;
    const id = z.store + "|" + z.rid;
    if (JEN_SPRAVCE.has(z.store) && !ja.spravce) { odmitnuto.push(id); continue; }
    platne.push({ ...z, id });
  }

  // Výkony smí měnit jen autor nebo správce. Autor se razítkuje na serveru.
  const vykonIds = platne.filter((z) => z.store === "vykony").map((z) => z.id);
  const puvodni = vykonIds.length ? await stavajici(env, vykonIds) : new Map();

  if (platne.length) {
    const citac = await env.DB.prepare("SELECT v FROM citac WHERE k = 'seq'").first();
    let seq = Number(citac && citac.v) || 0;

    const vlozitJednou = env.DB.prepare(
      `INSERT INTO zaznamy (id, store, rid, data, smazano, updatedAt, seq)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id) DO NOTHING`
    );
    const vlozit = env.DB.prepare(
      `INSERT INTO zaznamy (id, store, rid, data, smazano, updatedAt, seq)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, smazano = excluded.smazano,
         updatedAt = excluded.updatedAt, seq = excluded.seq
       WHERE excluded.updatedAt >= zaznamy.updatedAt`
    );

    const prikazy = [];
    for (const z of platne) {
      let data = z.data;
      if (z.store === "vykony") {
        const stary = puvodni.get(z.id);
        if (stary && stary.autorId && stary.autorId !== ja.id && !ja.spravce) { odmitnuto.push(z.id); continue; }
        if (data) {
          const autorId = stary && stary.autorId ? stary.autorId : ja.id;
          const autor = stary && stary.autor ? stary.autor : ja.jmeno;
          data = { ...data, autorId, autor };
        }
      }
      seq += 1;
      const prikaz = z.store === "sys" ? vlozitJednou : vlozit;
      prikazy.push(prikaz.bind(z.id, z.store, z.rid, data == null ? null : JSON.stringify(data),
        data == null ? 1 : 0, Number(z.updatedAt) || 0, seq));
    }
    if (prikazy.length) {
      prikazy.push(env.DB.prepare("UPDATE citac SET v = ?1 WHERE k = 'seq'").bind(seq));
      await env.DB.batch(prikazy);
    }
  }

  const vysledek = await env.DB
    .prepare("SELECT store, rid, data, smazano, updatedAt, seq FROM zaznamy WHERE seq > ?1 ORDER BY seq LIMIT ?2")
    .bind(od, DAVKA).all();
  const radky = vysledek.results || [];
  const posledni = radky.length
    ? radky[radky.length - 1].seq
    : (await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS v FROM zaznamy").first()).v;

  return {
    verze: Math.max(od, Number(posledni) || 0),
    vic: radky.length === DAVKA,
    odmitnuto,
    zmeny: radky.map((r) => ({ store: r.store, rid: r.rid, data: r.smazano ? null : JSON.parse(r.data), updatedAt: r.updatedAt }))
  };
}
