export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.GENERATION_WORKER_ENABLED === 'true') {
    const { pool } = await import('./lib/db');
    const { startGenerationWorker } = await import('./lib/generation-worker');
    const { limitedPipeline } = await import('./lib/limited-pipeline');
    const state = globalThis as typeof globalThis & { vectorWorkerStarted?: boolean };
    if (state.vectorWorkerStarted) return;
    state.vectorWorkerStarted = true;
    // Keep worker count below the PostgreSQL pool size (10): each generation holds a dedicated AI slot connection.
    for (let i = 0; i < 8; i++) startGenerationWorker({ query: (sql, params) => pool.query(sql, params), connect: () => pool.connect(), pipeline: limitedPipeline,
      modelName: process.env.LLM_MODEL ?? process.env.AI_MODEL ?? 'sofi' });
  }
}
