# Rekordník: server

Cloudflare Worker plus databáze D1, stejně jako u Cvičky. Free tarif stačí s velkou rezervou.

## Co na serveru leží

- **Žáci:** jen náhodné číslo a zašifrovaný blok (jméno, příjmení, písmeno třídy, rok nástupu, pohlaví).
  Šifruje se heslem kolektivu v telefonu (AES-GCM, klíč z hesla přes PBKDF2), server vidí jen bajty.
- **Výkony:** číslo žáka, disciplína, hodnota, datum, třída a kdo zápis udělal. Bez jmen.
- **Rekordy:** hodnota, třída, datum a zašifrované jméno držitele.
- **Učitelé:** jméno a SHA-256 otisk osobního kódu. Samotný kód se nikde neukládá.

Seznam žáků, rekordy a nastavení šifrování smí měnit jen správce. Výkon smí změnit nebo smazat
jen ten, kdo ho zapsal, nebo správce. Hlídá to Worker, ne jen aplikace.

## Nasazení (jednou)

Databáze `rekordnik` je už založená a má tabulky, `database_id` je vyplněné ve `wrangler.toml`
(ten soubor je v `.gitignore`, do repa nejde). Zbývají tři kroky:

```
cd ~/Desktop/"ZŠ Mendelova"/"Rekordy na nástěnku"/rekordnik/server
npx wrangler deploy
```

Vypíše adresu ve tvaru `https://rekordnik.<tvůj-účet>.workers.dev`. Pak nastav svůj správcovský kód
a jméno. Kód si vymysli nebo vygeneruj, nikam ho nezapisuj do repa:

```
openssl rand -hex 8                       # vygeneruje kód, třeba 3f9a1c0be2d47a65
npx wrangler secret put SPRAVCE_KOD       # vlož ten kód
npx wrangler secret put SPRAVCE_JMENO     # napiš Karel Hönig
```

## Ověření

```
curl -s -H "Authorization: Bearer <TVŮJ KÓD>" https://rekordnik.<účet>.workers.dev/ja
```

Má vrátit `{"ok":true,"id":"spravce","jmeno":"Karel Hönig","spravce":true}`.

## Endpointy

| Endpoint | Co dělá |
|---|---|
| `GET /ja` | kdo jsem podle kódu |
| `GET /stav` | počet řádků a pořadové číslo |
| `POST /sync` | jedno kolo synchronizace, stejný protokol jako Cvička |
| `GET /ucitele`, `POST /ucitele` | správa učitelů a kódů (jen správce): `pridat`, `zrusit`, `obnovit`, `novy-kod` |

Všechno chce hlavičku `Authorization: Bearer <kód>`.

## Když někdo odejde

V aplikaci Nastavení, Učitelé, Zrušit kód. Pak změň heslo kolektivu (zatím jen ručně:
nové heslo znamená nový import žáků i rekordů, ozvi se Claudovi).
