-- Миграция 004: поля ИИ-модуля Софи.
-- Аддитивно: строки не удаляются и не переписываются.
-- trial_ids остаётся UUID[]. Миграции 001–003 не изменяются.
-- Каталог в таблицы не загружается.

ALTER TABLE diagnostic_answers
  ADD COLUMN IF NOT EXISTS questionnaire TEXT;

ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS catalog_version TEXT,
  ADD COLUMN IF NOT EXISTS config_version TEXT,
  ADD COLUMN IF NOT EXISTS generation_mode TEXT,
  ADD COLUMN IF NOT EXISTS ai_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

-- В 001 ограничение класса безымянное:
--   school_grade SMALLINT CHECK (school_grade BETWEEN 8 AND 11)
-- Имя в исходном SQL не задано. PostgreSQL хранит его в pg_constraint.
-- Снимаем только проверку диапазона 8–11 и ставим именованную 1–11.
-- NULL по-прежнему допустим: CHECK не запрещает NULL.
DO $$
DECLARE
  grade_check record;
BEGIN
  FOR grade_check IN
    SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'profiles'
      AND rel.relnamespace = current_schema()::regnamespace
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%school_grade%'
  LOOP
    IF grade_check.conname = 'profiles_school_grade_1_11' THEN
      CONTINUE;
    END IF;

    IF (
      grade_check.definition LIKE '%>= 8%'
      AND grade_check.definition LIKE '%<= 11%'
      AND grade_check.definition NOT LIKE '%>= 1%'
    ) OR grade_check.definition ILIKE '%BETWEEN 8 AND 11%' THEN
      EXECUTE format(
        'ALTER TABLE profiles DROP CONSTRAINT %I',
        grade_check.conname
      );
    ELSE
      RAISE EXCEPTION
        'profiles.school_grade has an unexpected check constraint %: %',
        grade_check.conname,
        grade_check.definition;
    END IF;
  END LOOP;
END $$;

ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_school_grade_1_11;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_school_grade_1_11
  CHECK (school_grade IS NULL OR school_grade BETWEEN 1 AND 11);
