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
//
// Upozornění (Web Push): /push/klic, /push/prihlasit, /push/odhlasit, /push/test.
// Správce dostane upozornění na nový rekord ke schválení, autor výkonu na schválený rekord.
// V upozornění nejsou jména dětí (server je nezná), jen ročník, disciplína a výkon.

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
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HLAVICKY });

    const cesta = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
    try {
      const ja = await kdoJe(req, env);
      if (!ja) return odpoved({ chyba: "Neplatný nebo zrušený kód." }, 401);

      if (cesta === "/ja") return odpoved({ ok: true, ...ja });
      if (cesta === "/stav") return odpoved(await stav(env));
      if (cesta === "/sync" && req.method === "POST") return odpoved(await sync(env, ja, await req.json(), ctx));
      if (cesta === "/push/klic") return odpoved({ ok: true, klic: (await vapidKlice(env)).verejny });
      if (cesta === "/push/prihlasit" && req.method === "POST") return odpoved(await pushPrihlasit(env, ja, await req.json()));
      if (cesta === "/push/odhlasit" && req.method === "POST") return odpoved(await pushOdhlasit(env, ja, await req.json()));
      if (cesta === "/push/test" && req.method === "POST") return odpoved(await pushTest(env, ja, await req.json()));
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

async function sync(env, ja, telo, ctx) {
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
      const ukol = upozorneniPoSyncu(env, ja, platne.filter((z) => !odmitnuto.includes(z.id)), puvodni).catch((e) => console.log("upozorneni", e && e.message));
      if (ctx && ctx.waitUntil) ctx.waitUntil(ukol); else await ukol;
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

/* ---------- Upozornění (Web Push) ---------- */

const NAZVY = { d60: "60 m", d200: "200 m", d400: "400 m", d500: "500 m", d1000: "1000 m", zm: "skok z místa", dal: "skok daleký",
  vys: "skok vysoký", rak: "hod raketkou", kou: "vrh koulí", spl: "šplh", sta: "štafeta 4×60 m" };
const NIZSI_LEPSI = new Set(["d60", "d200", "d400", "d500", "d1000", "spl", "sta"]);
const JEDNOTKA = { d60: "s", d200: "s", d400: "min", d500: "min", d1000: "min", zm: "cm", dal: "cm", vys: "cm", rak: "m", kou: "m", spl: "s", sta: "s" };
const APPKA = "https://g4m3ch4n63r.github.io/rekordnik/";

function vykonText(d, v) {
  const u = JEDNOTKA[d];
  const c = (x, n) => x.toFixed(n).replace(".", ",");
  if (u === "min") { const m = Math.floor(v / 60); const s = v - m * 60; return m + ":" + (s < 10 ? "0" : "") + c(s, Number.isInteger(s * 10) ? 1 : 2) + " min"; }
  if (u === "s") return c(v, 2) + " s";
  if (u === "cm") return Math.round(v) + " cm";
  return c(v, 2) + " m";
}
function kategorie(g, d, sex) {
  const kdo = sex === "X" ? (d === "sta" ? "smíšená" : "") : sex === "M" ? "kluci" : "holky";
  return `${g}. ročník, ${NAZVY[d] || d}${kdo ? ", " + kdo : ""}`;
}
function platnaDisciplina(g, d) {
  if (!NAZVY[d]) return false;
  if (d === "d500") return g <= 4;
  if (d === "d1000") return g >= 5;
  return true;
}

let tabulkyHotove = false;
async function pushTabulky(env) {
  if (tabulkyHotove) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS push (endpoint TEXT PRIMARY KEY, ucitel TEXT NOT NULL, spravce INTEGER NOT NULL DEFAULT 0, p256dh TEXT NOT NULL, auth TEXT NOT NULL, vytvoreno INTEGER NOT NULL DEFAULT 0)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS nastaveni (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
  ]);
  tabulkyHotove = true;
}

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); };
const spoj = (...casti) => { const n = casti.reduce((a, c) => a + c.length, 0); const o = new Uint8Array(n); let i = 0; for (const c of casti) { o.set(c, i); i += c.length; } return o; };
const TE = new TextEncoder();

