export type RetrievalMode = "semantic" | "mock" | "lexical";

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function lexicalSimilarity(query: string, text: string): number {
  const stopWords = new Set([
    "которые", "который", "которых", "какие", "какая", "какой", "тебе", "твой",
    "твоя", "твои", "больше", "всего", "нравится", "интересно", "делать", "работа",
    "вопрос", "ответ", "школе", "будущем", "профессия", "профессии", "отрасль",
  ]);
  const tokens = (value: string) =>
    new Set(
      value.toLocaleLowerCase("ru").match(/[а-яёa-z0-9]{3,}/g)?.filter((token) => !stopWords.has(token)) ?? []
    );
  const queryTokens = tokens(query);
  const textTokens = tokens(text);
  if (queryTokens.size === 0 || textTokens.size === 0) return 0;
  let intersection = 0;
  for (const queryToken of queryTokens) {
    const matched = [...textTokens].some((textToken) =>
      queryToken === textToken ||
      (
        Math.min(queryToken.length, textToken.length) >= 5 &&
        (queryToken.startsWith(textToken) || textToken.startsWith(queryToken))
      )
    );
    if (matched) intersection++;
  }
  return intersection / Math.sqrt(queryTokens.size * textTokens.size);
}

/**
 * Semantic is reported only after a usable embedding comparison.
 * A gateway timeout, model mismatch, or empty query stays lexical.
 */
export function selectRetrievalMode(input: {
  queryCount: number;
  mockEmbeddings: boolean;
  vectorsUsable: boolean;
  semanticAvailable: boolean;
}): RetrievalMode {
  if (input.queryCount === 0) return input.mockEmbeddings ? "mock" : "lexical";
  if (input.mockEmbeddings && input.vectorsUsable && input.semanticAvailable) return "mock";
  if (input.semanticAvailable) return "semantic";
  return "lexical";
}

export function scoreCatalogEntries(input: {
  entries: Array<{ id: string; vector: number[]; text: string }>;
  queryVector: number[] | null;
  queryParts: string[];
  minimum: number;
}): Array<{ id: string; score: number }> {
  return input.entries
    .map((entry) => {
      const lexicalScores = input.queryParts.map((part) => lexicalSimilarity(part, entry.text));
      const score = input.queryVector
        ? cosineSimilarity(input.queryVector, entry.vector)
        : lexicalScores.length > 0 ? Math.max(...lexicalScores) : 0;
      return { id: entry.id, score };
    })
    .filter((item) => item.score >= input.minimum)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}
