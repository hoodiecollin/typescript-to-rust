"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useAtom } from "jotai";
import { Search } from "lucide-react";
import { searchOpenAtom } from "@/lib/atoms";
import type { SearchDoc } from "@/lib/search";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

/** Small header button that opens the palette; shows the ⌘K hint. */
export function SearchTrigger() {
  const [, setOpen] = useAtom(searchOpenAtom);
  return (
    <button
      onClick={() => setOpen(true)}
      className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted"
    >
      <Search className="size-3.5" />
      <span className="hidden lg:inline">Search docs…</span>
      <kbd className="pointer-events-none hidden select-none items-center gap-0.5 rounded border border-border bg-background px-1.5 font-mono text-[10px] font-medium lg:inline-flex">
        ⌘K
      </kbd>
    </button>
  );
}

/** The ⌘K command palette. Mounted once in the root layout. */
export function CommandMenu() {
  const [open, setOpen] = useAtom(searchOpenAtom);
  const [docs, setDocs] = React.useState<SearchDoc[]>([]);
  const router = useRouter();

  // Global ⌘K / Ctrl-K shortcut.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setOpen]);

  // Lazy-load the static index the first time the palette opens.
  React.useEffect(() => {
    if (open && docs.length === 0) {
      fetch("/search-index.json")
        .then((r) => (r.ok ? r.json() : []))
        .then((d: SearchDoc[]) => setDocs(d))
        .catch(() => setDocs([]));
    }
  }, [open, docs.length]);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  // Group entries by their nav group for a tidy palette.
  const groups = React.useMemo(() => {
    const m = new Map<string, SearchDoc[]>();
    for (const d of docs) {
      const arr = m.get(d.group) ?? [];
      arr.push(d);
      m.set(d.group, arr);
    }
    return [...m.entries()];
  }, [docs]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Search documentation"
      description="Find pages across the typescript-to-rust docs"
      className="max-w-xl"
    >
      {/* This shadcn variant's CommandDialog is only the Dialog shell — it does
          not provide the cmdk <Command> store, so we wrap the content here. */}
      <Command shouldFilter>
        <CommandInput placeholder="Search the docs…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          {groups.map(([group, items]) => (
            <CommandGroup key={group} heading={group}>
              {items.map((d) => (
                <CommandItem
                  key={d.href}
                  value={`${d.title} ${d.group} ${d.headings.join(" ")} ${d.excerpt}`}
                  onSelect={() => go(d.href)}
                >
                  <div className="flex flex-col">
                    <span>{d.title}</span>
                    {d.description ? (
                      <span className="line-clamp-1 text-xs text-muted-foreground">
                        {d.description}
                      </span>
                    ) : null}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
