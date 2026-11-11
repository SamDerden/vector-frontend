-- Approved hybrid_v2 profession identity reconciliation.
-- Run manually against the intended PostgreSQL database after a backup.
-- Never deletes rows or changes professions.id (UUID) / professions.external_id.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(91826022);

CREATE TEMP TABLE expected_professions(external_id text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO expected_professions(external_id)
SELECT 'prof_' || lpad(n::text, 3, '0') FROM generate_series(1,30) AS n;

DO $audit$
DECLARE missing_ids text; conflicting_ids text; duplicate_uuids text; n integer;
BEGIN
 SELECT string_agg(e.external_id, ', ' ORDER BY e.external_id)
 INTO missing_ids
 FROM expected_professions e LEFT JOIN professions p ON p.external_id=e.external_id
 WHERE p.id IS NULL;
 IF missing_ids IS NOT NULL THEN RAISE EXCEPTION 'Missing external_id in professions: %',missing_ids; END IF;

 SELECT string_agg(e.external_id, ', ' ORDER BY e.external_id)
 INTO conflicting_ids
 FROM expected_professions e JOIN professions p ON p.external_id=e.external_id
 WHERE p.graph_profession_id IS NOT NULL AND p.graph_profession_id <> e.external_id;
 IF conflicting_ids IS NOT NULL THEN RAISE EXCEPTION 'Conflicting graph_profession_id: %',conflicting_ids; END IF;

 SELECT string_agg(e.external_id, ', ' ORDER BY e.external_id)
 INTO conflicting_ids
 FROM expected_professions e JOIN professions p ON p.graph_profession_id=e.external_id
 WHERE p.external_id IS DISTINCT FROM e.external_id;
 IF conflicting_ids IS NOT NULL THEN RAISE EXCEPTION 'graph_profession_id already owned by another profession: %',conflicting_ids; END IF;

 SELECT COUNT(*) INTO n FROM expected_professions e JOIN professions p ON p.external_id=e.external_id;
 IF n<>30 THEN RAISE EXCEPTION 'Expected 30 matched rows; got %',n; END IF;
 SELECT COUNT(*) INTO n FROM (
  SELECT p.id FROM expected_professions e JOIN professions p ON p.external_id=e.external_id GROUP BY p.id HAVING COUNT(*)>1
 ) duplicates;
 IF n<>0 THEN RAISE EXCEPTION 'UUID reused by multiple approved professions'; END IF;
END $audit$;

-- Preserve existing UUIDs, names, references, and all non-null matching graph IDs.
UPDATE professions p SET graph_profession_id=e.external_id
FROM expected_professions e
WHERE p.external_id=e.external_id AND p.graph_profession_id IS NULL;

DO $verify$
DECLARE n integer;
BEGIN
 SELECT COUNT(*) INTO n FROM expected_professions e
 JOIN professions p ON p.external_id=e.external_id AND p.graph_profession_id=e.external_id
 WHERE p.id IS NOT NULL;
 IF n<>30 THEN RAISE EXCEPTION 'Post-update identity check failed: % of 30',n; END IF;

 -- Orphan checks for approved catalog relations; old unrelated catalog rows are not modified.
 SELECT COUNT(*) INTO n FROM profession_skills ps
 LEFT JOIN professions p ON p.id=ps.profession_id
 LEFT JOIN skills s ON s.id=ps.skill_id
 WHERE (p.id IS NULL OR s.id IS NULL);
 IF n<>0 THEN RAISE EXCEPTION 'Orphan profession_skills relations: %',n; END IF;

 SELECT COUNT(*) INTO n FROM program_professions pp
 LEFT JOIN education_programs ep ON ep.id=pp.program_id
 LEFT JOIN professions p ON p.id=pp.profession_id
 WHERE (ep.id IS NULL OR p.id IS NULL);
 IF n<>0 THEN RAISE EXCEPTION 'Orphan program_professions relations: %',n; END IF;

 SELECT COUNT(*) INTO n FROM trial_professions tp
 LEFT JOIN professional_trials pt ON pt.id=tp.trial_id
 LEFT JOIN professions p ON p.id=tp.profession_id
 WHERE (pt.id IS NULL OR p.id IS NULL);
 IF n<>0 THEN RAISE EXCEPTION 'Orphan trial_professions relations: %',n; END IF;

 SELECT COUNT(*) INTO n FROM professional_trials pt
 LEFT JOIN professions p ON p.id=pt.profession_id
 WHERE pt.profession_id IS NOT NULL AND p.id IS NULL;
 IF n<>0 THEN RAISE EXCEPTION 'Orphan professional_trials.profession_id: %',n; END IF;
END $verify$;

-- The query results are the actual external_id -> UUID -> graph_profession_id mapping.
SELECT p.external_id,p.id AS profession_uuid,p.graph_profession_id,p.title
FROM professions p JOIN expected_professions e ON e.external_id=p.external_id
ORDER BY p.external_id;

SELECT
 (SELECT COUNT(*) FROM profession_skills ps JOIN professions p ON p.id=ps.profession_id JOIN expected_professions e ON e.external_id=p.external_id) AS approved_profession_skill_links,
 (SELECT COUNT(*) FROM program_professions pp JOIN professions p ON p.id=pp.profession_id JOIN expected_professions e ON e.external_id=p.external_id) AS approved_program_profession_links,
 (SELECT COUNT(*) FROM trial_professions tp JOIN professions p ON p.id=tp.profession_id JOIN expected_professions e ON e.external_id=p.external_id) AS approved_trial_profession_links;

COMMIT;
