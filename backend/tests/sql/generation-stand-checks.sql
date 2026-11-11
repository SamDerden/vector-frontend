SELECT check_name, passed
FROM (
  SELECT 'generation_jobs_session_fk' AS check_name,
    EXISTS (
      SELECT 1
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_class ref ON ref.oid = con.confrelid
      WHERE rel.relname = 'generation_jobs'
        AND ref.relname = 'sessions'
        AND con.contype = 'f'
    ) AS passed
  UNION ALL
  SELECT 'generation_jobs_recommendation_fk',
    EXISTS (
      SELECT 1
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_class ref ON ref.oid = con.confrelid
      WHERE rel.relname = 'generation_jobs'
        AND ref.relname = 'recommendations'
        AND con.contype = 'f'
    )
  UNION ALL
  SELECT 'recommendations_generation_job_fk',
    EXISTS (
      SELECT 1
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_class ref ON ref.oid = con.confrelid
      WHERE rel.relname = 'recommendations'
        AND ref.relname = 'generation_jobs'
        AND con.contype = 'f'
    )
  UNION ALL
  SELECT 'generation_jobs_request_unique',
    EXISTS (
      SELECT 1
      FROM pg_index idx
      JOIN pg_class rel ON rel.oid = idx.indrelid
      WHERE rel.relname = 'generation_jobs'
        AND idx.indisunique
        AND pg_get_indexdef(idx.indexrelid) ILIKE '%session_id%'
        AND pg_get_indexdef(idx.indexrelid) ILIKE '%client_request_id%'
    )
  UNION ALL
  SELECT 'recommendations_generation_job_unique',
    EXISTS (
      SELECT 1
      FROM pg_index idx
      JOIN pg_class rel ON rel.oid = idx.indrelid
      JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY (idx.indkey)
      WHERE rel.relname = 'recommendations'
        AND idx.indisunique
        AND att.attname = 'generation_job_id'
    )
  UNION ALL
  SELECT 'generation_jobs_status_check',
    EXISTS (
      SELECT 1
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'generation_jobs'
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) ILIKE '%pending%'
        AND pg_get_constraintdef(con.oid) ILIKE '%running%'
        AND pg_get_constraintdef(con.oid) ILIKE '%completed%'
        AND pg_get_constraintdef(con.oid) ILIKE '%failed%'
    )
  UNION ALL
  SELECT 'generation_jobs_attempt_check',
    EXISTS (
      SELECT 1
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'generation_jobs'
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) ILIKE '%attempt_count%'
    )
  UNION ALL
  SELECT 'migration_006_column_present',
    EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'organizations'
        AND column_name = 'graph_organization_id'
    )
  UNION ALL
  SELECT 'migration_007_table_present',
    EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'generation_jobs'
    )
  UNION ALL
  SELECT 'migration_008_route_unique',
    EXISTS (
      SELECT 1
      FROM pg_index idx
      JOIN pg_class rel ON rel.oid = idx.indrelid
      WHERE rel.relname = 'education_routes'
        AND idx.indisunique
        AND pg_get_indexdef(idx.indexrelid) ILIKE '%session_id%'
        AND pg_get_indexdef(idx.indexrelid) ILIKE '%profession_key%'
    )
  UNION ALL
  SELECT 'migration_009_session_lifetime',
    EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'sessions'
        AND column_name = 'expires_at'
    )
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'sessions'
        AND column_name = 'session_mode'
    )
  UNION ALL
  SELECT 'migration_010_request_budgets',
    EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'request_budgets'
    )
  UNION ALL
  SELECT 'migration_011_journey_step',
    EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'reflections'
        AND column_name = 'journey_step'
    )
    AND EXISTS (
      SELECT 1
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'reflections'
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) ILIKE '%journey_step%'
    )
) checks
ORDER BY check_name;
