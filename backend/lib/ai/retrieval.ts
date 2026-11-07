// lib/ai/retrieval.ts
import fs from "node:fs/promises";
import { Dossier } from "./dossier";
import ragConfig from "@/config/rag.config.json";
import axios from "axios";
import { gatewayEndpoint, readEmbeddingsGateway } from "./gateway-env";

// ---------- Типы ----------
export interface RetrievalResult {
  industryIds: string[];
  professionIds: string[];
  // Маппинг: ID результата -> массив refs (A1, A2...), которые его вытянули
  evidence: Record<string, string[]>;
  professionScores: Record<string, number>;
  industryScores: Record<string, number>;
  coverageGap: boolean;
  uncoveredAnswerRefs: string[];
  mode: "semantic" | "mock" | "lexical";
  warnings: string[];
}

interface IndexEntry {
  chunkId: string;
  type: "profession_core" | "profession_paths" | "industry_card";
  vector: number[];
  metadata: {
    profession_id?: string;
    industry_id?: string;
    text_preview?: string;
    [key: string]: unknown;
  };
}

interface CatalogIndex {
  catalog_version: string;
  entries: IndexEntry[];
}

interface NormalizedCatalogSnapshot {
  version: string;
  chunks: {
    type: IndexEntry["type"];
    text: string;
    metadata: IndexEntry["metadata"];
  }[];
}

// ---------- Утилиты ----------

