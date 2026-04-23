// test_stress — project scope. Followup #23.
//
// Stress / fuzz-at-volume test kind. Two configurations (matches the user's
// spec for both automated and LLM-driven paths):
//
//   mode="llm-driven" (default) — returns a scaffolding prompt the calling
//     LLM uses to generate N adversarial inputs and drive test_execute.
//     Best when you want Claude Code / Codex / Gemini CLI to author the
//     fuzz harness itself.
//
//   mode="endpoint" — forwards a generator request to a configured
//     OpenAI-compatible endpoint. The endpoint returns the generated
//     inputs, which are then fed into a harness the caller runs via
//     test_execute. `config.defaults.stress_test` resolves the endpoint
//     if none is passed.
//
// Runner persona: the subject-under-test shouldn't be running the
// generator. Pair with a subagent or a local-LLM endpoint, not with the
// main orchestrator that produced the code being tested.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerDeps } from "../server.js";
import { runTool, success } from "../envelope.js";
import { writeAudit } from "../util/audit.js";
import { McpError } from "../errors.js";
import { callChatCompletion, LlmError } from "../util/llmClient.js";

const StressShape = z.enum(["valid-fuzz", "invalid-fuzz", "boundary", "unicode", "path-traversal"]);

const TestStressInput = z
  .object({
    subject: z
      .string()
      .min(1)
      .max(256)
      .describe("the tool / function / CLI command being stress-tested"),
    shape: StressShape.default("invalid-fuzz"),
    count: z.number().int().positive().max(1000).default(100),
    mode: z.enum(["llm-driven", "endpoint"]).default("llm-driven"),
    endpoint: z.string().min(1).max(128).optional(),
    model_id: z.string().min(1).max(128).optional(),
    timeout_ms: z.number().int().positive().max(600_000).default(180_000),
    expand: z.boolean().default(true),
  })
  .strict();

type TestStressArgs = z.infer<typeof TestStressInput>;

export function registerTestStress(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "test_stress",
    {
      title: "Stress Test — Fuzz at Volume",
      description:
        "Fuzz a tool/function/CLI with N adversarial inputs. mode=llm-driven (default) returns a scaffolding prompt the calling LLM uses to generate inputs + drive test_execute. mode=endpoint forwards generation to a configured OpenAI-compatible endpoint. Use a fresh runner (subagent / local LLM), not the main orchestrator that produced the code.",
      inputSchema: TestStressInput,
    },
    async (args: TestStressArgs) => {
      return runTool(
        async () => {
          if (!deps.projectDb) {
            throw new McpError("E_STATE_INVALID", "test_stress requires project scope");
          }
          const parsed = TestStressInput.parse(args);
          const projectRoot = readProjectRoot(deps);
          if (!projectRoot) throw new McpError("E_STATE_INVALID", "project row missing");

          const content: Record<string, unknown> = {
            mode: parsed.mode,
            subject: parsed.subject,
            shape: parsed.shape,
            count: parsed.count,
          };

          if (parsed.mode === "llm-driven") {
            content.scaffolding_prompt = buildPrompt(parsed);
          } else {
            // endpoint mode — forward generation to a configured endpoint.
            const defaults = deps.config.defaults?.stress_test;
            const endpointName = parsed.endpoint ?? defaults?.endpoint;
            const modelId = parsed.model_id ?? defaults?.model;
            if (!endpointName) {
              throw new McpError(
                "E_VALIDATION",
                "test_stress mode=endpoint requires an endpoint arg or config.defaults.stress_test.endpoint",
              );
            }
            if (!modelId) {
              throw new McpError(
                "E_VALIDATION",
                "test_stress mode=endpoint requires model_id arg or config.defaults.stress_test.model",
              );
            }
            const endpoint = deps.config.endpoints.find((e) => e.name === endpointName);
            if (!endpoint) {
              throw new McpError(
                "E_VALIDATION",
                `endpoint '${endpointName}' not found in config.endpoints`,
              );
            }
            const apiKey = endpoint.auth_env_var
              ? process.env[endpoint.auth_env_var]
              : undefined;
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), parsed.timeout_ms);
            try {
              const generated = await callChatCompletion({
                baseUrl: endpoint.base_url,
                apiKey,
                model: modelId,
                messages: [
                  { role: "system", content: buildSystemPrompt(parsed) },
                  { role: "user", content: buildUserPrompt(parsed) },
                ],
                temperature: 0.3,
                signal: ac.signal,
              });
              content.endpoint = endpointName;
              content.model_id = modelId;
              content.generated = generated;
            } catch (e: unknown) {
              if (e instanceof LlmError) throw new McpError("E_INTERNAL", `LLM: ${e.message}`);
              throw new McpError("E_INTERNAL", e instanceof Error ? e.message : String(e));
            } finally {
              clearTimeout(timer);
            }
          }

          const summary =
            parsed.mode === "llm-driven"
              ? `test_stress: llm-driven scaffold for subject=${parsed.subject} shape=${parsed.shape} count=${parsed.count}`
              : `test_stress: generated ${parsed.count} input(s) via ${String(content.endpoint)}/${String(content.model_id)}`;

          return success([], summary, {
            ...(parsed.expand
              ? { content }
              : { expand_hint: "Pass expand=true for the scaffolding prompt or generated payload." }),
          });
        },
        (payload) => {
          writeAudit(deps.globalDb, {
            tool: "test_stress",
            scope: "project",
            project_root: readProjectRoot(deps),
            inputs: args,
            outputs: payload,
            result_code: payload.ok ? "ok" : payload.code,
          });
        },
      );
    },
  );
}

