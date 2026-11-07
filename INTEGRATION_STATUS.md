# Vector integration status

This branch adds a same-origin Next.js proxy for the **separate** professional-navigator backend.

## Local run

1. Start the backend from the supplied `professional_navigator_frontend.zip` with its PostgreSQL database, migrations, catalog and AI environment configuration. Backend listens on port 3000.
2. In this frontend run `npm install` and `npm run dev`; frontend listens on port 3001.
3. The browser requests `/api/*` on port 3001; Next.js forwards them to `BACKEND_INTERNAL_URL` (default `http://localhost:3000`).
4. Run `node scripts/check-backend.mjs` to check database-backed health.

## Important limitations

- This repository **does not yet contain the backend sources**. Backend is not automatically deployed by this PR.
- GitHub Actions currently checks frontend TypeScript and production compilation only, not live API compatibility.
- Backend /api/health requires a reachable PostgreSQL instance.
- Frontend result response mapping, session recovery and demo profiles still require end-to-end tests against the running backend.
- Do not merge this draft PR until backend integration and end-to-end tests pass.
