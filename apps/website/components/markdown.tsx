import { Fragment, type ElementType, type ReactNode } from "react";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import type { MDXComponents } from "mdx/types";
import { cn } from "@/lib/utils";

/**
 * Inline highlight — the landing page's primary-colored emphasis. Content writes
 * `<Hl>ownership</Hl>` in MDX instead of a hand-authored `<span>` in the layout,
 * so purely-visual emphasis lives in the content module with the rest of the copy.
 */
function Hl({ children }: { children?: ReactNode }) {
  return <span className="text-primary">{children}</span>;
}

/**
 * Component set for marketing copy: inline-safe elements plus the custom `<Hl>`.
 * Bare `<code>` is intentionally left unstyled here — the global
 * `code:not(pre code)` rule in globals.css gives it the canonical inline chip.
 */
const contentComponents: MDXComponents = {
  Hl,
  a: ({ className, ...props }) => (
    <a
      className={cn("text-primary underline-offset-4 hover:underline", className)}
      {...props}
    />
  ),
};

/**
 * Inline variant: drop the block `<p>` wrapper so the copy flows directly inside
 * the host element (a heading, button, badge, or styled paragraph).
 */
const inlineComponents: MDXComponents = {
  ...contentComponents,
  p: ({ children }) => <Fragment>{children}</Fragment>,
};

/**
 * Renders a markdown/MDX content string with the marketing component set. Copy
 * lives in the content modules (see `content/landing.ts`); the layout feeds each
 * string here so styling stays in the content (markdown + `<Hl>`) rather than in
 * hand-authored spans.
 */
export function Markdown({
  source,
  inline = false,
  as,
  className,
}: {
  source: string;
  inline?: boolean;
  as?: ElementType;
  className?: string;
}) {
  const Wrapper = as ?? (inline ? "span" : "div");
  return (
    <Wrapper className={className}>
      <MDXRemote
        source={source}
        components={inline ? inlineComponents : contentComponents}
        options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
      />
    </Wrapper>
  );
}
