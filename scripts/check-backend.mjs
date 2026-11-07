const base = (process.env.BACKEND_INTERNAL_URL || 'http://localhost:3000').replace(/\/$/, '');
const timeout = AbortSignal.timeout(5000);
try {
  const response = await fetch(base + '/api/health', { signal: timeout });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  console.log('Backend health OK:', base);
} catch (error) {
  console.error('Backend unavailable:', base, error.message);
  process.exitCode = 1;
}
