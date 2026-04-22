// Stress cases for spec_template + spec_save.
//
// Fewer cases than idea_capture (~40) because each spec is much larger and
// the goal here is coverage of the frontmatter contract and the light-weight
// extractor in spec_save (which is hand-rolled YAML, not a full parser).

import { randomBytes } from "node:crypto";

function bigString(n, charset = "abcdefghijklmnopqrstuvwxyz ") {
  let out = "";
  while (out.length < n) out += charset;
  return out.slice(0, n);
}

// A valid spec body (>= 64 chars) with proper frontmatter.
function validSpec({
  title = "Example project",
  status = "draft",
  created = "2026-04-21",
  tech_stack = ["typescript", "node"],
  tags = [],
  lens = [],
  extraFrontmatter = "",
  body = "## Overview\n\nReal spec body with enough characters to pass the min-64 guard.",
} = {}) {
  const fm = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `status: ${status}`,
    `created: ${created}`,
    `tech_stack: [${tech_stack.map((t) => JSON.stringify(t)).join(", ")}]`,
    ...(tags.length ? [`tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`] : []),
    ...(lens.length ? [`lens: [${lens.map((l) => JSON.stringify(l)).join(", ")}]`] : []),
    ...(extraFrontmatter ? [extraFrontmatter] : []),
    "---",
  ].join("\n");
  return `${fm}\n\n${body}\n`;
}

export const templateCases = [];
let tId = 1;
const addT = (c) => templateCases.push({ id: tId++, tool: "spec_template", ...c });

// ---- spec_template: valid-normal ------------------------------------------
addT({
  category: "valid-normal",
  args: { project_name: "Idea Tracker", expand: true },
  expect: "ok",
});
addT({
  category: "valid-normal",
  args: { project_name: "Spec Hardening", expand: true },
  expect: "ok",
});
addT({
  category: "valid-normal",
  args: { project_name: "2026 Plan", expand: false },
  expect: "ok",
  notes: "expand=false",
});
addT({
  category: "valid-normal",
  args: { project_name: "a" },
  expect: "ok",
  notes: "min-length name",
});
addT({
  category: "valid-edge",
  args: { project_name: bigString(128) },
  expect: "ok",
  notes: "project_name at 128-char max",
});
addT({
  category: "unicode",
  args: { project_name: "日本語プロジェクト" },
  expect: "ok",
  notes: "Japanese name",
});
addT({
  category: "unicode",
  args: { project_name: "مشروع 💡" },
  expect: "ok",
  notes: "Arabic + emoji",
});

// spec_template with idea_ref — ok case requires an idea to exist. The harness
// captures an idea first (see run.mjs) with slug "harness-seed-idea" so this
// case can resolve. Missing idea_ref should surface E_NOT_FOUND.
addT({
  category: "valid-normal",
  args: { project_name: "Seeded Spec", idea_ref: "harness-seed-idea", expand: true },
  expect: "ok",
  notes: "seeded from an idea",
});
addT({
  category: "invalid-lookup",
  args: { project_name: "Ghost Idea", idea_ref: "this-slug-does-not-exist" },
  expect: "error",
  notes: "nonexistent idea_ref → E_NOT_FOUND",
});

// ---- spec_template: invalid-schema ----------------------------------------
addT({
  category: "invalid-schema",
  args: { project_name: "" },
  expect: "error",
  notes: "empty project_name",
});
addT({
  category: "invalid-schema",
  args: { project_name: bigString(129) },
  expect: "error",
  notes: "project_name 129 > max 128",
});
addT({
  category: "invalid-schema",
  args: { project_name: 42 },
  expect: "error",
  notes: "project_name is a number",
});
addT({
  category: "invalid-schema",
  args: {},
  expect: "error",
  notes: "missing project_name",
});

// ---- spec_save ------------------------------------------------------------

export const saveCases = [];
let sId = 1000;
const addS = (c) => saveCases.push({ id: sId++, tool: "spec_save", ...c });

// Valid, normal.
addS({
  category: "valid-normal",
  args: {
    content: validSpec(),
    expand: true,
  },
  expect: "ok",
});

addS({
  category: "valid-normal",
  args: {
    content: validSpec({
      title: "Another Spec",
      tech_stack: ["rust", "postgres"],
      tags: ["backend"],
      lens: ["security", "performance"],
      body: bigString(5_000),
    }),
    expand: false,
  },
  expect: "ok",
  notes: "medium body with tags + lenses",
});

addS({
  category: "valid-normal",
  args: {
    content: validSpec({ title: "Explicit slug override", body: bigString(200) }),
    slug: "custom-slug-override",
  },
  expect: "ok",
  notes: "explicit slug override",
});

// Valid edge: content at exact max (200_000).
addS({
  category: "valid-edge",
  args: {
    content: (() => {
      const fm = [
        "---",
        "title: Massive",
        "status: draft",
        "created: 2026-04-21",
        "tech_stack: [typescript]",
        "---",
        "",
      ].join("\n");
      return fm + bigString(200_000 - fm.length - 1) + "\n";
    })(),
  },
  expect: "ok",
  notes: "content at exact 200000-char max",
});

// Valid edge: min content (64 chars) — still must have frontmatter.
addS({
  category: "valid-edge",
  args: {
    content: "---\ntitle: Min\nstatus: draft\ncreated: 2026-04-21\ntech_stack: []\n---\nx",
  },
  expect: "ok",
  notes: "near-min content with valid frontmatter",
});

// Valid edge: status=accepted, status=archived.
addS({
  category: "valid-edge",
  args: { content: validSpec({ title: "Accepted Spec", status: "accepted" }) },
  expect: "ok",
  notes: "status=accepted",
});
addS({
  category: "valid-edge",
  args: { content: validSpec({ title: "Archived Spec", status: "archived" }) },
  expect: "ok",
  notes: "status=archived",
});

