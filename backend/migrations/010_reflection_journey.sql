-- Optional journey step for the four-part navigator and final reflection.
-- Existing reflection rows stay NULL and remain readable.

ALTER TABLE reflections
  ADD COLUMN IF NOT EXISTS journey_step SMALLINT;

ALTER TABLE reflections
  DROP CONSTRAINT IF EXISTS reflections_journey_step_check;
ALTER TABLE reflections
  ADD CONSTRAINT reflections_journey_step_check
  CHECK (journey_step IS NULL OR journey_step BETWEEN 1 AND 4);
