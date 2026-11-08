import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The approved SOFI catalog is the hybrid_v2 JSON graph. The legacy Excel v1
// importer is intentionally NOT run on application startup: it upserts a
// different dataset (40 professions / 15 trials) into the same database.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const graph = JSON.parse(await fs.readFile(path.join(root, "data/navigator_full_graph.json"), "utf8"));
const expected = graph.meta?.counts ?? {};
if (graph.meta?.schema !== "hybrid_v2") throw new Error("Expected approved hybrid_v2 catalog");
for (const field of ["industries", "professions", "skills", "organizations", "education_programs", "trials"]) {
  if (!Array.isArray(graph[field]) || graph[field].length !== expected[field]) {
    throw new Error(`Catalog mismatch for ${field}: actual=${graph[field]?.length}, declared=${expected[field]}`);
  }
}
console.log("[Catalog] Approved hybrid_v2 JSON verified:", JSON.stringify({
  version: graph.meta.version,
  professions: graph.professions.length,
  trials: graph.trials.length,
  industries: graph.industries.length,
}));
console.log("[Catalog] Legacy Excel v1 DB seeding disabled. SOFI reads the approved normalized JSON catalog.");
console.log("[Catalog] PostgreSQL legacy tables require a separate reconciled migration; no existing rows were modified.");
