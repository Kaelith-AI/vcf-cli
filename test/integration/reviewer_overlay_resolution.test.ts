import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  modelFamily,
  familyTrustLevel,
  resolveOverlay,
  readOverlayBundle,
  trustLevelToken,
} from "../../src/review/overlays.js";

describe("reviewer overlay resolution", () => {
  let kbRoot: string;

  beforeEach(async () => {
    kbRoot = await realpath(await mkdtemp(join(tmpdir(), "vcf-overlay-")));
    await mkdir(join(kbRoot, "reviewers"), { recursive: true });
    await writeFile(
      join(kbRoot, "reviewers", "reviewer-code.md"),
      "# Base code reviewer\nBody.",
    );
    await writeFile(
      join(kbRoot, "reviewers", "reviewer-code.frontier.md"),
      "# Frontier overlay\nFrontier calibration.",
    );
    await writeFile(
      join(kbRoot, "reviewers", "reviewer-code.local.md"),
      "# Local overlay\nLocal calibration.",
    );
    await writeFile(
      join(kbRoot, "reviewers", "reviewer-security.md"),
      "# Base security\nBody.",
    );
  });

  afterEach(async () => {
    await rm(kbRoot, { recursive: true, force: true });
  });

  describe("modelFamily()", () => {
    it("extracts family from provider-prefixed ids", () => {
      expect(modelFamily("CLIProxyAPI/gpt-5.4")).toBe("gpt");
      expect(modelFamily("openai/gpt-4o-mini")).toBe("gpt");
    });

    it("normalizes qwen2 / qwen3 to qwen", () => {
      expect(modelFamily("qwen3-coder:30b")).toBe("qwen");
      expect(modelFamily("qwen2.5-coder:32b")).toBe("qwen");
    });

    it("normalizes gemma3 / gemma4 to gemma", () => {
      expect(modelFamily("gemma4:31b")).toBe("gemma");
      expect(modelFamily("gemma3:27b")).toBe("gemma");
    });

    it("returns null on empty input", () => {
      expect(modelFamily("")).toBeNull();
    });

    it("handles single-word ids", () => {
      expect(modelFamily("claude-opus-4-7")).toBe("claude");
      expect(modelFamily("deepseek-r1:70b")).toBe("deepseek");
    });
  });

  describe("familyTrustLevel()", () => {
    it("maps known frontier families to public", () => {
      expect(familyTrustLevel("gpt")).toBe("public");
      expect(familyTrustLevel("claude")).toBe("public");
      expect(familyTrustLevel("gemini")).toBe("public");
    });

    it("maps known local families to local", () => {
      expect(familyTrustLevel("qwen")).toBe("local");
      expect(familyTrustLevel("gemma")).toBe("local");
      expect(familyTrustLevel("deepseek")).toBe("local");
    });

    it("returns null for unknown families", () => {
      expect(familyTrustLevel("brand-new-model")).toBeNull();
    });
  });

  describe("trustLevelToken()", () => {
    it("maps public and trusted to frontier", () => {
      expect(trustLevelToken("public")).toBe("frontier");
      expect(trustLevelToken("trusted")).toBe("frontier");
    });
    it("maps local to local", () => {
      expect(trustLevelToken("local")).toBe("local");
    });
  });

  describe("resolveOverlay()", () => {
    it("picks the family overlay when one exists", async () => {
      // Drop a family-specific overlay into place.
      await writeFile(
        join(kbRoot, "reviewers", "reviewer-code.qwen.md"),
        "# Qwen-specific overlay\nBody.",
      );
      const r = resolveOverlay({
        kbRoot,
        reviewType: "code",
        modelId: "qwen3-coder:30b",
        trustLevel: "local",
      });
      expect(r.overlayMatch).toBe("family");
      expect(r.overlayRelPath).toBe(join(kbRoot, "reviewers", "reviewer-code.qwen.md"));
      expect(r.family).toBe("qwen");
    });

    it("falls back to trust-level overlay when no family overlay", () => {
      const r = resolveOverlay({
        kbRoot,
        reviewType: "code",
        modelId: "qwen3-coder:30b",
        trustLevel: "local",
      });
      expect(r.overlayMatch).toBe("trust-level");
      expect(r.overlayRelPath).toBe(join(kbRoot, "reviewers", "reviewer-code.local.md"));
    });

    it("falls back to frontier overlay for public endpoints", () => {
      const r = resolveOverlay({
        kbRoot,
        reviewType: "code",
        modelId: "gpt-5.4",
        trustLevel: "public",
      });
      expect(r.overlayMatch).toBe("trust-level");
      expect(r.overlayRelPath).toBe(join(kbRoot, "reviewers", "reviewer-code.frontier.md"));
    });

    it("returns none when neither family nor trust-level overlay exists", () => {
      // reviewer-security has no .frontier / .local overlays in this fixture.
      const r = resolveOverlay({
        kbRoot,
        reviewType: "security",
        modelId: "gpt-5.4",
        trustLevel: "public",
      });
      expect(r.overlayMatch).toBe("none");
      expect(r.overlayRelPath).toBeNull();
    });

    it("picks family over trust-level when both exist", async () => {
      // Both overlays exist: family must win.
      await writeFile(
        join(kbRoot, "reviewers", "reviewer-code.gemma.md"),
        "# Gemma family overlay",
      );
      const r = resolveOverlay({
        kbRoot,
        reviewType: "code",
        modelId: "gemma4:31b",
        trustLevel: "local",
      });
      expect(r.overlayMatch).toBe("family");
      expect(r.overlayRelPath).toBe(join(kbRoot, "reviewers", "reviewer-code.gemma.md"));
    });
  });

  describe("readOverlayBundle()", () => {
    it("returns base + overlay bodies", async () => {
      const b = await readOverlayBundle({
        kbRoot,
        reviewType: "code",
        modelId: "gpt-5.4",
        trustLevel: "public",
      });
      expect(b.base).toContain("Base code reviewer");
      expect(b.overlay).toContain("Frontier overlay");
      expect(b.overlayMatch).toBe("trust-level");
      expect(b.family).toBe("gpt");
    });

    it("returns null overlay when none matches", async () => {
      const b = await readOverlayBundle({
        kbRoot,
        reviewType: "security",
        modelId: "gpt-5.4",
        trustLevel: "public",
      });
      expect(b.base).toContain("Base security");
      expect(b.overlay).toBeNull();
      expect(b.overlayMatch).toBe("none");
    });
  });
});
