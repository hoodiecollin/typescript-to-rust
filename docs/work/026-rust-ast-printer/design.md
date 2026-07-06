# 026 — A structured Rust AST + pretty-printer (plan)

> **Status: PLAN — downstream of 027, oracle-triggered.** This is an *emitter
> architecture* question, not a dialect-surface one. Two honest reasons to hold
> it, neither of them "demand" (this project has no consumers): (1) **dependency
> order** — 026 exists to clean up the nested/chained output that *027* produces,
> so it is genuinely downstream of 027; (2) **YAGNI + cost** — a structured Rust
> AST is a large emitter rewrite, and the string emitter + rustfmt handles the
> current fixture corpus. The trigger to build it is **the oracle flagging a real
> precedence/parenthesization defect** on a fixture we write (`cargo check`
> rejects it or a differential run diverges), not a user asking. **Update
> (030, 2026-07-06):** the gap is confirmed latent but currently *masked* — the
> emitter's `binary` case renders `left op right` with **no** parenthesization
> (emitter.ts), yet you cannot reach it, because explicit parens
> (`ParenthesizedExpression`) are rejected one level earlier at validation
> (`UnsupportedError`). So the true prerequisite is **paren support**, and it must
> land *together with* precedence-aware parenthesization — adding parens alone
> would emit `(a + b) * c` as `a + b * c`. That pairing is the concrete first
> slice of this series. See docs/work/_archive/030-fixture-coverage-expansion.

## Today

The emitter (`emitter.ts`) is a **pure, total HIR → string** function: each HIR
node renders to a Rust source string via template literals, and `rustfmt`
normalizes whitespace/layout afterward. It has an exhaustiveness guard (a
`switch` returning `string` with no `default`, so a new HIR node forces a new
case). This is deliberately simple and has served every series to date.

What it is **not**: a Rust *abstract syntax tree* with a structure-aware
pretty-printer (the `syn` + `prettyplease`/`quote` model in the Rust ecosystem),
where you build typed `Expr`/`Item`/`Stmt` nodes and a printer decides layout,
precedence, and parenthesization from structure.

## The cost the string emitter is quietly paying

String rendering is fine while output is **line-oriented and precedence is
hand-managed**. It gets error-prone exactly where Rust's grammar has structure
the string doesn't track:

1. **Operator precedence / parenthesization.** Emitting `a + b` inside `* c`
   needs `(a + b) * c`. Today correctness relies on the lowering author
   remembering to wrap. A structured printer parenthesizes from precedence
   automatically — the single strongest argument for the AST.
2. **Expression vs. statement position** (`if`/`match`/`block` as values).
3. **Long-line wrapping** of call args / chains (rustfmt handles most of this,
   masking the need — a genuine reason to stay strings).
4. **Attributes/derives, generics, where-clauses** as they proliferate — string
   concatenation of `<'a, T: Trait>` fragments is brittle.

## Recommendation

**Do not build it now.** rustfmt absorbs layout, and precedence is currently
manageable because the dialect emits few deeply-nested arithmetic/logical
expressions. Building a Rust AST is a large, cross-cutting rewrite of the
emitter with no user-visible feature payoff on its own.

**Trigger condition (revisit when any of these is true):**
- We hit a *real* precedence/parenthesization bug that string emission made easy
  to get wrong (track these; two or three is the signal).
- We start emitting non-trivial nested expressions (once arrows/closures + method
  chains land — see 027 tslib — `xs.iter().map(...).filter(...).collect()`
  nesting inside binary ops).
- Generics/where-clauses become common (traits, generic fns).

**Sequencing.** Explicitly *after* 027 by dependency order — 027's method chains
are what generate the nesting/precedence pressure this doc solves, so 026
consumes 027's output. Front-running it is a large emitter rewrite with no payoff
on the current corpus. The build signal is an oracle-caught precedence defect on
a fixture we write (see Status), not calendar time and not demand.

## Design when it fires

Introduce a **third IR layer** between HIR and string: a `rust-ast.ts` module of
Rust node types (`RsItem`, `RsExpr`, `RsStmt`, `RsType`, `RsPat`) and a
`printer.ts` that renders them with:
- a precedence table driving automatic parenthesization (the core value),
- a small `Doc`-style layout (Wadler/Prettier-style groups) *or* continue
  deferring layout to rustfmt (recommended: keep leaning on rustfmt; the AST is
  about *correctness*, not layout).

The current emitter then splits: HIR → `rust-ast` (the interesting lowering of
semantics) and `rust-ast` → string (mechanical). The exhaustiveness guard moves
to the printer. Do **not** adopt a Rust-side crate (`syn`) — that's for parsing
Rust, and we generate, not parse.

## Scope estimate (when undertaken)

- New: `rust-ast.ts` (node types), `printer.ts` (precedence + render).
- Rewrite: `emitter.ts` split into HIR→RsAst and delete string templates.
- Migrate: every emitter case (~one per HIR node) — mechanical but broad.
- Net: a large refactor touching one file's worth of logic spread into two; no
  new fixtures (behavior-preserving), so `design.md`-only per the workflow, with
  the existing differential suite as the safety net.

## Open questions

- Layout: keep delegating to rustfmt (recommended) or own it? Owning it removes
  the rustfmt subprocess dependency but is a big scope add.
- Do we gain enough from precedence-automation alone to justify it before the
  closure/method-chain work (027) makes nesting common? Likely sequence 027
  first, then reassess 026.
