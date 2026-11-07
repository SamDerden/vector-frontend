import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const sessionA = crypto.randomUUID();
const sessionB = crypto.randomUUID();

const SIX_CLARIFICATIONS = [
  { questionId: "agent_q1_likes", answer: ["data"] },
  { questionId: "agent_q2_work_style", answer: "team" },
  { questionId: "agent_q3_tasks", answer: "analytical" },
  { questionId: "agent_q4_experience", answer: ["prog"] },
  { questionId: "agent_q5_format", answer: "online" },
  { questionId: "agent_q6_constraints", answer: ["free_only"] },
];

const DIAGNOSTIC_ANSWERS = [
  { questionId: "bilet_q1_subjects", answer: ["Математика", "Информатика"] },
  { questionId: "bilet_q4_decision", answer: ["Я еще ни с чем не определился(-лась)"] },
];

let passed = 0;
let failed = 0;

function headers(sessionId) {
  return {
    "Content-Type": "application/json",
    "X-Session-ID": sessionId,
  };
}

async function api(method, path, sessionId, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: sessionId ? headers(sessionId) : { "Content-Type": "application/json" },
    body: method === "GET" || body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: response.status, json };
}

function check(name, condition, extra = "") {
  if (condition) {
    console.log(`PASS | ${name}`);
    passed += 1;
  } else {
    console.log(`FAIL | ${name}${extra ? ` | ${extra}` : ""}`);
    failed += 1;
  }
}

function checkStatus(name, result, expected) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  check(
    name,
    allowed.includes(result.status),
    `HTTP ${result.status} ${result.json?.error ?? ""}`.trim()
  );
}

function sameAnswers(left, right) {
  const a = [...(left ?? [])].sort((x, y) =>
    String(x.questionId).localeCompare(String(y.questionId))
  );
  const b = [...(right ?? [])].sort((x, y) =>
    String(x.questionId).localeCompare(String(y.questionId))
  );
  return JSON.stringify(a) === JSON.stringify(b);
}

console.log(`E2E storage against ${BASE}`);
console.log(`sessionA=${sessionA}`);
console.log(`sessionB=${sessionB}`);

const health = await api("GET", "/api/health");
check("health connected", health.status === 200 && health.json?.database === "connected", `HTTP ${health.status}`);

if (health.status !== 200) {
  console.log("Server or database is unavailable. Start the app and PostgreSQL, then rerun.");
  process.exit(1);
}

const missingHeader = await api("POST", "/api/track/select", null, { trackType: "explore" });
check("401 without X-Session-ID", missingHeader.status === 401);

const badUuid = await api("POST", "/api/track/select", "not-a-uuid", { trackType: "explore" });
check("400 invalid UUID", badUuid.status === 400);

const emptyAnswers = await api("POST", "/api/diagnostic/submit", sessionA, { answers: [] });
check(
  "422 empty diagnostic before session or invalid payload",
  emptyAnswers.status === 422 || emptyAnswers.status === 404
);

const trackA = await api("POST", "/api/track/select", sessionA, { trackType: "explore" });
check("create session A", trackA.status === 200 && trackA.json?.sessionId === sessionA);

const trackUpdate = await api("POST", "/api/track/select", sessionA, { trackType: "interests" });
check("update track A", trackUpdate.status === 200 && trackUpdate.json?.trackType === "interests");

const trackB = await api("POST", "/api/track/select", sessionB, { trackType: "known_direction" });
check("create session B", trackB.status === 200);

const missingSession = await api("POST", "/api/diagnostic/submit", crypto.randomUUID(), {
  answers: DIAGNOSTIC_ANSWERS,
});
check("404 diagnostic without session", missingSession.status === 404);

const diagnosticA = await api("POST", "/api/diagnostic/submit", sessionA, {
  answers: DIAGNOSTIC_ANSWERS,
});
check(
  "save diagnostic A",
  diagnosticA.status === 201 && diagnosticA.json?.savedAnswers === DIAGNOSTIC_ANSWERS.length
);

const clarificationBefore = await api("POST", "/api/clarification/submit", sessionB, {
  answers: SIX_CLARIFICATIONS,
});
check("409 clarification without diagnostic", clarificationBefore.status === 409);

const clarificationA = await api("POST", "/api/clarification/submit", sessionA, {
  answers: SIX_CLARIFICATIONS,
});
check(
  "save six clarifications",
  clarificationA.status === 201 && clarificationA.json?.savedAnswers === 6
);

const latestA = await api("GET", "/api/diagnostic/latest", sessionA);
check("reload diagnostic", latestA.status === 200);
check(
  "diagnostic answers persist",
  sameAnswers(latestA.json?.answers, DIAGNOSTIC_ANSWERS)
);
check(
  "clarification answers persist",
  latestA.json?.clarification?.answers?.length === 6
);

const foreignDiag = await api("GET", "/api/diagnostic/latest", sessionB);
check("session B does not see session A diagnostic", foreignDiag.status === 404);

const generateA = await api("POST", "/api/recommendations/generate", sessionA, {});
const generateOk = generateA.status === 201;
check(
  generateOk
    ? "generate recommendations HTTP 201"
    : `generate recommendations not successful HTTP ${generateA.status}`,
  generateOk,
  generateA.json?.error ? String(generateA.json.error) : ""
);

if (generateOk) {
  const recId = generateA.json?.recommendationId;
  const stored = await api("GET", "/api/recommendations", sessionA);
  check("reload recommendation from PostgreSQL", stored.status === 200);
  check(
    "saved recommendation id matches",
    stored.json?.recommendationId === recId
  );
  check(
    "saved summary matches generated summary",
    stored.json?.summary === generateA.json?.summary
  );
  check(
    "nextStepOptions length is 3",
    Array.isArray(stored.json?.nextStepOptions) && stored.json.nextStepOptions.length === 3
  );

  const foreignRec = await api("GET", "/api/recommendations", sessionB);
  check("session B does not see session A recommendation", foreignRec.status === 404);

  const reflection = await api("POST", "/api/reflection", sessionA, {
    rating: "useful",
    comment: "e2e storage check",
    recommendationId: recId,
  });
  check("save reflection", reflection.status === 201 && Boolean(reflection.json?.id));

  const reflections = await api("GET", "/api/reflection", sessionA);
  check(
    "reload reflection from PostgreSQL",
    reflections.status === 200 &&
      reflections.json?.count >= 1 &&
      reflections.json?.data?.[0]?.rating === "useful"
  );

  const snapshot = await api("GET", "/api/session", sessionA);
  check("reload full session snapshot", snapshot.status === 200);
  check("snapshot trackType persisted", snapshot.json?.trackType === "interests");
  check("snapshot has diagnostic", snapshot.json?.diagnostic?.answers?.length === 2);
  check("snapshot has recommendation", snapshot.json?.recommendation?.recommendationId === recId);
  check("snapshot has reflection", snapshot.json?.reflections?.length >= 1);

  const snapshotAgain = await api("GET", "/api/session", sessionA);
  check(
    "second snapshot is stable",
    snapshotAgain.status === 200 &&
      snapshotAgain.json?.recommendation?.recommendationId === recId
  );
} else if (generateA.status === 503) {
  console.log("INFO | AI is not configured; recommendation persistence was not verified.");
} else {
  console.log("INFO | Generation failed; recommendation persistence was not verified.");
}

const invalidClarification = await api("POST", "/api/clarification/submit", sessionA, {
  answers: [{ questionId: "unknown_q", answer: "x" }],
});
check("422 unknown clarification question", invalidClarification.status === 422);

console.log("");
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
