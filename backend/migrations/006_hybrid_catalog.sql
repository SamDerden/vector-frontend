-- Миграция 006: ключи графа hybrid_v2 для организаций, программ и проб.
-- Аддитивно: строки, UUID, external_id, названия и связи не меняются.
-- trial_type не добавляется: словарь ещё не согласован.
-- Миграции 001–005 не изменяются.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS graph_organization_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_graph_organization_id_key
  ON organizations (graph_organization_id);

ALTER TABLE education_programs
  ADD COLUMN IF NOT EXISTS graph_program_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS education_programs_graph_program_id_key
  ON education_programs (graph_program_id);

ALTER TABLE professional_trials
  ADD COLUMN IF NOT EXISTS graph_trial_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS professional_trials_graph_trial_id_key
  ON professional_trials (graph_trial_id);

-- В 001 три безымянных CHECK:
--   CHECK (age_min IS NULL OR age_min BETWEEN 8 AND 25)
--   CHECK (age_max IS NULL OR age_max BETWEEN 8 AND 25)
--   CHECK (age_min IS NULL OR age_max IS NULL OR age_min <= age_max)
-- Имена в исходном SQL не заданы. Снимаем только два диапазона 8–25,
-- сверив определение. Ограничение age_min <= age_max не трогаем.
-- NULL по-прежнему допустим.
DO $$
DECLARE
  age_check record;
  definition text;
  min_name text;
  max_name text;
  min_matches integer := 0;
  max_matches integer := 0;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM professional_trials
    WHERE (age_min IS NOT NULL AND (age_min < 5 OR age_min > 25))
       OR (age_max IS NOT NULL AND (age_max < 5 OR age_max > 25))
       OR (
         age_min IS NOT NULL
         AND age_max IS NOT NULL
         AND age_min > age_max
       )
  ) THEN
    RAISE EXCEPTION
      'professional_trials has ages outside 5-25 or age_min greater than age_max';
  END IF;

  FOR age_check IN
    SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'professional_trials'
      AND rel.relnamespace = current_schema()::regnamespace
      AND con.contype = 'c'
  LOOP
    IF age_check.conname IN (
      'professional_trials_age_min_5_25',
      'professional_trials_age_max_5_25'
    ) THEN
      CONTINUE;
    END IF;

    definition := age_check.definition;

    IF definition ILIKE '%age_min%'
      AND definition NOT ILIKE '%age_max%'
      AND (
        (
          definition LIKE '%>= 8%'
          AND definition LIKE '%<= 25%'
        )
        OR definition ILIKE '%BETWEEN 8 AND 25%'
      )
      AND definition NOT LIKE '%>= 5%'
      AND definition NOT ILIKE '%BETWEEN 5 AND 25%' THEN
      min_matches := min_matches + 1;
      min_name := age_check.conname;
    ELSIF definition ILIKE '%age_max%'
      AND definition NOT ILIKE '%age_min%'
      AND (
        (
          definition LIKE '%>= 8%'
          AND definition LIKE '%<= 25%'
        )
        OR definition ILIKE '%BETWEEN 8 AND 25%'
      )
      AND definition NOT LIKE '%>= 5%'
      AND definition NOT ILIKE '%BETWEEN 5 AND 25%' THEN
      max_matches := max_matches + 1;
      max_name := age_check.conname;
    ELSIF definition ILIKE '%age_min%'
      AND definition ILIKE '%age_max%'
      AND definition LIKE '%<=%'
      AND definition NOT LIKE '%>=%'
      AND definition NOT ILIKE '%BETWEEN%' THEN
      CONTINUE;
    ELSIF definition ILIKE '%age_min%'
      OR definition ILIKE '%age_max%' THEN
      RAISE EXCEPTION
        'professional_trials has an unexpected age check %: %',
        age_check.conname,
        definition;
    END IF;
  END LOOP;

  IF min_matches > 1 OR max_matches > 1 THEN
    RAISE EXCEPTION
      'professional_trials age checks are ambiguous: age_min matches %, age_max matches %',
      min_matches,
      max_matches;
  END IF;

  IF min_matches = 0 AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'professional_trials'
      AND rel.relnamespace = current_schema()::regnamespace
      AND con.conname = 'professional_trials_age_min_5_25'
  ) THEN
    RAISE EXCEPTION
      'professional_trials age_min check 8-25 was not found';
  END IF;

  IF max_matches = 0 AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'professional_trials'
      AND rel.relnamespace = current_schema()::regnamespace
      AND con.conname = 'professional_trials_age_max_5_25'
  ) THEN
    RAISE EXCEPTION
      'professional_trials age_max check 8-25 was not found';
  END IF;

  IF min_matches = 1 THEN
    EXECUTE format(
      'ALTER TABLE professional_trials DROP CONSTRAINT %I',
      min_name
    );
  END IF;

  IF max_matches = 1 THEN
    EXECUTE format(
      'ALTER TABLE professional_trials DROP CONSTRAINT %I',
      max_name
    );
  END IF;
END $$;

ALTER TABLE professional_trials
  DROP CONSTRAINT IF EXISTS professional_trials_age_min_5_25;

ALTER TABLE professional_trials
  ADD CONSTRAINT professional_trials_age_min_5_25
  CHECK (age_min IS NULL OR age_min BETWEEN 5 AND 25);

ALTER TABLE professional_trials
  DROP CONSTRAINT IF EXISTS professional_trials_age_max_5_25;

ALTER TABLE professional_trials
  ADD CONSTRAINT professional_trials_age_max_5_25
  CHECK (age_max IS NULL OR age_max BETWEEN 5 AND 25);
