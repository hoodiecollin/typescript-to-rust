/**
 * The docs navigation tree — the single source of truth for the sidebar,
 * prev/next paging, and the search index. Each `href` must have a matching MDX
 * file at `content/docs/<slug>.mdx` (the `scripts/build-search-index.ts` link
 * check enforces this at build time). Order here is the order shown in the
 * sidebar.
 */

export interface NavItem {
  title: string;
  href: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const docsNav: NavGroup[] = [
  {
    title: "Introduction",
    items: [{ title: "Overview", href: "/docs/" }],
  },
  {
    title: "Getting started",
    items: [
      { title: "Installation", href: "/docs/getting-started/installation/" },
      { title: "Quickstart", href: "/docs/getting-started/quickstart/" },
    ],
  },
  {
    title: "The dialect",
    items: [
      { title: "Overview", href: "/docs/dialect/overview/" },
    ],
  },
  {
    title: "CLI",
    items: [{ title: "Reference", href: "/docs/cli/reference/" }],
  },
  {
    title: "How it works",
    items: [
      { title: "Architecture", href: "/docs/how-it-works/architecture/" },
    ],
  },
];

/** Flat, ordered list of every docs page — drives search + prev/next. */
export const flatDocs: NavItem[] = docsNav.flatMap((g) => g.items);

/** Map an href to its {group, title, prev, next} for page chrome. */
export function docMeta(href: string) {
  const normalized = href.endsWith("/") ? href : `${href}/`;
  const idx = flatDocs.findIndex((i) => i.href === normalized);
  const group = docsNav.find((g) => g.items.some((i) => i.href === normalized));
  return {
    group: group?.title,
    item: idx >= 0 ? flatDocs[idx] : undefined,
    prev: idx > 0 ? flatDocs[idx - 1] : undefined,
    next: idx >= 0 && idx < flatDocs.length - 1 ? flatDocs[idx + 1] : undefined,
  };
}
