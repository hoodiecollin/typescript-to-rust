/** Site-wide constants. One place to change brand/links. */
export const site = {
  name: "typescript-to-rust",
  tagline: "Idiomatic Rust from a strict TypeScript subset",
  description:
    "typescript-to-rust (ttr) translates a strict, explicitly-enforced subset of TypeScript into idiomatic Rust with real ownership and borrows — not Rc<RefCell> everywhere. Correctness is judged by a real cargo toolchain, not string matching.",
  url: "https://typescript-to-rust.dev",
  github: "https://github.com/hoodiecollin/typescript-to-rust",
} as const;

/** Top-level nav shown in the site header. */
export const headerNav: { title: string; href: string }[] = [
  { title: "Docs", href: "/docs/" },
  { title: "Dialect", href: "/docs/dialect/overview/" },
  { title: "CLI", href: "/docs/cli/reference/" },
  { title: "How it works", href: "/docs/how-it-works/architecture/" },
];
