// Slug helpers used by idea_capture, spec_save, project_init, etc.
//
// A slug is lowercase alphanumeric + hyphens, starting with a letter/digit,
// max 64 chars. Matches the pattern used in frontmatter and DB indexes so
// callers never have to normalize twice.

export function slugify(input: string, maxLen = 64): string {
  const base = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);
  if (base.length === 0) return "untitled";
  return base;
}

export function isoDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