// VAPID klíče vzniknou samy při prvním použití a leží v D1 (secret by Workers Builds při nasazení smazal).
let vapidCache = null;
async function vapidKlice(env) {
  if (vapidCache) return vapidCache;
  await pushTabulky(env);
  let r = await env.DB.prepare("SELECT v FROM nastaveni WHERE k = 'vapid'").first();
  if (!r) {
    const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", par.privateKey);
    const verejny = b64u(await crypto.subtle.exportKey("raw", par.publicKey));
    await env.DB.prepare("INSERT OR IGNORE INTO nastaveni (k, v) VALUES ('vapid', ?1)").bind(JSON.stringify({ jwk, verejny })).run();
    r = await env.DB.prepare("SELECT v FROM nastaveni WHERE k = 'vapid'").first();
  }
  const { jwk, verejny } = JSON.parse(r.v);
  const soukromy = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  vapidCache = { verejny, soukromy };
  return vapidCache;
}

async function vapidHlavicka(env, endpoint) {
  const k = await vapidKlice(env);
  const aud = new URL(endpoint).origin;
  const h = b64u(TE.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const c = b64u(TE.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: APPKA })));
  const podpis = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.soukromy, TE.encode(h + "." + c));
  return `vapid t=${h}.${c}.${b64u(podpis)}, k=${k.verejny}`;
}

async function hkdf(salt, ikm, info, delka) {
  const klic = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, klic, delka * 8));
}

// Šifrování obsahu podle RFC 8291 (aes128gcm).
export async function zasifrujPush(p256dh, auth, text) {
  const uaVerejny = unb64u(p256dh), tajemstvi = unb64u(auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asVerejny = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKlic = await crypto.subtle.importKey("raw", uaVerejny, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sdilene = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKlic }, as.privateKey, 256));
  const ikm = await hkdf(tajemstvi, sdilene, spoj(TE.encode("WebPush: info\0"), uaVerejny, asVerejny), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, TE.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, TE.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sifra = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, spoj(TE.encode(text), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return spoj(salt, rs, new Uint8Array([asVerejny.length]), asVerejny, sifra);
}

async function poslatJednomu(env, sub, zprava) {
  const telo = await zasifrujPush(sub.p256dh, sub.auth, JSON.stringify(zprava));
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: { authorization: await vapidHlavicka(env, sub.endpoint), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "172800", urgency: "normal" },
    body: telo
  });
  if (r.status === 404 || r.status === 410) await env.DB.prepare("DELETE FROM push WHERE endpoint = ?1").bind(sub.endpoint).run();
  return r.status;
}

async function poslat(env, kdo, zprava) {
  await pushTabulky(env);
  const sql = kdo.spravce ? "SELECT * FROM push WHERE spravce = 1" : "SELECT * FROM push WHERE ucitel = ?1";
  const st = kdo.spravce ? env.DB.prepare(sql) : env.DB.prepare(sql).bind(kdo.ucitel);
  const subs = ((await st.all()).results || []).filter((x) => !kdo.krome || x.ucitel !== kdo.krome);
  return Promise.all(subs.map((x) => poslatJednomu(env, x, zprava).catch(() => 0)));
}

