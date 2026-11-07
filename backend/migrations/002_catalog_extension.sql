
-- Миграция 002: расширение каталога Алисы
-- Первую миграцию не изменяем.

-- 1. Отрасли
CREATE TABLE IF NOT EXISTS industries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description_kid TEXT,
    regional_importance TEXT
);

-- 2. Навыки
CREATE TABLE IF NOT EXISTS skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    type TEXT,
    description_kid TEXT
);

-- 3. Расширяем профессии
ALTER TABLE professions
    ADD COLUMN IF NOT EXISTS external_id TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS industry_id UUID REFERENCES industries(id),
    ADD COLUMN IF NOT EXISTS riasec JSONB,
    ADD COLUMN IF NOT EXISTS demand_level_region TEXT,
    ADD COLUMN IF NOT EXISTS salary_median_region NUMERIC,
    ADD COLUMN IF NOT EXISTS vacancies_count INTEGER;

-- 4. Связь профессий и навыков
CREATE TABLE IF NOT EXISTS profession_skills (
    profession_id UUID NOT NULL REFERENCES professions(id)
        ON DELETE CASCADE,
    skill_id UUID NOT NULL REFERENCES skills(id)
        ON DELETE CASCADE,
    importance SMALLINT,
    PRIMARY KEY (profession_id, skill_id)
);

-- 5. Расширяем организации
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS external_id TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS municipality TEXT,
    ADD COLUMN IF NOT EXISTS address TEXT;

-- 6. Расширяем образовательные программы
ALTER TABLE education_programs
    ADD COLUMN IF NOT EXISTS external_id TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS organization_id UUID
        REFERENCES organizations(id),
    ADD COLUMN IF NOT EXISTS level TEXT,
    ADD COLUMN IF NOT EXISTS specialty_code TEXT,
    ADD COLUMN IF NOT EXISTS duration_years NUMERIC;

-- 7. Связь программ и профессий
CREATE TABLE IF NOT EXISTS program_professions (
    program_id UUID NOT NULL REFERENCES education_programs(id)
        ON DELETE CASCADE,
    profession_id UUID NOT NULL REFERENCES professions(id)
        ON DELETE CASCADE,
    fit_level TEXT,
    PRIMARY KEY (program_id, profession_id)
);

-- 8. Расширяем профессиональные пробы
ALTER TABLE professional_trials
    ADD COLUMN IF NOT EXISTS external_id TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS duration_minutes INTEGER,
    ADD COLUMN IF NOT EXISTS municipality TEXT,
    ADD COLUMN IF NOT EXISTS cost TEXT,
    ADD COLUMN IF NOT EXISTS source_url TEXT;

-- 9. Связь проб и профессий
CREATE TABLE IF NOT EXISTS trial_professions (
    trial_id UUID NOT NULL REFERENCES professional_trials(id)
        ON DELETE CASCADE,
    profession_id UUID NOT NULL REFERENCES professions(id)
        ON DELETE CASCADE,
    skills_checked TEXT,
    PRIMARY KEY (trial_id, profession_id)
);

-- 10. Снимки вакансий
CREATE TABLE IF NOT EXISTS vacancy_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profession_id UUID NOT NULL REFERENCES professions(id)
        ON DELETE CASCADE,
    snapshot_date DATE NOT NULL,
    vacancies_count INTEGER,
    salary_median NUMERIC,
    source_external_id TEXT
);
