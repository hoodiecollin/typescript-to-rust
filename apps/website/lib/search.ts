/** One entry per docs page in the prebuilt static search index. */
export interface SearchDoc {
  title: string;
  href: string;
  group: string;
  description: string;
  /** Section headings (h2/h3) for sub-page matching. */
  headings: string[];
  /** A short plain-text excerpt of the body for fuzzy matching. */
  excerpt: string;
}
