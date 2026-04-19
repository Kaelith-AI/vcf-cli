// OpenAI-compatible chat completion client.
//
// One surface covers Ollama (`/v1/chat/completions` on port 11434), OpenAI
// itself, OpenRouter, Groq, Together, LM Studio, and any proxy (CLIProxyAPI,
// LiteLLM, etc.) that speaks the standard shape.
//
// Design notes:
//   - Native `fetch` only — no new dependency.
//   - API key resolution happens at *call time* (from env), never at
//     config-load time, so rotating a key doesn't require a server restart.
//   - Non-2xx responses are surfaced as `LlmError` with a redacted detail
//     string. The raw body is never returned — it may contain prompt content
//     echoed back by some providers.
//   - Cancellation via AbortSignal; timeout is enforced by the caller
//     (signal is preferred over a local timer so MCP progress/abort
//     notifications propagate through).

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  /** Fully-qualified base URL ending in `/v1` (or equivalent). */
  baseUrl: string;
  /** Resolved API key (from env). Omit for keyless local endpoints. */
  apiKey: string | undefined;
  /** Provider model id — passed through unchanged. */
  model: string;
  messages: ChatMessage[];
  /** Lower = more deterministic. Default 0.1 for review tasks. */
  temperature?: number;
  /** Abort signal for cancellation / timeout propagation. */
  signal?: AbortSignal;
  /** Optional request-response JSON mode hint. Providers that don't honor
   *  it silently ignore, which is fine — we validate on parse. */
  jsonResponse?: boolean;
  /** Injected fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class LlmError extends Error {
  readonly kind: "unreachable" | "http" | "bad-response" | "canceled";
  readonly status: number | undefined;
  constructor(
    kind: "unreachable" | "http" | "bad-response" | "canceled",
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Returns the assistant's message content on success. Throws `LlmError`
 * otherwise. Never returns raw upstream response bodies.
 */
export async function callChatCompletion(req: ChatCompletionRequest): Promise<string> {
  const url = joinUrl(req.baseUrl, "chat/completions");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (req.apiKey && req.apiKey.length > 0) {
    headers.authorization = `Bearer ${req.apiKey}`;
  }
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? 0.1,
  };
  if (req.jsonResponse) {
    body.response_format = { type: "json_object" };
  }

  const fetchFn = req.fetchImpl ?? fetch;
  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  };
  if (req.signal) init.signal = req.signal;
  let res: Response;
  try {
    res = await fetchFn(url, init);
  } catch (e) {
    const err = e as Error & { name?: string };
    if (err.name === "AbortError") throw new LlmError("canceled", "request aborted");
    throw new LlmError("unreachable", `could not reach ${redactUrl(url)}: ${err.message}`);
  }

  if (!res.ok) {
    // Consume body so the socket returns to the pool, but do not surface it
    // — upstream error bodies sometimes echo the prompt.
    try {
      await res.text();
    } catch {
      /* ignore */
    }
    throw new LlmError("http", `${res.status} ${res.statusText}`, res.status);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new LlmError("bad-response", "response was not valid JSON");
  }

  const content = extractContent(json);
  if (content === null) {
    throw new LlmError("bad-response", "response missing choices[0].message.content string");
  }
  return content;
}

function extractContent(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown } };
  const c = first.message?.content;
  return typeof c === "string" ? c : null;
}

// ---- Embeddings ------------------------------------------------------------

export interface EmbeddingsRequest {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  /** Batch. Providers that only accept single strings receive each via a
   *  fan-out loop at the caller — we don't try to probe capabilities. */
  inputs: string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Returns a vector per input in the same order. Throws `LlmError` on
 * failure. Matches the OpenAI-compatible `/embeddings` response shape
 * (Ollama's `/v1/embeddings`, OpenRouter, OpenAI, LiteLLM, Nomic all
 * speak it).
 */
export async function callEmbeddings(req: EmbeddingsRequest): Promise<number[][]> {
  const url = joinUrl(req.baseUrl, "embeddings");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (req.apiKey && req.apiKey.length > 0) {
    headers.authorization = `Bearer ${req.apiKey}`;
  }
  const body = { model: req.model, input: req.inputs };
  const fetchFn = req.fetchImpl ?? fetch;
  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  };
  if (req.signal) init.signal = req.signal;

  let res: Response;
  try {
    res = await fetchFn(url, init);
  } catch (e) {
    const err = e as Error & { name?: string };
    if (err.name === "AbortError") throw new LlmError("canceled", "request aborted");
    throw new LlmError("unreachable", `could not reach ${redactUrl(url)}: ${err.message}`);
  }

  if (!res.ok) {
    try {
      await res.text();
    } catch {
      /* ignore */
    }
    throw new LlmError("http", `${res.status} ${res.statusText}`, res.status);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new LlmError("bad-response", "response was not valid JSON");
  }

  const vectors = extractVectors(json);
  if (vectors === null) {
    throw new LlmError(
      "bad-response",
      "response missing data[].embedding arrays or length mismatch",
    );
  }
  if (vectors.length !== req.inputs.length) {
    throw new LlmError(
      "bad-response",
      `expected ${req.inputs.length} embeddings, got ${vectors.length}`,
    );
  }
  return vectors;
}

function extractVectors(json: unknown): number[][] | null {
  if (typeof json !== "object" || json === null) return null;
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const out: number[][] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) return null;
    const emb = (item as { embedding?: unknown }).embedding;
    if (!Array.isArray(emb)) return null;
    const vec: number[] = [];
    for (const n of emb) {
      if (typeof n !== "number" || !Number.isFinite(n)) return null;
      vec.push(n);
    }
    out.push(vec);
  }
  return out;
}

function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path.slice(1) : path;
  return `${b}/${p}`;
}

/** Strip auth/user-info from URLs before they hit logs or error messages. */
function redactUrl(u: string): string {
  try {
    const url = new URL(u);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return u;
  }
}
