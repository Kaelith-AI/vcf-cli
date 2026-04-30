import { describe, it, expect } from "vitest";
import { join, resolve as resolvePath } from "node:path";
import { ConfigSchema } from "../../src/config/schema.js";
import { resolveOutputs, resolveOutput, reviewsDirForType } from "../../src/util/outputs.js";

// Followup: `config.outputs.*` gives operators a single contact surface
// for relocating any project-tree artifact kind without code changes.
// Defaults preserve the pre-0.6.2 layout (all subdirs under projectRoot).

// Absolute path resolved through `path.resolve` so the layout assertions
// below evaluate against whatever the platform considers absolute (POSIX
// keeps `/abs/my-project`; Windows turns it into `<drive>:\abs\my-project`).
const ROOT = resolvePath("/abs/my-project");
const SHARED_ADRS = resolvePath("/shared/adrs");
const TMP_OVER_THERE = resolvePath("/tmp/over-there");

function config(overrides: Record<string, unknown> = {}) {
  return ConfigSchema.parse({
    version: 1,
    workspace: {
      allowed_roots: [ROOT],
      ideas_dir: `${ROOT}/ideas`,
      specs_dir: `${ROOT}/specs`,
    },
    endpoints: [
      {
        name: "local",
        provider: "openai-compatible",
        base_url: "http://127.0.0.1:11434/v1",
        trust_level: "local",
      },
    ],
    kb: { root: `${ROOT}/kb` },
    ...overrides,
  });
}

describe("resolveOutputs", () => {
  it("applies the default layout when outputs is omitted", () => {
    const out = resolveOutputs(ROOT, config());
    expect(out.plansDir).toBe(join(ROOT, "plans"));
    expect(out.decisionsDir).toBe(join(ROOT, "plans", "decisions"));
    expect(out.reviewsDir).toBe(join(ROOT, "plans", "reviews"));
    expect(out.responseLogPath).toBe(join(ROOT, "plans", "reviews", "response-log.md"));
    expect(out.lifecycleReportDir).toBe(join(ROOT, "plans"));
    expect(out.memoryDir).toBe(join(ROOT, "memory", "daily-logs"));
    expect(out.docsDir).toBe(join(ROOT, "docs"));
    expect(out.skillsDir).toBe(join(ROOT, "skills"));
    expect(out.backupsDir).toBe(join(ROOT, "backups"));
  });

  it("honors per-kind overrides", () => {
    const out = resolveOutputs(
      ROOT,
      config({
        outputs: {
          reviews_dir: "reviews", // relative
          decisions_dir: SHARED_ADRS, // absolute — escapes projectRoot
          lifecycle_report_dir: "reports",
        },
      }),
    );
    expect(out.reviewsDir).toBe(join(ROOT, "reviews"));
    expect(out.decisionsDir).toBe(SHARED_ADRS);
    expect(out.lifecycleReportDir).toBe(join(ROOT, "reports"));
    // Unspecified keys still use defaults.
    expect(out.plansDir).toBe(join(ROOT, "plans"));
    expect(out.responseLogPath).toBe(join(ROOT, "plans", "reviews", "response-log.md"));
  });

  it("reviewsDirForType composes with resolveOutputs", () => {
    const out = resolveOutputs(ROOT, config());
    expect(reviewsDirForType(out, "code")).toBe(join(ROOT, "plans", "reviews", "code"));
    expect(reviewsDirForType(out, "security")).toBe(join(ROOT, "plans", "reviews", "security"));
  });

  it("resolveOutput: relative joins, absolute passes through", () => {
    expect(resolveOutput(ROOT, "plans")).toBe(join(ROOT, "plans"));
    expect(resolveOutput(ROOT, "nested/dir")).toBe(join(ROOT, "nested", "dir"));
    expect(resolveOutput(ROOT, TMP_OVER_THERE)).toBe(TMP_OVER_THERE);
  });
});
