import { pool } from './db';
import { runSofiPipeline, type SofiPipelineInput } from './sofi-pipeline';
import { CapacityError, consumeLimit } from './request-limits';

// Session-level advisory locks on a dedicated connection enforce a project-wide
// concurrency ceiling, including legacy requests and recovery workers.
export async function limitedPipeline(input: SofiPipelineInput) {
  const client = await pool.connect();
  let slot: number | null = null;
  try {
    for (let i = 0; i < 20; i++) {
      const result = await client.query('SELECT pg_try_advisory_lock(714112, $1) AS acquired', [i]);
      if (result.rows[0]?.acquired) { slot = i; break; }
    }
    if (slot === null) throw new CapacityError(30);
    await consumeLimit((sql, params) => client.query(sql, params), 'ai:global:day', 86400, 200);
    return await runSofiPipeline(input);
  } finally {
    try { if (slot !== null) await client.query('SELECT pg_advisory_unlock(714112, $1)', [slot]); }
    finally { client.release(); }
  }
}
