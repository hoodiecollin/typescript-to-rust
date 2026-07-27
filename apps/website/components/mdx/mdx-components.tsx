import type { MDXComponents } from "mdx/types";
import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Pre } from "@/components/mdx/pre";
import { Callout } from "@/components/mdx/callout";

function anchor(id?: string) {
  return id ? (
    <a
      href={`#${id}`}
      className="ml-2 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100 hover:text-primary"
      aria-label="Link to section"
    >
      #
    </a>
  ) : null;
}

/** Side-by-side comparison used for TS-input → Rust-output showcases. */
function Compare({ children }: { children: ReactNode }) {
  return (
    <div className="my-5 grid gap-4 md:grid-cols-2 [&_pre]:my-0 [&>div>:first-child]:mt-0">
      {children}
    </div>
  );
}

export const mdxComponents: MDXComponents = {
  h1: ({ className, ...props }) => (
    <h1
      className={cn("mt-2 scroll-m-20 text-3xl font-bold tracking-tight", className)}
      {...props}
    />
  ),
  h2: ({ id, children, className, ...props }) => (
    <h2
      id={id}
      className={cn(
        "group mt-10 scroll-m-24 border-b border-border/50 pb-2 text-2xl font-semibold tracking-tight first:mt-0",
        className,
      )}
      {...props}
    >
      {children}
      {anchor(id)}
    </h2>
  ),
  h3: ({ id, children, className, ...props }) => (
    <h3
      id={id}
      className={cn("group mt-8 scroll-m-24 text-xl font-semibold tracking-tight", className)}
      {...props}
    >
      {children}
      {anchor(id)}
    </h3>
  ),
  h4: ({ id, children, className, ...props }) => (
    <h4
      id={id}
      className={cn("group mt-6 scroll-m-24 text-lg font-semibold tracking-tight", className)}
      {...props}
    >
      {children}
      {anchor(id)}
    </h4>
  ),
  p: ({ className, ...props }) => (
    <p className={cn("leading-7 [&:not(:first-child)]:mt-4", className)} {...props} />
  ),
  a: ({ href = "", className, ...props }) => {
    const internal = href.startsWith("/") || href.startsWith("#");
    const cls = cn("font-medium text-primary underline-offset-4 hover:underline", className);
    return internal ? (
      <Link href={href} className={cls} {...props} />
    ) : (
      <a href={href} target="_blank" rel="noreferrer noopener" className={cls} {...props} />
    );
  },
  ul: ({ className, ...props }) => (
    <ul className={cn("my-4 ml-6 list-disc [&>li]:mt-1.5", className)} {...props} />
  ),
  ol: ({ className, ...props }) => (
    <ol className={cn("my-4 ml-6 list-decimal [&>li]:mt-1.5", className)} {...props} />
  ),
  li: ({ className, ...props }) => <li className={cn("leading-7", className)} {...props} />,
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        "my-5 border-l-2 border-primary/50 pl-4 text-muted-foreground italic",
        className,
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr className={cn("my-8 border-border/60", className)} {...props} />
  ),
  table: ({ className, ...props }) => (
    <div className="my-5 w-full overflow-x-auto rounded-lg border border-border/60">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  ),
  thead: ({ className, ...props }) => (
    <thead className={cn("bg-muted/50", className)} {...props} />
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "border-b border-border/60 px-4 py-2.5 text-left font-medium",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        "border-b border-border/40 px-4 py-2.5 align-top [&_code]:whitespace-nowrap [&_code]:text-xs",
        className,
      )}
      {...props}
    />
  ),
  // Inline `<code>` is styled globally (`code:not(pre code)` in globals.css).
  pre: Pre,
  figure: ({ className, ...props }) => <figure className={cn("my-4", className)} {...props} />,
  figcaption: ({ className, ...props }) => (
    <figcaption
      className={cn(
        "flex items-center gap-2 rounded-t-lg border border-b-0 border-border/60 bg-muted/60 px-4 py-2 font-mono text-xs text-muted-foreground [&+div>pre]:mt-0 [&+div>pre]:rounded-t-none",
        className,
      )}
      {...props}
    />
  ),
  Callout,
  Compare,
};
