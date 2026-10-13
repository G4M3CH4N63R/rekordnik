# Rekordník

Společná evidence atletických výkonů žáků pro učitele TV na ZŠ Mendelova.
Webová aplikace (PWA) pro iPhone i Android, synchronizace přes Cloudflare Worker (složka `server/`).

Živě: https://g4m3ch4n63r.github.io/rekordnik/

## Co umí (verze 1.0.0)

- **Měření:** třída, disciplína, datum a jen ťukáš výkony u jmen. Hned ukáže osobní a školní rekord,
  podezřelý výkon chce potvrdit. Funguje i bez signálu, odešle se po návratu.
- **Žáci:** profil s výkony od prvního měření, křivka zlepšení, pořadí v ročníku, mazání vlastních zápisů.
- **Přehledy:** pořadí ročníku, nejvíc zlepšení (jaro proti podzimu), třídy vedle sebe.
- **Rekordy:** školní rekordy po ročnících, nové rekordy ke schválení (schvaluje správce),
  řádky pro zápis na nástěnku, děti těsně pod rekordem.
- **Nastavení:** přihlášení osobním kódem, heslo kolektivu, export všech výkonů do CSV.
  Správce navíc nahrává seznam žáků (CSV nebo XLSX ze ŠOL), rekordy z Rekordmani.xlsx a zakládá kódy učitelům.

## Pravidla disciplín (dohoda kolektivu 13. 10. 2026)

- Hod raketkou ve všech ročnících. Hod míčkem zůstává jen jako historický rekord.
- Vrh koulí: 1. až 5. třída petanque koule, 6. a 7. třída 3 kg, 8. a 9. třída holky 3 kg, kluci 4 kg.
- 500 m ve 2. až 4. třídě, jinak 1000 m. Štafeta zůstává jen na nástěnce.

## První spuštění

1. Nasadit server podle `server/README.md`.
2. Doplnit adresu Workeru do `VYCHOZI_SERVER` v `index.html` (pak ji kolegové nemusí psát), nasadit na Pages.
3. Správce: přihlásit se svým kódem, založit heslo kolektivu, nahrát seznam žáků a Rekordmani.xlsx.
4. V Nastavení, Učitelé, přidat kolegy. Každému poslat jeho kód, heslo kolektivu říct osobně.

## Nasazení nové verze

Zvýšit `VERZE` v `index.html` a `CACHE` v `sw.js`, pak `git add -A && git commit -m "…" && git push`.
Zařízení novou verzi nabídnou lištou Načíst.
