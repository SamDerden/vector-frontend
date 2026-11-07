-- Миграция 005: ключ профессии в графе hybrid_v2.
-- Не меняет professions.id и professions.external_id.
-- NULL допустим для старых строк, которые ещё не сопоставлены.
-- В PostgreSQL уникальный индекс разрешает несколько NULL.

ALTER TABLE professions
  ADD COLUMN IF NOT EXISTS graph_profession_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS professions_graph_profession_id_key
  ON professions (graph_profession_id);