async function pushPrihlasit(env, ja, telo) {
  await pushTabulky(env);
  const sub = telo && telo.sub;
  if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return { chyba: "Neplatné přihlášení k upozorněním." };
  await env.DB.prepare(`INSERT INTO push (endpoint, ucitel, spravce, p256dh, auth, vytvoreno) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT(endpoint) DO UPDATE SET ucitel = excluded.ucitel, spravce = excluded.spravce, p256dh = excluded.p256dh, auth = excluded.auth`)
    .bind(sub.endpoint.slice(0, 1000), ja.id, ja.spravce ? 1 : 0, String(sub.keys.p256dh).slice(0, 200), String(sub.keys.auth).slice(0, 100), Date.now()).run();
  return { ok: true };
}
async function pushOdhlasit(env, ja, telo) {
  await pushTabulky(env);
  await env.DB.prepare("DELETE FROM push WHERE endpoint = ?1 AND ucitel = ?2").bind(String((telo && telo.endpoint) || ""), ja.id).run();
  return { ok: true };
}
async function pushTest(env, ja, telo) {
  await pushTabulky(env);
  const sub = await env.DB.prepare("SELECT * FROM push WHERE endpoint = ?1 AND ucitel = ?2").bind(String((telo && telo.endpoint) || ""), ja.id).first();
  if (!sub) return { chyba: "Tohle zařízení není přihlášené k upozorněním." };
  const stav = await poslatJednomu(env, sub, { title: "Rekordník", body: "Upozornění fungují 👍", tag: "test", url: APPKA });
  return stav >= 200 && stav < 300 ? { ok: true } : { chyba: "Služba upozornění odpověděla " + stav };
}

async function upozorneniPoSyncu(env, ja, zmeny, puvodni) {
  const nove = zmeny.filter((z) => z.store === "vykony" && z.data && !puvodni.get(z.id) && !z.data.zdroj && !z.data.schvaleno && !z.data.zamitnuto);
  const schvalene = zmeny.filter((z) => z.store === "rekordy" && z.data && z.data.zdroj === "appka" && z.data.vykon);
  if (!nove.length && !schvalene.length) return;
  // Nové výkony lepší než rekord: upozornit správce (kromě toho, kdo je zapsal).
  const nejlepsi = new Map();
  for (const z of nove) {
    const v = z.data; if (typeof v.v !== "number" || !platnaDisciplina(v.g, v.d)) continue;
    const k = v.g + "|" + v.d + "|" + v.sex; const b = nejlepsi.get(k);
    if (!b || (NIZSI_LEPSI.has(v.d) ? v.v < b.v : v.v > b.v)) nejlepsi.set(k, v);
  }
  for (const [k, v] of nejlepsi) {
    const r = await env.DB.prepare("SELECT data FROM zaznamy WHERE id = ?1").bind("rekordy|" + k).first();
    const rek = r && r.data ? JSON.parse(r.data) : null;
    if (rek && typeof rek.v === "number" && !(NIZSI_LEPSI.has(v.d) ? v.v < rek.v : v.v > rek.v)) continue;
    await poslat(env, { spravce: true, krome: ja.id }, {
      title: rek ? "Nový rekord ke schválení" : "První rekord ke schválení",
      body: `${kategorie(v.g, v.d, v.sex)}: ${vykonText(v.d, v.v)}${v.tr ? " (" + v.tr + ")" : ""}${rek ? ", dosud " + vykonText(v.d, rek.v) : ""}. Zapsal${/a$/.test(String(ja.jmeno).split(" ")[0]) ? "a" : ""} ${ja.jmeno}.`,
      tag: "rekord-" + k, url: APPKA + "#rekordy"
    });
  }
  // Schválený rekord: upozornit autora výkonu.
  if (ja.spravce) for (const z of schvalene) {
    const r = await env.DB.prepare("SELECT data FROM zaznamy WHERE id = ?1").bind("vykony|" + z.data.vykon).first();
    const v = r && r.data ? JSON.parse(r.data) : null;
    if (!v || !v.autorId || v.autorId === ja.id) continue;
    await poslat(env, { ucitel: v.autorId }, {
      title: "Rekord schválen 🏆",
      body: `${kategorie(z.data.g, z.data.d, z.data.sex)}: ${vykonText(z.data.d, z.data.v)}${z.data.tr ? " (" + z.data.tr + ")" : ""}. Bude na nástěnce i v Síni rekordů.`,
      tag: "schvaleno-" + z.rid, url: APPKA + "#rekordy"
    });
  }
}
