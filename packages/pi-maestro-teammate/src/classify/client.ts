/**
 * JEV HTTP client — the single transport boundary for the unified classifier.
 *
 * Two endpoints are supported:
 * - `typesafe`:   POST https://api.typesafe.ai/v1/systemone
 *                 (Authorization: Bearer $TYPESAFE_API_KEY, model `jev-latest`)
 * - `openrouter`: POST https://openrouter.ai/api/alpha/decisions
 *                 (Authorization: Bearer $OPENROUTER_API_KEY, model `typesafe/jev-1.13`)
 *
 * The client validates the response shape against the requested question
 * types — a malformed answer fails the call so the engine can fall back.
 */

import type {
  JevAnswer,
  JevAnswers,
  JevQuestion,
  JevQuestions,
  JevRequest,
  JevResponse,
} from "./types.ts";

export type JevEndpoint = "typesafe" | "openrouter";

export const JEV_ENDPOINT_URLS: Record<JevEndpoint, string> = {
  typesafe: "https://api.typesafe.ai/v1/systemone",
  openrouter: "https://openrouter.ai/api/alpha/decisions",
};

export const JEV_DEFAULT_MODELS: Record<JevEndpoint, string> = {
  typesafe: "jev-latest",
  openrouter: "typesafe/jev-1.13",
};

export const JEV_API_KEY_ENVS: Record<JevEndpoint, string> = {
  typesafe: "TYPESAFE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export const JEV_DEFAULT_TIMEOUT_MS = 4_000;

export interface JevClientOptions {
  endpoint: JevEndpoint;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

export interface JevClient {
  decide(request: Omit<JevRequest, "model">): Promise<JevResponse>;
}

function isFinite01(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isProbabilityMap(value: unknown): value is Record<string, number> {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

/** Validate one answer against its question type; returns the typed answer or undefined. */
function parseAnswer(raw: unknown, question: JevQuestion): JevAnswer | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const answer = raw as Record<string, unknown>;
  if (question.type === "choice") {
    const choice = typeof answer.choice === "string" ? answer.choice : undefined;
    if (!choice || !(choice in question.criteria)) return undefined;
    return {
      type: "choice",
      choice,
      ...(isFinite01(answer.confidence) ? { confidence: answer.confidence } : {}),
      ...(isProbabilityMap(answer.probabilities) ? { probabilities: answer.probabilities } : {}),
    };
  }
  if (question.type === "score") {
    if (typeof answer.score !== "number" || !Number.isFinite(answer.score)) return undefined;
    return {
      type: "score",
      score: answer.score,
      ...(isFinite01(answer.confidence) ? { confidence: answer.confidence } : {}),
      ...(isProbabilityMap(answer.probabilities) ? { probabilities: answer.probabilities } : {}),
      ...(answer.legend && typeof answer.legend === "object" && !Array.isArray(answer.legend)
        ? { legend: answer.legend as Record<string, string> }
        : {}),
    };
  }
  // noul
  if (!isFinite01(answer.noul)) return undefined;
  return { type: "noul", noul: answer.noul };
}

/** Parse the top-level response; every requested question must have a valid answer. */
export function parseJevResponse(payload: unknown, questions: JevQuestions): JevResponse | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const body = payload as { model?: unknown; answers?: unknown };
  if (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers)) {
    return undefined;
  }
  const rawAnswers = body.answers as Record<string, unknown>;
  const answers: JevAnswers = {};
  for (const [id, question] of Object.entries(questions)) {
    const parsed = parseAnswer(rawAnswers[id], question);
    if (!parsed) return undefined;
    answers[id] = parsed;
  }
  return {
    ...(typeof body.model === "string" && body.model ? { model: body.model } : {}),
    answers,
  };
}

export function createJevClient(options: JevClientOptions): JevClient {
  const url = options.baseUrl ?? JEV_ENDPOINT_URLS[options.endpoint];
  const model = options.model ?? JEV_DEFAULT_MODELS[options.endpoint];
  const timeoutMs = Math.max(1, options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS);
  const fetchFn = options.fetchFn ?? fetch;
  return {
    async decide(request) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
      const body: JevRequest = { state: request.state, model, questions: request.questions };
      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) throw new Error(`JEV request failed: HTTP ${response.status}`);
      const parsed = parseJevResponse(await response.json(), request.questions);
      if (!parsed) throw new Error("JEV response did not match the requested question schema");
      return parsed;
    },
  };
}

/** Pick an endpoint from an explicit choice, or infer from which API key env exists. */
export function resolveJevEndpoint(
  preferred: JevEndpoint | undefined,
  env: Record<string, string | undefined> = process.env,
): { endpoint: JevEndpoint; apiKey: string } | undefined {
  if (preferred) {
    const key = env[JEV_API_KEY_ENVS[preferred]]?.trim();
    return key ? { endpoint: preferred, apiKey: key } : undefined;
  }
  for (const endpoint of ["typesafe", "openrouter"] as const) {
    const key = env[JEV_API_KEY_ENVS[endpoint]]?.trim();
    if (key) return { endpoint, apiKey: key };
  }
  return undefined;
}
