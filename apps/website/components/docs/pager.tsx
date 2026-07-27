import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { NavItem } from "@/lib/docs-nav";

export function DocsPager({ prev, next }: { prev?: NavItem; next?: NavItem }) {
  if (!prev && !next) return null;
  return (
    <nav className="mt-12 flex items-center justify-between gap-4 border-t border-border/50 pt-6">
      {prev ? (
        <Link
          href={prev.href}
          className="group flex flex-col gap-1 rounded-lg border border-border/60 px-4 py-3 transition-colors hover:border-primary/50 hover:bg-accent/50"
        >
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <ArrowLeft className="size-3.5" /> Previous
          </span>
          <span className="text-sm font-medium">{prev.title}</span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link
          href={next.href}
          className="group flex flex-col items-end gap-1 rounded-lg border border-border/60 px-4 py-3 text-right transition-colors hover:border-primary/50 hover:bg-accent/50"
        >
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            Next <ArrowRight className="size-3.5" />
          </span>
          <span className="text-sm font-medium">{next.title}</span>
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
