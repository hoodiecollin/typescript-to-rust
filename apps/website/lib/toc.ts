import GithubSlugger from "github-slugger";

export interface TocEntry {
  depth: 2 | 3;
  text: string;
  id: string;
}

/**
 * Extract the h2/h3 table of contents from raw MDX, using the same slugger
 * (github-slugger) rehype-slug uses so the anchors match the rendered ids.
 * Fenced code blocks are skipped so `## comment` lines inside code never leak in.
 */
export function extractToc(content: string): TocEntry[] {
  const slugger = new GithubSlugger();
  const entries: TocEntry[] = [];
  let inFence = false;

  for (const line of content.split("\n")) {
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = line.match(/^(#{2,3})\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const depth = m[1]!.length as 2 | 3;
    // Strip inline markdown (code ticks, emphasis, links) for the display text.
    const text = m[2]!
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .trim();
    if (!text) continue;
    entries.push({ depth, text, id: slugger.slug(text) });
  }
  return entries;
}
