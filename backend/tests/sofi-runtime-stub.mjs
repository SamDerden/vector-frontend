export const LINKED_RECOMMENDATION_SQL = `SELECT id
FROM recommendations
WHERE generation_job_id = $1 AND session_id = $2`;

export async function executeGenerate() {
  throw new Error("executeGenerate was called without a valid session header");
}

export async function runSofiPipeline() {
  throw new Error("runSofiPipeline was called without a valid session header");
}
