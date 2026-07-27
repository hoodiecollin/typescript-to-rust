import { createHighlighter } from "shiki";
import type { Options as PrettyCodeOptions } from "rehype-pretty-code";

/**
 * The languages the docs' fenced code blocks use. ttr showcases the TypeScript
 * input and the Rust output side by side, plus shell/config for the CLI pages.
 */
const BUILTIN_LANGS = [
  "bash",
  "rust",
  "typescript",
  "tsx",
  "javascript",
  "json",
  "toml",
  "yaml",
  "diff",
  "text",
] as const;

/** rehype-pretty-code options wired with dual light/dark themes. */
export const rehypePrettyCodeOptions: PrettyCodeOptions = {
  theme: { light: "github-light", dark: "github-dark" },
  keepBackground: false,
  defaultLang: { block: "text", inline: "text" },
  // Reuse one highlighter instance across the whole build.
  getHighlighter: (options) =>
    createHighlighter({
      ...options,
      langs: [...BUILTIN_LANGS],
    }),
};
