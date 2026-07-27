import Link from "next/link";
import {
  type LucideIcon,
  ArrowRight,
  ShieldCheck,
  Boxes,
  Gauge,
  Binary,
  TerminalSquare,
  GitCompareArrows,
  Zap,
} from "lucide-react";
import { site } from "@/lib/site";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CodeBlock } from "@/components/code-block";
import { CopyCommand } from "@/components/marketing/copy-command";
import { GitHubIcon, TtrMark } from "@/components/icons";
import { Markdown } from "@/components/markdown";
import { landing, type IconKey } from "@/content/landing";

/** Resolves a content `IconKey` to its lucide icon; the copy lives in the content module. */
const ICONS: Record<IconKey, LucideIcon> = {
  ShieldCheck,
  Boxes,
  Gauge,
  Binary,
  TerminalSquare,
  GitCompareArrows,
};

export default function Home() {
  return (
    <main>
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-border/50">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_50%_-10%,color-mix(in_oklch,var(--primary)_22%,transparent),transparent)]"
        />
        <div className="mx-auto max-w-screen-xl px-4 py-20 text-center sm:px-6 sm:py-28">
          <TtrMark className="mx-auto mb-6 h-14 w-auto" />
          <Badge variant="secondary" className="mb-5 gap-1.5 rounded-full px-3 py-1">
            <Zap className="size-3.5 text-primary" />
            <Markdown inline source={landing.hero.badge} />
          </Badge>
          <Markdown
            as="h1"
            inline
            className="mx-auto max-w-4xl text-balance text-4xl font-bold tracking-tight sm:text-6xl"
            source={landing.hero.heading}
          />
          <Markdown
            as="p"
            inline
            className="mx-auto mt-6 max-w-2xl text-balance text-lg text-muted-foreground sm:text-xl"
            source={landing.hero.subhead}
          />
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/docs/getting-started/quickstart/">
                <Markdown inline source={landing.hero.ctaPrimary} />
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <a href={site.github} target="_blank" rel="noreferrer noopener">
                <GitHubIcon className="size-4" />
                <Markdown inline source={landing.hero.ctaGithub} />
              </a>
            </Button>
          </div>
          <div className="mt-6 flex justify-center">
            <CopyCommand command={landing.hero.install} />
          </div>
        </div>
      </section>

      {/* Code showcase */}
      <section className="mx-auto max-w-screen-xl px-4 py-16 sm:px-6">
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <Markdown
            as="h2"
            inline
            className="text-3xl font-semibold tracking-tight"
            source={landing.showcase.heading}
          />
          <Markdown
            as="p"
            inline
            className="mt-3 text-muted-foreground"
            source={landing.showcase.body}
          />
        </div>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <CodeBlock code={landing.showcase.tsInput} lang="typescript" filename="app.ts" />
          <CodeBlock code={landing.showcase.rustOutput} lang="rust" filename="app.rs" />
        </div>
      </section>

      {/* Invariant band */}
      <section className="border-y border-border/50 bg-muted/20">
        <div className="mx-auto max-w-screen-lg px-4 py-14 text-center sm:px-6">
          <Markdown
            as="p"
            inline
            className="text-lg font-medium sm:text-2xl"
            source={landing.invariant.lead}
          />
          <Markdown
            as="p"
            inline
            className="mx-auto mt-4 max-w-2xl text-muted-foreground"
            source={landing.invariant.body}
          />
        </div>
      </section>

      {/* Feature grid */}
      <section className="mx-auto max-w-screen-xl px-4 py-16 sm:px-6">
        <div className="mb-10 max-w-2xl">
          <Markdown
            as="h2"
            inline
            className="text-3xl font-semibold tracking-tight"
            source={landing.features.heading}
          />
          <Markdown
            as="p"
            inline
            className="mt-3 text-muted-foreground"
            source={landing.features.body}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {landing.features.items.map((f) => {
            const Icon = ICONS[f.icon];
            return (
              <Link
                key={f.title}
                href={f.href}
                className="group flex flex-col gap-3 rounded-xl border border-border/60 bg-card/40 p-5 transition-colors hover:border-primary/40 hover:bg-accent/40"
              >
                <Icon className="size-5 text-primary" />
                <Markdown as="h3" inline className="font-semibold" source={f.title} />
                <Markdown as="p" inline className="text-sm text-muted-foreground" source={f.body} />
                <span className="mt-auto inline-flex items-center gap-1 pt-1 text-sm text-primary opacity-0 transition-opacity group-hover:opacity-100">
                  <Markdown inline source={landing.features.learnMore} />
                  <ArrowRight className="size-3.5" />
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Stats / principles */}
      <section className="border-y border-border/50 bg-muted/20">
        <div className="mx-auto max-w-screen-xl px-4 py-16 sm:px-6">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-xl">
              <Markdown
                as="h2"
                inline
                className="text-3xl font-semibold tracking-tight"
                source={landing.stats.heading}
              />
              <Markdown
                as="p"
                inline
                className="mt-3 text-muted-foreground"
                source={landing.stats.body}
              />
            </div>
            <Button asChild variant="outline">
              <Link href="/docs/how-it-works/architecture/">
                <Markdown inline source={landing.stats.cta} />
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {landing.stats.items.map((s, i) => (
              <div key={i} className="rounded-xl border border-border/60 bg-background/40 p-5">
                <Markdown
                  as="div"
                  inline
                  className="text-2xl font-bold tracking-tight text-primary"
                  source={s.value}
                />
                <Markdown
                  as="div"
                  inline
                  className="mt-1.5 text-sm text-muted-foreground"
                  source={s.label}
                />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-screen-xl px-4 py-16 sm:px-6">
        <div className="mb-10 max-w-2xl">
          <Markdown
            as="h2"
            inline
            className="text-3xl font-semibold tracking-tight"
            source={landing.steps.heading}
          />
          <Markdown
            as="p"
            inline
            className="mt-3 text-muted-foreground"
            source={landing.steps.body}
          />
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          {landing.steps.items.map((s) => (
            <div key={s.n} className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm text-primary">{s.n}</span>
                <Markdown as="h3" inline className="text-lg font-semibold" source={s.title} />
              </div>
              <Markdown as="p" inline className="text-sm text-muted-foreground" source={s.body} />
              <CodeBlock code={s.code} lang={s.lang} />
            </div>
          ))}
        </div>
      </section>

      {/* CTA band */}
      <section className="border-t border-border/50">
        <div className="mx-auto max-w-screen-lg px-4 py-20 text-center sm:px-6">
          <Boxes className="mx-auto mb-5 size-8 text-primary" />
          <Markdown
            as="h2"
            inline
            className="text-3xl font-semibold tracking-tight sm:text-4xl"
            source={landing.cta.heading}
          />
          <Markdown
            as="p"
            inline
            className="mx-auto mt-4 max-w-xl text-muted-foreground"
            source={landing.cta.body}
          />
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/docs/getting-started/quickstart/">
                <Markdown inline source={landing.cta.primary} />
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/docs/">
                <Markdown inline source={landing.cta.secondary} />
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
