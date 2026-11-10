-- Миграция 008: прогресс образовательного маршрута ученика.
-- Аддитивно: миграции 001–007 не изменяются и ничего в них не обновляется.
-- education_programs, professional_trials и recommendations.pathways остаются каталогом и ответом Софи.
-- profiles.preferences уже хранит уверенность и данные мок-ученика, поэтому маршрут туда не кладётся.
-- Строки не вставляются. Существующие сессии получают маршрут только после отдельного PUT.

CREATE TABLE IF NOT EXISTS education_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  profession_key TEXT NOT NULL CHECK (
    profession_key = 'none'
    OR profession_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  completed SMALLINT[] NOT NULL DEFAULT '{}',
  saved_ids TEXT[] NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, profession_key),
  CHECK (cardinality(completed) <= 5),
  CHECK (completed <@ ARRAY[0, 1, 2, 3, 4]::smallint[]),
  CHECK (cardinality(saved_ids) <= 40)
);
