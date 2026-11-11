import { readFileSync } from "node:fs";
import path from "node:path";

const catalogPath = path.resolve(process.cwd(), "data/catalog.normalized.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const integrity = await import(new URL("../lib/catalog-integrity.ts", import.meta.url).href);
const report = integrity.auditNormalizedCatalog(catalog);

if (process.env.CATALOG_AUDIT_ALLOW_DB === "true") {
  console.error("Database comparison is prepared but this process refuses to open PostgreSQL.");
  console.error("Run the SELECT statements in the report on a read-only session of the stand.");
  process.exit(2);
}

console.log(JSON.stringify({
  ...report,
  discrepancyCount: report.discrepancies.length,
  readOnlySql: integrity.READ_ONLY_CATALOG_SQL,
}, null, 2));
