import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import agePolicy from "@/config/age_policy.json";
import promptManifest from "@/prompts/manifest.json";

export async function buildPrompt(tierId: "1-4" | "5-8" | "9-11"): Promise<string> {
  const tierConfig = agePolicy.tiers.find(t => t.id === tierId);
  if (!tierConfig) throw new Error(`Тир ${tierId} не найден в age_policy.json`);

  const manifestEntry = promptManifest[tierId];
  if (!manifestEntry || !manifestEntry.prompt.startsWith(`${tierConfig.prompt}@`)) {
    throw new Error(`Промт для тира ${tierId} не согласован с prompts/manifest.json`);
  }
  const [promptName, promptVersion] = manifestEntry.prompt.split("@");
  const schemaVersion = manifestEntry.schema.split("@")[1];
  const promptsDirectory = path.resolve(process.cwd(), "prompts");
  const commonPath = path.join(promptsDirectory, "common", "1.0.2.md");
  const specificPath = path.join(promptsDirectory, promptName, `${promptVersion}.md`);

  const commonText = await fs.readFile(commonPath, "utf8");
  let specificText = await fs.readFile(specificPath, "utf8");
  const promptHash = createHash("sha256")
    .update(specificText)
    .update("\0")
    .update(commonText)
    .digest("hex");
  if (manifestEntry.sha256 && manifestEntry.sha256 !== promptHash) {
    throw new Error(`Хэш промта ${manifestEntry.prompt} не совпадает с prompts/manifest.json`);
  }

  specificText = specificText.replace("{{>common}}", commonText);

  const variables: Record<string, string> = {
    project_name: "Профессиональный навигатор",
    max_items: String(tierConfig.max_items),
    min_items: String(tierConfig.min_items),
    max_sentence_words: String(tierConfig.max_sentence_words),
    min_signal_answers: String(agePolicy.min_signal_answers),
    grade_range: tierConfig.grade.join("–"),
    schema_version: schemaVersion,
  };

  let finalPrompt = specificText;
  for (const [key, value] of Object.entries(variables)) {
    finalPrompt = finalPrompt.replaceAll(`{{${key}}}`, value);
  }

  const unresolvedVariables = finalPrompt.match(/\{\{[^}]+\}\}/g);
  if (unresolvedVariables) {
    throw new Error(`В промте ${manifestEntry.prompt} остались переменные: ${unresolvedVariables.join(", ")}`);
  }

  return finalPrompt.trim();
}