// Valid edge: extra frontmatter fields (passthrough should allow).
addS({
  category: "valid-edge",
  args: {
    content: validSpec({
      title: "Extra FM",
      extraFrontmatter: [
        "author_agent: claude-opus-4-7",
        "domain: internal-tools",
        "custom_field: whatever",
      ].join("\n"),
    }),
  },
  expect: "ok",
  notes: "extra frontmatter fields (passthrough)",
});

// Valid edge: body containing YAML frontmatter LOOKALIKE inside a fenced block.
addS({
  category: "valid-edge",
  args: {
    content: validSpec({
      title: "Fenced YAML Inside",
      body: [
        "# Overview",
        "",
        "Here's an example frontmatter from elsewhere:",
        "",
        "```yaml",
        "---",
        "title: Embedded",
        "status: draft",
        "---",
        "```",
        "",
        "That should not confuse the parser.",
      ].join("\n"),
    }),
  },
  expect: "ok",
  notes: "fenced YAML inside body",
});

// Valid edge: same-date collision with force=true (2nd write wins).
addS({
  category: "valid-edge",
  args: {
    content: validSpec({ title: "Collision Target" }),
    force: true,
  },
  expect: "ok",
  notes: "first write of collision target",
});
addS({
  category: "valid-edge",
  args: {
    content: validSpec({
      title: "Collision Target",
      body: "Second write overwrites." + bigString(200),
    }),
    force: true,
  },
  expect: "ok",
  notes: "second write with force=true overwrites",
});

// ---- spec_save: invalid-schema / invalid-frontmatter ---------------------

// No frontmatter at all.
addS({
  category: "invalid-frontmatter",
  args: { content: bigString(200, "a ") },
  expect: "error",
  notes: "no frontmatter marker",
});

// Frontmatter without closing ---.
addS({
  category: "invalid-frontmatter",
  args: {
    content:
      "---\ntitle: No Close\nstatus: draft\ncreated: 2026-04-21\ntech_stack: []\n\nbody text here more more more more",
  },
  expect: "error",
  notes: "unclosed frontmatter",
});

// Missing required field: title.
addS({
  category: "invalid-frontmatter",
  args: {
    content: "---\nstatus: draft\ncreated: 2026-04-21\ntech_stack: []\n---\n" + bigString(80),
  },
  expect: "error",
  notes: "missing title",
});

// Missing required field: created.
addS({
  category: "invalid-frontmatter",
  args: {
    content: "---\ntitle: No Date\nstatus: draft\ntech_stack: []\n---\n" + bigString(80),
  },
  expect: "error",
  notes: "missing created",
});

// Invalid status enum.
addS({
  category: "invalid-frontmatter",
  args: {
    content: validSpec({ status: "in-progress" }),
  },
  expect: "error",
  notes: "status=in-progress (not in enum)",
});

// created not ISO-shaped.
addS({
  category: "invalid-frontmatter",
  args: {
    content: validSpec({ created: "4/21/2026" }),
  },
  expect: "error",
  notes: "created is US-format",
});

// tech_stack with uppercase tag.
addS({
  category: "invalid-frontmatter",
  args: {
    content: validSpec({ tech_stack: ["TypeScript"] }),
  },
  expect: "error",
  notes: "tech_stack with uppercase",
});

// content too short (< 64 chars).
addS({
  category: "invalid-schema",
  args: { content: "---\ntitle: Tiny\n---\nx" },
  expect: "error",
  notes: "content < 64 chars",
});

// slug with invalid shape.
addS({
  category: "invalid-schema",
  args: { content: validSpec(), slug: "Bad Slug With Spaces" },
  expect: "error",
  notes: "slug fails regex",
});

// content too long (> 200000).
addS({
  category: "invalid-schema",
  args: { content: validSpec({ body: bigString(200_001) }) },
  expect: "error",
  notes: "content > 200000",
});

// ---- spec_save: adversarial ----------------------------------------------

// Body that tries to inject a SECOND frontmatter block mid-body.
addS({
  category: "adversarial",
  args: {
    content: validSpec({
      title: "Mid-body FM Injection",
      body: [
        "Normal content.",
        "",
        "---",
        "title: Injected",
        "status: accepted",
        "---",
        "",
        "More content after the attempted injection.",
      ].join("\n"),
    }),
  },
  expect: "ok",
  notes: "body contains a second --- block (should NOT be treated as FM)",
});

// Body contains `\n---` that could confuse the lightweight extractor.
addS({
  category: "adversarial",
  args: {
    content: validSpec({
      title: "Horizontal Rule In Body", // unique title so filename doesn't collide
      body:
        "First paragraph.\n\n---\n\nSecond paragraph after a horizontal rule." +
        "\n\nMore body content to pad out length " +
        bigString(200),
    }),
  },
  expect: "ok",
  notes: "body has horizontal rules made of ---",
});

// Unicode body.
addS({
  category: "unicode",
  args: {
    content: validSpec({
      title: "多言語仕様",
      body: "概要: これはテストの仕様書です。\n\n" + "詳細: " + bigString(200),
    }),
  },
  expect: "ok",
  notes: "Japanese title + body",
});

// Emoji-heavy body.
addS({
  category: "unicode",
  args: {
    content: validSpec({
      title: "emoji heavy",
      body: "🚀 Goals: ship it. 🎯\n\n💡 Ideas:\n- " + "🎨 ".repeat(40),
    }),
  },
  expect: "ok",
  notes: "emoji in body",
});

// ---- combined export -----------------------------------------------------
export default [...templateCases, ...saveCases];