// Косинусное сходство
function cosineSimilarity(a: number[], b: number[]): number {
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

// Запрос эмбеддинга через API (или мок для обхода VPN)
async function getEmbeddings(
  texts: string[],
  indexEntries: IndexEntry[],
  timeoutMs: number
): Promise<number[][]> {
  if (process.env.USE_MOCK_EMBEDDINGS === "true") {
    console.log("[Retrieval] Используются тестовые эмбеддинги.");
    const itEntry = indexEntries.find(e => e.metadata.profession_id === "prof_010");
    const vector = itEntry?.vector ?? indexEntries[0]?.vector;
    if (!vector) throw new Error("Индекс эмбеддингов пуст");
    return texts.map(() => vector);
  }

  const settings = readEmbeddingsGateway(process.env);

  if (!settings) {
    throw new Error("Нужны LLM_BASE_URL, LLM_API_KEY, LLM_EMBEDDINGS_MODEL");
  }

  try {
    const response = await axios.post(
      gatewayEndpoint(settings.baseUrl, "embeddings"),
      { model: settings.model, input: texts },
      {
        headers: {
          "Authorization": `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: timeoutMs,
      }
    );

    const data = response.data?.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error(`Embedding API вернул ${data?.length ?? 0} векторов вместо ${texts.length}`);
    }
    const expectedDimensions = indexEntries[0]?.vector.length;
    return data.map((item: { embedding?: unknown }, index: number) => {
      const embedding = item?.embedding;
      if (
        !Array.isArray(embedding) ||
        embedding.length === 0 ||
        (expectedDimensions !== undefined && embedding.length !== expectedDimensions) ||
        !embedding.every((value) => typeof value === "number" && Number.isFinite(value))
      ) {
        throw new Error(`Embedding API вернул некорректный вектор для запроса ${index + 1}`);
      }
      return embedding as number[];
    });
  } catch (error: unknown) {
    if (axios.isAxiosError(error) && error.response) {
      throw new Error(`Embedding API error: ${error.response.status}`);
    }
    throw error;
  }
}

// RRF из задания
export function rrf(lists: string[][], k = ragConfig.rrf_k): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}

function lexicalSimilarity(query: string, text: string): number {
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

function isUninformativeAnswer(part: string): boolean {
  const selected = (part.split(":").slice(1).join(":") || part)
    .trim()
    .toLocaleLowerCase("ru");
  return /не знаю|не определил|не думал|ни в чем не перечисленном|ничего не подходит/.test(selected);
}

function selectedAnswerText(part: string): string {
  return (part.split(":").slice(1).join(":") || part).trim();
}

function hasCatalogTerm(text: string, catalogText: string): boolean {
  const ignoredTerms = new Set([
    "который", "которая", "которые", "профессия", "профессии", "профиль",
    "направление", "образование", "поступление", "профиспытаниями",
    "гуманитарное", "техническое", "творческое", "физико", "математическое",
    "например", "разные", "новые", "работа", "работать", "будущем",
  ]);
  const tokenize = (value: string) =>
    value.toLocaleLowerCase("ru").match(/[а-яё]{5,}/g)?.filter((token) => !ignoredTerms.has(token)) ?? [];
  const catalogTerms = tokenize(catalogText);
  const terms = tokenize(text);
  if (terms.length === 0) return true;
  const coveredTerms = terms.filter((term) =>
    catalogTerms.some((catalogTerm) =>
      term === catalogTerm ||
      (Math.min(term.length, catalogTerm.length) >= 5 &&
        (term.startsWith(catalogTerm) || catalogTerm.startsWith(term)))
    )
  );
  return coveredTerms.length / terms.length >= 0.6;
}

// ---------- Сборка запросов ----------

interface QueryGroup {
  groupName: string;
  text: string;
  parts: string[];
  refs: string[];
}

export function buildQueries(dossier: Dossier): QueryGroup[] {
  const groups: QueryGroup[] = [];
  const generalTexts: string[] = [];
  const generalRefs: string[] = [];

  // Группируем ответы по префиксам question_id (логика из задания)
  const subjects: string[] = [];
  const subjectsRefs: string[] = [];
  const situations: string[] = [];
  const situationsRefs: string[] = [];
  const direction: string[] = [];
  const directionRefs: string[] = [];

  for (const ans of dossier.answers) {
    const qId = `${ans.questionId} ${ans.question}`.toLowerCase();
    const selectedText = `${ans.question}: ${ans.selected.join(", ")}`;
    generalTexts.push(selectedText);
    generalRefs.push(ans.ref);

    if (
      /subject|profile|events|decision|readiness|предмет|профил|мероприяти|решени|готовност/.test(qId)
    ) {
      subjects.push(selectedText);
      subjectsRefs.push(ans.ref);
    } else if (/future_direction|direction|направлени/.test(qId)) {
      direction.push(selectedText);
      directionRefs.push(ans.ref);
    } else {
      situations.push(selectedText);
      situationsRefs.push(ans.ref);
    }
  }

  if (subjects.length > 0) {
    groups.push({
      groupName: "subjects",
      text: `Предметы и профиль: ${subjects.join("; ")}`,
      parts: subjects,
      refs: subjectsRefs,
    });
  }
  if (situations.length > 0) {
    groups.push({
      groupName: "situations",
      text: `Ситуативные выборы: ${situations.join("; ")}`,
      parts: situations,
      refs: situationsRefs,
    });
  }
  if (direction.length > 0) {
    groups.push({
      groupName: "direction",
      text: `Направление: ${direction.join("; ")}`,
      parts: direction,
      refs: directionRefs,
    });
  }

  // Общий запрос
  if (generalTexts.length > 0) {
    groups.push({
      groupName: "general",
      text: `Общий профиль: ${generalTexts.join("; ")}`,
      parts: generalTexts,
      refs: generalRefs,
    });
  }

  return groups;
}

// ---------- Основная функция ----------

export async function retrieve(
  dossier: Dossier,
  options: { deadlineAt?: number } = {}
): Promise<RetrievalResult> {
  const queries = buildQueries(dossier);
  if (queries.length === 0) {
    return {
      industryIds: [],
      professionIds: [],
      evidence: {},
      professionScores: {},
      industryScores: {},
      coverageGap: false,
      uncoveredAnswerRefs: [],
      mode: process.env.USE_MOCK_EMBEDDINGS === "true" ? "mock" : "semantic",
      warnings: [],
    };
  }

  // 1. Загружаем индекс
  const [indexRaw, catalogRaw] = await Promise.all([
    fs.readFile("data/catalog.index.json", "utf8"),
    fs.readFile("data/catalog.normalized.json", "utf8"),
  ]);
  const index = JSON.parse(indexRaw) as CatalogIndex;
  const catalog = JSON.parse(catalogRaw) as NormalizedCatalogSnapshot;
  const indexIsCurrent = index.catalog_version === catalog.version;
  const entries = indexIsCurrent
    ? index.entries
    : catalog.chunks.map((chunk, index) => ({
        chunkId: `${chunk.type}:${index}`,
        type: chunk.type,
        vector: [],
        metadata: {
          ...chunk.metadata,
          text_preview: chunk.text,
        },
      }));

  const industryEntries = entries.filter((e) => e.type === "industry_card");
  const professionEntries = entries.filter(
    (e) => e.type === "profession_core" || e.type === "profession_paths"
  );

  // 2. Собираем запросы
  console.log(`[Retrieval] Сформировано запросов: ${queries.length} (${queries.map(q => q.groupName).join(", ")})`);

  // 3. Для каждого запроса ищем top-k
  const industryLists: string[][] = [];
  const professionLists: string[][] = [];
  const evidenceMap = new Map<string, Set<string>>(); // ID -> Set of refs
  const warnings = new Set<string>();
  const uncoveredAnswerRefs = new Set<string>();
  const isMock = process.env.USE_MOCK_EMBEDDINGS === "true";
  let semanticAvailable = indexIsCurrent && isMock;
  let queryVectors: number[][] = [];
  const allQueryTexts = queries.map((query) => query.text);
  if (!indexIsCurrent) warnings.add("catalog_index_stale_lexical_fallback");
  if (indexIsCurrent && isMock) {
    try {
      queryVectors = await getEmbeddings(allQueryTexts, entries, 1);
    } catch (error) {
      semanticAvailable = false;
      warnings.add("embedding_unavailable_lexical_fallback");
      console.warn("[Retrieval] Тестовые эмбеддинги недоступны; используется локальный поиск.", error);
    }
  } else if (indexIsCurrent) {
    const remaining = options.deadlineAt === undefined
      ? ragConfig.embedding_timeout_ms
      : options.deadlineAt - Date.now();
    if (remaining <= 0) {
      warnings.add("embedding_deadline_exceeded_lexical_fallback");
    } else {
      try {
        queryVectors = await getEmbeddings(
          allQueryTexts,
          entries,
          Math.min(ragConfig.embedding_timeout_ms, remaining)
        );
        semanticAvailable = true;
      } catch (error) {
        warnings.add("embedding_unavailable_lexical_fallback");
        console.warn(
          "[Retrieval] Эмбеддинги недоступны; используется локальный поиск по тексту.",
          error instanceof Error ? error.message : "unknown error"
        );
      }
    }
  }

  for (const [queryIndex, query] of queries.entries()) {
    const qVector = semanticAvailable ? queryVectors[queryIndex] : undefined;
    const minimumScore = qVector
      ? ragConfig.min_similarity
      : ragConfig.lexical_min_similarity;
    const scoreEntry = (entry: IndexEntry) =>
      qVector
        ? cosineSimilarity(qVector, entry.vector)
        : Math.max(
            ...query.parts.map((part) =>
              lexicalSimilarity(part, entry.metadata.text_preview ?? "")
            )
          );

    // Ищем отрасли
    const industryScores = industryEntries.map((e) => ({
      id: e.metadata.industry_id!,
      score: scoreEntry(e),
    }))
    .filter((x) => x.score >= minimumScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, ragConfig.top_k_industries);

    industryLists.push(industryScores.map((x) => x.id));

    // Запоминаем evidence для отраслей
    for (const item of industryScores) {
      if (!evidenceMap.has(item.id)) evidenceMap.set(item.id, new Set());
      query.refs.forEach((r) => evidenceMap.get(item.id)!.add(r));
    }

    // Ищем профессии
    const professionScoreById = new Map<string, number>();
    for (const entry of professionEntries) {
      const id = entry.metadata.profession_id;
      if (!id) continue;
      const score = scoreEntry(entry);
      professionScoreById.set(id, Math.max(professionScoreById.get(id) ?? -1, score));
    }
    const professionScores = [...professionScoreById.entries()]
      .map(([id, score]) => ({ id, score }))
      .filter((item) => item.score >= minimumScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, ragConfig.top_k_professions);

    professionLists.push(professionScores.map((x) => x.id));

    // Запоминаем evidence для профессий
    for (const item of professionScores) {
      if (!evidenceMap.has(item.id)) evidenceMap.set(item.id, new Set());
      query.refs.forEach((r) => evidenceMap.get(item.id)!.add(r));
    }

    if (dossier.student.tier !== "1-4" && query.groupName === "direction") {
      const catalogText = entries
        .filter((entry) => entry.type === "profession_core")
        .map((entry) => entry.metadata.text_preview ?? "")
        .join(" ");
      query.parts.forEach((part, partIndex) => {
        if (isUninformativeAnswer(part)) return;
        const answerText = selectedAnswerText(part);
        const coveredByCatalog = hasCatalogTerm(answerText, catalogText);
        const ref = query.refs[partIndex];
        if (!coveredByCatalog && ref) uncoveredAnswerRefs.add(ref);
      });
    }
  }

  // 4. Слияние RRF
  const industryRrf = rrf(industryLists);
  const professionRrf = rrf(professionLists);

  // Сортируем по RRF-скору
  const sortedIndustries = [...industryRrf.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
  const sortedProfessions = [...professionRrf.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);

  // 5. Формируем evidence (массив refs)
  const evidence: Record<string, string[]> = {};
  for (const [id, refsSet] of evidenceMap.entries()) {
    evidence[id] = Array.from(refsSet);
  }

  return {
    industryIds: sortedIndustries,
    professionIds: sortedProfessions,
    evidence,
    professionScores: Object.fromEntries(professionRrf),
    industryScores: Object.fromEntries(industryRrf),
    coverageGap: uncoveredAnswerRefs.size > 0,
    uncoveredAnswerRefs: [...uncoveredAnswerRefs],
    mode: isMock && indexIsCurrent ? "mock" : semanticAvailable ? "semantic" : "lexical",
    warnings: [...warnings],
  };
}