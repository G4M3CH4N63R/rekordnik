-- Rekordník: schéma pro Cloudflare D1
-- Jména žáků a držitelů rekordů sem chodí jen zašifrovaná heslem kolektivu.

CREATE TABLE IF NOT EXISTS zaznamy (
  id        TEXT PRIMARY KEY,   -- "store|rid"
  store     TEXT NOT NULL,      -- zaci, vykony, rekordy, sys
  rid       TEXT NOT NULL,
  data      TEXT,               -- JSON záznamu, NULL u smazaného
  smazano   INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL DEFAULT 0,
  seq       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_zaznamy_seq ON zaznamy(seq);

CREATE TABLE IF NOT EXISTS citac (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);

INSERT OR IGNORE INTO citac (k, v) VALUES ('seq', 0);

-- Učitelé a jejich osobní kódy. Kód se ukládá jen jako SHA-256 otisk.
CREATE TABLE IF NOT EXISTS ucitele (
  id        TEXT PRIMARY KEY,
  jmeno     TEXT NOT NULL,
  kod_hash  TEXT NOT NULL UNIQUE,
  spravce   INTEGER NOT NULL DEFAULT 0,
  aktivni   INTEGER NOT NULL DEFAULT 1,
  vytvoreno INTEGER NOT NULL DEFAULT 0
);