function buildSystemPrompt(parsed: TestStressArgs): string {
  return [
    "You are a stress-test input generator for the Vibe Coding Framework.",
    `Shape: ${parsed.shape}.`,
    `Target: ${parsed.subject}.`,
    `Return exactly ${parsed.count} adversarial inputs as a JSON array. Do not include prose.`,
    "Each entry in the array is either a primitive (string/number/boolean) or an object whose shape matches the subject's input schema. When the shape argues for invalid inputs, produce examples likely to fail input validation.",
  ].join("\n");
}

function buildUserPrompt(parsed: TestStressArgs): string {
  return [
    `Generate ${parsed.count} inputs for the ${parsed.shape} shape of stress test against \`${parsed.subject}\`.`,
    "Return only the JSON array; no prose, no markdown fences.",
  ].join("\n");
}

function buildPrompt(parsed: TestStressArgs): string {
  return [
    `# Stress test scaffold — ${parsed.subject}`,
    ``,
    `You are generating a stress / fuzz harness for \`${parsed.subject}\``,
    `with ${parsed.count} adversarial inputs of shape \`${parsed.shape}\`.`,
    ``,
    `## Shape reference`,
    `- **valid-fuzz** — valid inputs across the full distribution. Passes`,
    `  expected? Good. Catches correctness drift across inputs the happy-`,
    `  path tests didn't cover.`,
    `- **invalid-fuzz** — inputs that violate input schema / preconditions.`,
    `  Should reject with the documented error code. Passes = tool accepted`,
    `  something it shouldn't have.`,
    `- **boundary** — empty, max-length, unicode zero-width, null bytes,`,
    `  control characters, negative numbers, NaN, Infinity, very large ints.`,
    `- **unicode** — RTL overrides, mixed-script domains, zero-width joiners,`,
    `  normalization forms (NFC vs NFD). Common source of display spoofing`,
    `  and hash-mismatch bugs.`,
    `- **path-traversal** — \`../\`, absolute paths, symlink-to-outside,`,
    `  null-byte termination, windows UNC paths, case-insensitive collisions.`,
    ``,
    `## Runner persona (non-negotiable)`,
    `You must NOT be the model that wrote the subject code. Fresh eyes.`,
    `Dispatch a subagent or use a different endpoint/model than the one`,
    `used during the build. Confirmation bias on "my own code" is the`,
    `single biggest source of false-pass results.`,
    ``,
    `## Step 1 — Generate inputs`,
    `Produce exactly ${parsed.count} inputs. Return them as a JSON array`,
    `(no prose, no markdown fences). Diversity matters: avoid 100 copies`,
    `of the same shape with a counter suffix.`,
    ``,
    `## Step 2 — Run the harness`,
    `For each input, call \`test_execute\` with the subject + the input.`,
    `Collect (input, exit_code, stderr_tail) tuples. Use test_execute's`,
    `\`timeout_ms\` to prevent hung inputs from blocking the run.`,
    ``,
    `## Step 3 — Cluster failures`,
    `Group failures by (exit_code, stderr_pattern). Report each cluster`,
    `with a minimal repro input. A single input per cluster is enough for`,
    `the operator — don't dump all 47 copies of the same failure.`,
    ``,
    `## Step 4 — Propose`,
    `For each failure cluster: input, observed behavior, expected behavior`,
    `per spec, and a proposed fix OR "accept as documented behavior" with`,
    `rationale. The operator reviews.`,
    ``,
    `## Guardrails`,
    `- Stop if a single input causes the subject to allocate unbounded`,
    `  memory or spawn child processes without cleanup — escalate first.`,
    `- Do NOT commit harness results that contain raw secrets. Run all`,
    `  inputs and captured stderr through the redaction helper before`,
    `  persisting anywhere.`,
    `- A passing run across ${parsed.count} inputs means this shape is`,
    `  currently well-covered. It does NOT mean other shapes are covered`,
    `  — run \`test_stress\` for each relevant shape.`,
  ].join("\n");
}

function readProjectRoot(deps: ServerDeps): string | null {
  const row = deps.projectDb?.prepare("SELECT root_path FROM project WHERE id=1").get() as
    | { root_path: string }
    | undefined;
  return row?.root_path ?? null;
}

export { TestStressInput };
