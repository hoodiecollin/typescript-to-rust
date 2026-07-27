# 120 — Public Release Plan

**Status:** planning · **Opened:** 2026-07-27
**Goal:** take `typescript-to-rust` from a working-but-private monorepo to a
credible public open-source project — licensed, documented, installable, CI'd,
and launchable.

This is the coordination doc for the release effort. It is a *plan* (an epic),
not a compiler-feature design series; the numbered slot follows the
`docs/work/<NNN-slug>` convention only for locality.

---

## Decisions locked (planning session 2026-07-27)

| Decision | Choice | Consequence |
|---|---|---|
| **Name** | Keep `typescript-to-rust` / `ttr` / `@ttr` — **no rebrand** | Zero rename churn. Explored `ferrite`/`tyrust`/`rustforge`/`ferrik`; all rejected in favor of the honest descriptive name already in use. |
| **Distribution** | bunx/npx CLI **+** standalone binary **+** Homebrew **+** crates.io | Multi-channel. See W3 for the mechanics of each (they are *not* all the same artifact). |
| **Docs site** | Custom **Next.js 16 App Router static-export** site, modeled on `forgedb/apps/website` | Not Starlight/VitePress. Reuse forgedb's file set (see W6). Brand-family cohesion. |
| **Backlog** | **Curate the existing private repo and open it in place** — keep issue + commit history | Requires scrubbing internal labels/notes before flipping public. |

## Decisions resolved (2026-07-27, cont.)

1. **License** — ✅ **dual `MIT OR Apache-2.0`** (Rust-ecosystem norm).
2. **Publishable compiler package name** — ✅ **`@ttr/cli`**, exposing a `ttr` bin.
3. **Version to launch at** — **`0.1.0`** (pre-1.0; dialect may still move).

### Still open (need Collin's sign-off — do not guess)

- **Domain** — do we want one (e.g. `ttr.dev`, `ttr-lang.dev`) for the docs site,
  or ship under a Vercel/Pages subdomain first? Needs an availability check.

---

## The packaging reality (why "distribution" is four different artifacts)

The compiler is **TypeScript-on-Bun that shells out to `cargo`**. Emitted Rust
`use`s the **`tslib` / `ts-primitives`** runtime crates (confirmed: the emitter,
derives, deque, std-shim, hir, analysis all reference them). So:

- **crates.io is not optional.** `tslib`, `ts-primitives` (and any runtime plugin
  crates like `ttr-plugin-leftpad`) **must be published to crates.io** so that a
  user's generated crate can resolve `tslib = "x.y"` instead of a machine-local
  `path = "../../crates/tslib"`. **This is the real cargo/crates.io work item** —
  not `cargo install ttr` for the compiler itself.
- **The compiler binary** ships three ways: npm (`bunx @ttr/cli`), a compiled
  standalone binary (`bun build --compile`), and a Homebrew formula wrapping that
  binary. All three still require a **Rust toolchain on the user's machine** at
  runtime (for `--run` / `--check` and for compiling the emitted crate). That
  prerequisite must be loud in the README and `ttr doctor`-style preflight.

---

## Workstreams (ordered by dependency)

