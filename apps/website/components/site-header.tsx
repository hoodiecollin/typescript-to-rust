"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { site, headerNav } from "@/lib/site";
import { TtrMark, TtrWordmark, GitHubIcon } from "@/components/icons";
import { ThemeToggle } from "@/components/theme-toggle";
import { SearchTrigger } from "@/components/docs/search";
import { MobileNav } from "@/components/mobile-nav";
import { Button } from "@/components/ui/button";

export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-screen-2xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2">
          <TtrMark className="h-6 w-auto" />
          <TtrWordmark className="hidden text-[15px] sm:inline" />
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {headerNav.map((item) => {
            const active =
              item.href !== "/" &&
              pathname.startsWith(item.href.replace(/\/$/, ""));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
                  active && "text-foreground",
                )}
              >
                {item.title}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-1.5">
          <div className="hidden sm:block">
            <SearchTrigger />
          </div>
          <Button variant="ghost" size="icon" asChild aria-label="GitHub">
            <a href={site.github} target="_blank" rel="noreferrer noopener">
              <GitHubIcon className="size-4.5" />
            </a>
          </Button>
          <ThemeToggle />
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
