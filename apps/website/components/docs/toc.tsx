"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { TocEntry } from "@/lib/toc";

export function Toc({ entries }: { entries: TocEntry[] }) {
  const [active, setActive] = React.useState<string>("");

  React.useEffect(() => {
    if (entries.length === 0) return;
    const observer = new IntersectionObserver(
      (items) => {
        for (const it of items) {
          if (it.isIntersecting) {
            setActive(it.target.id);
          }
        }
      },
      { rootMargin: "0% 0% -70% 0%", threshold: 1 },
    );
    for (const e of entries) {
      const el = document.getElementById(e.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [entries]);

  if (entries.length === 0) return null;

  return (
    <div className="sticky top-14 hidden max-h-[calc(100dvh-3.5rem)] w-56 shrink-0 overflow-y-auto py-8 xl:block">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        On this page
      </p>
      <ul className="space-y-2 border-l border-border/50 text-sm">
        {entries.map((e) => (
          <li key={e.id} className={cn(e.depth === 3 && "ml-3")}>
            <a
              href={`#${e.id}`}
              className={cn(
                "-ml-px block border-l-2 border-transparent pl-3 text-muted-foreground transition-colors hover:text-foreground",
                active === e.id && "border-primary font-medium text-foreground",
              )}
            >
              {e.text}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
