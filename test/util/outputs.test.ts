import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../../src/config/schema.js";
import { resolveOutputs, resolveOutput, reviewsDirForType } from "../../src/util/outputs.js";

// Followup: `config.outputs.*` gives operators a single contact surface
// for relocating any project-tree artifact kind without code changes.
// Defaults preserve the pre-0.6.2 layout (all subdirs under projectRoot).

const ROOT = "/abs/my-project";

function config(overrides: Record<string, unknown> = {}) {
  return ConfigSchema.parse({
    version: 1,
    workspace: {
      allowed_roots: [ROOT],
      ideas_dir: `${ROOT}/ideas`,
      specs_dir: `${ROOT}/specs`,
    },
    endpoints: [
      { name: "local", provider: "openai-compatible", base_url: "http://127.0.0.1:11434/v1", trust_level: "local" },
    ],
    kb: { root: `${ROOT}/kb` },
    ...overrides,
  });
}

describe("resolveOutputs", () => {
  it("applies the default layout when outputs is omitted", () => {
    const out = resolveOutputs(ROOT, config());
    expect(out.plansDir).toBe(`${ROOT}/plans`);
    expect(out.decisionsDir).toBe(`${ROOT}/plans/decisions`);
    expect(out.reviewsDir).toBe(`${ROOT}/plans/reviews`);
    expect(out.responseLogPath).toBe(`${ROOT}/plans/reviews/response-log.md`);
    expect(out.lifecycleReportDir).toBe(`${ROOT}/plans`);
    expect(out.memoryDir).toBe(`${ROOT}/memory/daily-logs`);
    expect(out.docsDir).toBe(`${ROOT}/docs`);
    expect(out.skillsDir).toBe(`${ROOT}/skills`);
    expect(out.backupsDir).toBe(`${ROOT}/backups`);
  });

  it("honors per-kind overrides", () => {
    const out = resolveOutputs(
      ROOT,
      config({
        outputs: {
          reviews_dir: "reviews",          // relative
          decisions_dir: "/shared/adrs",    // absolute — escapes projectRoot
          lifecycle_report_dir: "reports",
        },
      }),
    );
    expect(out.reviewsDir).toBe(`${ROOT}/reviews`);
    expect(out.decisionsDir).toBe("/shared/adrs");
    expect(out.lifecycleReportDir).toBe(`${ROOT}/reports`);
    // Unspecified keys still use defaults.
    expect(out.plansDir).toBe(`${ROOT}/plans`);
    expect(out.responseLogPath).toBe(`${ROOT}/plans/reviews/response-log.md`);
  });

  it("reviewsDirForType composes with resolveOutputs", () => {
    const out = resolveOutputs(ROOT, config());
    expect(reviewsDirForType(out, "code")).toBe(`${ROOT}/plans/reviews/code`);
    expect(reviewsDirForType(out, "security")).toBe(`${ROOT}/plans/reviews/security`);
  });

  it("resolveOutput: relative joins, absolute passes through", () => {
    expect(resolveOutput(ROOT, "plans")).toBe(`${ROOT}/plans`);
    expect(resolveOutput(ROOT, "nested/dir")).toBe(`${ROOT}/nested/dir`);
    expect(resolveOutput(ROOT, "/tmp/over-there")).toBe("/tmp/over-there");
  });
});