### W1 — Legal & licensing  ⛔ BLOCKER, do first
- [ ] Decide license (open decision #1).
- [ ] Add root `LICENSE` (+ `LICENSE-APACHE` / `LICENSE-MIT` if dual).
- [ ] Set `license` field in every `package.json` and `Cargo.toml`
      (`"MIT OR Apache-2.0"`).
- [ ] Add a `NOTICE` / attribution for third-party deps that require it — audit
      `oxc` (parser), Biome, and any Rust crates in `tslib`/`ts-primitives`.
- [ ] Add a short SPDX header policy (decide: headers vs LICENSE-only; recommend
      LICENSE-only to avoid churn).

### W2 — Package hygiene & publishability
- [ ] Flip `private: true` → publishable on the packages meant to ship
      (`@ttr/std`, `@ttr/cli`, runtime plugin packages). Keep genuinely-internal
      packages private.
- [ ] Rename `packages/compiler` → publishable name (open decision #3) and add a
      `bin` entry so `bunx @ttr/cli file.ts` works.
- [ ] Add `description`, `repository`, `homepage`, `keywords`, `author`,
      `license` to every published `package.json` and `Cargo.toml`.
- [ ] Set real versions (open decision #4): `0.1.0` across the board; give
      `packages/compiler` a `version` field (currently missing).
- [ ] Add `files` allowlists / `.npmignore` so published tarballs are clean.
- [ ] **Convert emitted `path` deps → versioned crates.io deps** for `tslib` /
      `ts-primitives` in the emitter, gated so local dev still uses path deps.

### W3 — Distribution & release tooling
- [ ] **crates.io publish** of `tslib`, `ts-primitives`, runtime plugin crates
      (prereq: W2 versioned deps). Reserve the crate names now.
- [ ] **npm publish** of `@ttr/cli`, `@ttr/std` (bunx/npx channel).
- [ ] **Standalone binaries** via `bun build --compile --target=<triple>` for
      macOS (arm64/x64), Linux (x64/arm64), Windows (x64); attach to GitHub
      Releases.
- [ ] **Homebrew** tap (`hoodiecollin/homebrew-ttr`) with a formula that installs
      the release binary; auto-bump on release.
- [ ] **Release tooling** — adopt **changesets** (monorepo-friendly) to version +
      changelog + publish npm packages; a companion job publishes crates and
      cuts the GitHub Release with binaries.
- [ ] Add a `ttr doctor` / preflight that checks for a Rust toolchain and prints
      a clear remediation message if missing.

### W4 — CI/CD (GitHub Actions)
- [ ] **PR gate** workflow: `bun run typecheck` + `bun run rust:test` +
      `bun run test` + `biome check`. **OS matrix** (macOS + Linux at least, since
      it shells out to `cargo`).
- [ ] Cache bun deps (keyed on lockfile) and cargo registry/target deliberately —
      note forgedb's lesson: do **not** blindly restore stale build caches.
- [ ] **Release workflow**: on tag / changeset, publish npm + crates, build the
      binary matrix, cut the Release.
- [ ] **Docs deploy workflow** (see W6): `vercel build` → `vercel deploy
      --prebuilt`, path-filtered to the site dir, preview URLs on PRs.
- [ ] Branch protection on `main` requiring the PR gate.

### W5 — README overhaul
- [ ] Rewrite the root `README.md` for outsiders: badges (CI, npm, crates,
      license), a punchy one-liner, a **compelling before/after** (TS in → idiomatic
      Rust out) code block, the **"what this is / isn't"** scope note (real
      ownership, strict subset, fail-loud), install (all 4 channels), the **Rust
      toolchain prerequisite**, quickstart, links to docs/contributing/license.
- [ ] Trim/redirect the per-package READMEs (`packages/compiler/README.md`) so
      they don't duplicate or contradict the root.

### W6 — Docs website  (model: `forgedb/apps/website`)
- [ ] Add `apps/website/` and extend the bun workspace glob to include it.
- [ ] Port the forgedb stack: Next.js 16 App Router (static `output: "export"`),
      Tailwind v4 + shadcn/ui, MDX via `next-mdx-remote`, Shiki + `rehype-pretty-code`.
- [ ] Copy & re-skin the key files: `next.config.ts`, `lib/site.ts`,
      `lib/docs-nav.ts` (sidebar single-source-of-truth + prev/next), `lib/mdx.ts`,
      `lib/rehype-code.ts` / `lib/shiki.ts`, `lib/search.ts`,
      `scripts/build-search-index.ts` (⌘K static index + dead-link build check),
      `app/docs/[[...slug]]/page.tsx`, `app/globals.css`, `vercel.json`,
      `.github/workflows/website.yml`.
- [ ] **Bonus:** load a real TS-dialect TextMate grammar into Shiki so code
      samples highlight authentically (same trick forgedb uses for `.forge`).
- [ ] **Content restructure** — turn internal design docs into user-facing MDX:
  - *Getting Started* (install ×4 channels, prerequisites, first translation)
  - *The Dialect* — the accepted TS subset (from the 94KB `dialect.md`, the
    single biggest reference asset; split into browsable pages)
  - *CLI Reference* (`--fmt`, `-o`, `--emit`, `--check`, `--run`, multi-file crates)
  - *How it works* (from `architecture.md` — oracle-driven, real ownership)
  - *Contributing* (link to W7)
- [ ] Brand/theme: fonts, colors, logo, OG images. Decide if it shares forgedb's
      visual language or gets its own.
- [ ] Wire up analytics (optional; forgedb uses PostHog via first-party proxy).

### W7 — GitHub community health
- [ ] `CONTRIBUTING.md` — point at `.agents/AGENTS.md` (spec-first BDD,
      oracle-driven TDD, no-barrel-files), the `bun run check` gate, and how to add
      a dialect fixture.
- [ ] `CODE_OF_CONDUCT.md` — Contributor Covenant.
- [ ] `SECURITY.md` — how to report (this tool generates code others compile; be
      explicit about the trust/threat model).
- [ ] `.github/ISSUE_TEMPLATE/` — bug (with a "smallest TS repro" field),
      feature/dialect-request, "unsupported TS construct" report.
- [ ] `.github/PULL_REQUEST_TEMPLATE.md` — checklist mirroring the BDD workflow.
- [ ] `.github/FUNDING.yml` (optional).
- [ ] A public `CHANGELOG.md` (changesets-generated).

### W8 — Backlog curation & open-sourcing  (decision: open in place)
- [ ] Audit the ~existing issues + labels for anything internal-only or
      embarrassing; rewrite for an outside audience.
- [ ] Decide which internal labels stay public vs get renamed
      (`needs-user-input` → `needs-maintainer-decision`, etc.).
- [ ] Write a **public roadmap** (an epic issue or a docs page) from `docs/plan.md`
      + open issues — but keep `docs/plan.md` as the historical record.
- [ ] Seed a **`good first issue`** set so newcomers have an on-ramp.
- [ ] Scrub the repo: no secrets in history (`gitleaks`/`trufflehog` scan),
      no stray private paths, `.claude/` handling decided (keep or gitignore).
- [ ] Flip the repo to public.

### W9 — Launch
- [ ] Cut `v0.1.0`: tag → release workflow publishes npm + crates + binaries +
      Release notes.
- [ ] Docs site live at its domain.
- [ ] Announce: `r/rust`, `r/typescript`, Hacker News (Show HN), lobste.rs, the TS
      + Rust community channels. Lead with the strongest before/after example and
      the honest "strict subset, real ownership" framing.
- [ ] A pinned "start here" issue + discussions enabled.

---

## Critical path / sequencing

```
W1 license ─┬─> W2 package hygiene ─┬─> W3 publish (npm + crates + binary + brew)
            │                       └─> W4 CI/CD (gate first, release later)
            └─> W8 secret-scrub ────────────────────────────────> W8 flip public
W5 README   (parallel, after W1)                                        │
W6 docs site (parallel, largest independent lift) ──────────────────────┤
W7 community health (parallel, after W1) ───────────────────────────────┘
                                                                         v
                                                                    W9 launch
```

- **W1 gates everything** — nothing publishes without a license.
- **W6 (docs site) is the largest independent lift** and can proceed in parallel
  with the packaging work — start it early.
- **W3 crates.io publish depends on the W2 emitter path→version change**, else
  emitted crates won't compile for users.
- **Repo goes public (W8) only after** secret-scrub + license + community-health
  are in, so the first public impression is complete.

---

## Proposed GitHub issue structure (backlog format)

One **epic** (`epic`, `release`) tracking this doc, with children:

- `release: add license + attribution (W1)` — blocker
- `release: make packages publishable + emitter path→version (W2)`
- `release: distribution channels — npm/crates/binary/brew + changesets (W3)`
- `release: CI/CD workflows + branch protection (W4)`
- `release: README overhaul (W5)`
- `release: docs website (Next.js, model forgedb) (W6)` — largest
- `release: community health files + templates (W7)`
- `release: curate + secret-scrub + open the repo (W8)`
- `release: cut v0.1.0 + announce (W9)`

---

## Notes

- Emitted Rust depends on `tslib` / `ts-primitives` — verified via emitter,
  derives, deque, std-shim, hir, analysis references. Publishing those crates is
  the load-bearing part of the cargo story.
- forgedb docs recon (for W6): `apps/website/`, Next 16 static export, Tailwind v4
  + shadcn, `next-mdx-remote`, Shiki, `cmdk` ⌘K search over a prebuilt
  `search-index.json`, deployed via `vercel build` + `vercel deploy --prebuilt`
  in `.github/workflows/website.yml`.
