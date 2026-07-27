import { dd } from "@/lib/dd";

/**
 * Landing-page copy, extracted from the layout so it can be edited independently
 * of `app/page.tsx`.
 *
 * Prose values are **markdown/MDX** — inline `<code>`, `[links](/href)`, and the
 * custom `<Hl>` primary-highlight — rendered through `components/markdown.tsx`.
 * Code samples are plain source fed to `<CodeBlock>`. Structural tokens (icon
 * keys, hrefs, langs) stay as plain strings; the page maps `IconKey` → lucide.
 */

/** Icon keys the feature grid references; the page maps these to lucide icons. */
export type IconKey =
  | "ShieldCheck"
  | "Boxes"
  | "Gauge"
  | "Binary"
  | "TerminalSquare"
  | "GitCompareArrows";

export interface FeatureItem {
  icon: IconKey;
  href: string;
  /** markdown */
  title: string;
  /** markdown */
  body: string;
}

export interface StatItem {
  /** markdown */
  value: string;
  /** markdown */
  label: string;
}

export interface StepItem {
  n: string;
  /** markdown */
  title: string;
  /** markdown */
  body: string;
  code: string;
  lang: string;
}

export const landing = {
  hero: {
    badge: "Real ownership — not `Rc<RefCell>` everywhere",
    heading: dd`
      Idiomatic **Rust** from a strict **TypeScript** subset
    `,
    subhead: dd`
      <Hl>typescript-to-rust</Hl> (ttr) translates an explicitly-enforced subset of
      TypeScript into idiomatic Rust with real moves and borrows. Correctness is
      judged by a real <code>cargo</code> toolchain — compile **and** run — not by
      string matching.
    `,
    ctaPrimary: "Get started",
    ctaGithub: "Star on GitHub",
    install: "bun run ttr app.ts --run",
  },

  showcase: {
    heading: "One dialect in, idiomatic Rust out",
    body: dd`
      Write plain, annotated TypeScript. ttr infers ownership and emits Rust that
      a Rust engineer would recognize — <code>&[T]</code> in, <code>Vec&lt;T&gt;</code>
      out, no reference-count soup.
    `,
    tsInput: dd`
      interface Point {
        x: number;
        y: number;
      }

      function scale(points: Point[], factor: number): Point[] {
        return points.map((p) => ({ x: p.x * factor, y: p.y * factor }));
      }

      const unit: Point[] = [{ x: 1, y: 1 }];
      console.log(scale(unit, 3));
    `,
    rustOutput: dd`
      #[derive(Clone, Debug)]
      struct Point {
          x: f64,
          y: f64,
      }

      fn scale(points: &[Point], factor: f64) -> Vec<Point> {
          points
              .iter()
              .map(|p| Point { x: p.x * factor, y: p.y * factor })
              .collect()
      }

      fn main() {
          let unit: Vec<Point> = vec![Point { x: 1.0, y: 1.0 }];
          println!("{:?}", scale(&unit, 3.0));
      }
    `,
  },

  invariant: {
    lead: dd`
      ttr is a **language-level translator for a specified dialect** — not a
      "compile any TypeScript" tool.
    `,
    body: dd`
      TypeScript is unsound and garbage-collected, so a total mapping onto Rust's
      affine ownership does not exist. Tractability comes from <Hl>restricting the
      input</Hl>: anything outside the dialect stops the build with a clear error
      instead of being silently mistranslated.
    `,
  },

  features: {
    heading: "What makes it work",
    body: "A small set of deliberate choices, each carrying its weight.",
    learnMore: "Learn more",
    items: [
      {
        icon: "GitCompareArrows",
        href: "/docs/dialect/overview/",
        title: "A strict, explicit dialect",
        body: "Explicit param types, no `any`/`unknown`, no metaprogramming. The accepted subset is a documented, fail-loud catalog.",
      },
      {
        icon: "Boxes",
        href: "/docs/how-it-works/architecture/",
        title: "Real ownership inference",
        body: "Multi-pass escape/mutation analysis picks moves, `&T`, and `&mut T` — the central technical problem, given first-class treatment.",
      },
      {
        icon: "ShieldCheck",
        href: "/docs/dialect/overview/",
        title: "Fail loud, never guess",
        body: "Reject-loudly beats mistranslate-silently. Every construct the compiler can't soundly lower stops the build.",
      },
      {
        icon: "Binary",
        href: "/docs/how-it-works/architecture/",
        title: "Verified by a real toolchain",
        body: "The oracle is `cargo` itself — the emitted Rust must compile and run. No string-matching, no approximate output.",
      },
      {
        icon: "Gauge",
        href: "/docs/how-it-works/architecture/",
        title: "Idiomatic, fast output",
        body: "Plain `T`/`&T`/`&mut T` and moves — the reason to target Rust at all. `Rc<RefCell<T>>` is a rare local fallback, not the strategy.",
      },
      {
        icon: "TerminalSquare",
        href: "/docs/cli/reference/",
        title: "One-command workflow",
        body: "`bun run ttr <file.ts>` prints Rust; add `--fmt`, `--check`, or `--run` to format, type-check, or compile-and-run.",
      },
    ] satisfies FeatureItem[],
  },

  stats: {
    heading: "Correctness you can trust",
    body: "The project's guarantees aren't aspirational — they're structural.",
    cta: "How it works",
    items: [
      { value: "Option A", label: "idiomatic borrows, not `Rc<RefCell>`" },
      { value: "cargo", label: "compile **and** run oracle" },
      { value: "fail-loud", label: "rejects, never mistranslates" },
      { value: "@ttr", label: "package scope for the toolchain" },
    ] satisfies StatItem[],
  },

  steps: {
    heading: "From `.ts` to running Rust",
    body: "Three steps, one command each.",
    items: [
      {
        n: "01",
        title: "Write strict-dialect TypeScript",
        body: "Annotate your parameters and stay inside the accepted subset. Ordinary TypeScript you'd write anyway.",
        code: "function add(a: number, b: number): number {\n  return a + b;\n}",
        lang: "typescript",
      },
      {
        n: "02",
        title: "Run the translator",
        body: "Point ttr at an entry file. `--run` compiles and executes the emitted crate and prints its stdout.",
        code: "bun run ttr add.ts --run",
        lang: "bash",
      },
      {
        n: "03",
        title: "Get idiomatic Rust",
        body: "Faithful, formatted Rust — verified by cargo before you ever see it.",
        code: "fn add(a: f64, b: f64) -> f64 {\n    a + b\n}",
        lang: "rust",
      },
    ] satisfies StepItem[],
  },

  cta: {
    heading: "Translate your first file",
    body: "Install the Rust toolchain, clone the repo, and run the compiler on a sample in one command.",
    primary: "Read the quickstart",
    secondary: "Browse the docs",
  },
} as const;
