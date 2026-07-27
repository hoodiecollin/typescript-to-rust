/**
 * Build the static ⌘K search index (public/search-index.json) from the MDX
 * content tree, and validate the docs nav <-> content wiring:
 *   - every docsNav href must have a matching MDX file (no dead sidebar links)
 *   - every MDX file should appear in the nav (warn on orphans)
 * Runs as the `prebuild` step so `next build` always ships a fresh index.
 */
import fs from "node:fs";
import path from "node:path";
import { getAllDocs } from "../lib/mdx";
import { flatDocs, docMeta } from "../lib/docs-nav";
import { extractToc } from "../lib/toc";
import type { SearchDoc } from "../lib/search";

function toPlainText(mdx: string): string {
  return mdx
    .replace(/```[\s\S]*?```/g, " ") // code fences
    .replace(/`[^`]+`/g, " ") // inline code
    .replace(/<[^>]+>/g, " ") // jsx/html tags
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images
    .replace(/[#>*_~|-]/g, " ") // markdown punctuation
    .replace(/\s+/g, " ")
    .trim();
}

const docs = getAllDocs();
const index: SearchDoc[] = docs.map((d) => {
  const meta = docMeta(d.href);
  return {
    title: d.frontmatter.title,
    href: d.href,
    group: meta.group ?? "Docs",
    description: d.frontmatter.description ?? "",
    headings: extractToc(d.content).map((h) => h.text),
    excerpt: toPlainText(d.content).slice(0, 240),
  };
});

// Order the index to match the sidebar for a tidy palette.
const order = new Map(flatDocs.map((i, n) => [i.href, n]));
index.sort((a, b) => (order.get(a.href) ?? 999) - (order.get(b.href) ?? 999));

// --- Validation ---------------------------------------------------------------
const fileHrefs = new Set(docs.map((d) => d.href));
const navHrefs = new Set(flatDocs.map((i) => i.href));

const missing = flatDocs.filter((i) => !fileHrefs.has(i.href));
const orphans = docs.filter((d) => !navHrefs.has(d.href));

if (missing.length) {
  console.error("\n✗ docs nav references pages with no MDX file:");
  for (const m of missing)
    console.error(
      `   ${m.href}  (expected content/docs${m.href.replace(/^\/docs/, "").replace(/\/$/, "") || "/index"}.mdx)`,
    );
}
if (orphans.length) {
  console.warn("\n⚠ MDX files not in the sidebar nav (add to lib/docs-nav.ts):");
  for (const o of orphans) console.warn(`   ${o.href}`);
}

const outDir = path.join(process.cwd(), "public");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "search-index.json"), JSON.stringify(index));
console.log(`\n✓ search-index.json — ${index.length} pages indexed`);

// A missing page is a hard failure (would 404 in the sidebar); orphans only warn.
if (missing.length) {
  console.error(`\n✗ ${missing.length} dead nav link(s) — see above.`);
  process.exit(1);
}
