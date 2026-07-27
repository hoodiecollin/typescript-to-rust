import { createHighlighter, type Highlighter } from "shiki";

let hp: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  hp ??= createHighlighter({
    themes: ["github-light", "github-dark"],
    langs: ["bash", "rust", "typescript", "tsx", "json", "toml"],
  });
  return hp;
}

/**
 * Build-time syntax highlighting for standalone code (the marketing landing).
 * Emits dual-theme markup (`--shiki-light` / `--shiki-dark` vars); the `.dark`
 * class swap in globals.css switches tokens. Runs only in server components at
 * build time (static export).
 */
export async function highlight(code: string, lang: string): Promise<string> {
  const h = await getHighlighter();
  const known = h.getLoadedLanguages().includes(lang) ? lang : "text";
  return h.codeToHtml(code, {
    lang: known,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
}
