# 028 — Per-scope compiler directives (plan)

> **Status: ALL THREE DIRECTIVES LANDED (first slices).** 028a (`"use panic"`),
> 028b (`"use rc"` → `Rc<RefCell<T>>`, `refineRc` in `src/rc.ts`), and 028c
> (`"use arena"` → `bumpalo` bump allocation, `refineArena` in `src/arena.ts`,
> designed in `arena-spike.md`). Each is a post-lowering HIR→HIR pass keyed off a
> leading directive detected in analysis (`panicScopes`/`rcScopes`/`arenaScopes`),
> gated to a free fn / top-level script. Specs: `directives.test.ts` (028a),
> `rc-directive.test.ts` (028b), `arena-directive.test.ts` (028c). Each landed a
> first slice with documented, cargo-loud deferral boundaries — see `specs.md` and
> `arena-spike.md`. Original plan below.
>
> Inspired by React's `"use client"`/
> `"use server"` and Vercel Workflow SDK's `"use workflow"`/`"use step"`: a
> leading string-literal directive in a function/block body that switches the
> translation strategy for that scope. An **explicit escape hatch** that keeps
> the default dialect strict while letting the user opt a scope into a
> sanctioned alternative.
>
> **The three directives have very different readiness — do not treat 028 as one
> unit:**
> - ✅ **`"use panic"` — ripe now, independent.** Self-contained; composes
>   directly with the fallibility fixpoint from series 021–023 (it is the inverse
>   switch). No new infrastructure. Can slot in *anywhere* — even ahead of 027.
>   **This is the one to build first.**
> - ⛔ **`"use rc"` — deferred, blocked on the ownership/borrow pass maturing**
>   (still a spike in `analysis.ts`). It turns an ownership-inference *give-up*
>   into working `Rc<RefCell<T>>`, so it needs that pass to exist to know *when*
>   to kick in.
> - ⛔ **`"use arena"` — deferred furthest.** Arena lifetimes infect signatures
>   and require an escape analysis for soundness (ties to the ownership pass).
>
> Recommended split: ship `"use panic"` as its own small series soon; hold
> `"use rc"`/`"use arena"` until the ownership work lands (see plan.md "Next").

## Mechanism

A directive is a leading `ExpressionStatement` whose `expression` is a string
`Literal` at the top of a function body or block — already present in the ESTree
AST, mechanically cheap to detect (the same position JS uses for `"use strict"`).
Lowering reads directives off a scope before lowering its body and threads a
`ScopeMode` through. Directives are **lexically scoped**: they apply to the
enclosing function/block and (unless overridden) its descendants.

```ts
function hot(): void {
  "use panic";
  if (bad) throw new Error("x");   // → panic!("x") here, not Result
}
```

Detection is additive to 024's validator: a recognized directive string is
consumed; an *unrecognized* `"use …"` directive → `DialectError` (fail loud, no
silent no-op).

## The three directives

### `"use panic"` — `throw` becomes `panic!`

In a scope where recovery is unwanted, translate `throw` as `panic!(msg)` (and
`throw new E(m)` as `panic!` with `E`'s message) instead of the default
`Result`/`?` fallibility model (series 013/016/017/021–023). Effects:
- The function does **not** become `-> Result<…>`; callers are not forced to
  `?`. This removes fallibility propagation for the scope.
- Interacts with the fallibility fixpoint (`analyzeFallible`): a `"use panic"`
  function is treated as *infallible* for propagation, and its `throw`s do not
  upgrade the program error type.
- Cleanest, lowest-risk directive; good first implementation. Composes with
  `try`/`catch`? No — `catch` can't catch a `panic!` faithfully; a `try` in a
  `"use panic"` scope stays rejected.

### `"use rc"` — Option-B managed memory for the scope

The plan reserves `Rc<RefCell<T>>` as a **local fallback** for aliasing that the
default Option-A idiomatic-borrow model can't express (shared mutable graphs,
cyclic-ish structures). `"use rc"` is the sanctioned bridge: within the scope,
bindings whose aliasing defeats borrow inference are translated under
`Rc<RefCell<T>>` (and `Rc::clone`/`.borrow_mut()`) instead of failing the
ownership pass.

- This is the **strongest-justified** directive: it turns a hard `Unsupported`
  (ownership inference gives up) into working, if less idiomatic, output — an
  explicit user opt-in to widen the dialect exactly where needed.
- Scope: the ownership/borrow pass consults `ScopeMode` and switches the
  representation of aliased bindings. Larger design (ownership pass isn't built
  out yet) — sequence after the borrow inference work matures.

### `"use arena"` — arena/bump allocation (Bumpalo)

Opt a scope into **arena allocation** via the `bumpalo` crate: allocations in the
scope come from a bump arena freed all at once at scope exit. Fits
allocation-heavy, phase-oriented code (build a big structure, use it, drop it).

- Target shape: introduce a `let arena = bumpalo::Bump::new();` at scope entry;
  route the scope's heap allocations (`Vec`, boxed nodes, strings) to
  `bumpalo::collections`/`arena.alloc(...)`; lifetimes tie to `&arena`.
- This is the **most complex** of the three: it changes types (arena lifetimes
  infect signatures) and interacts with ownership inference and `tslib`
  collection types. Treat as the last directive; start with a narrow subset
  (arena-local `Vec`s that don't escape the scope).
- First allocator worth supporting = **Bumpalo** (simple, popular, `no_std`
  friendly). Leave room for other strategies (`typed-arena`, custom) behind the
  same directive-selects-allocator mechanism.

## Recommended sequence

`"use panic"` (self-contained, low risk) → `"use rc"` (high value, needs
ownership pass) → `"use arena"` (highest complexity, needs lifetime plumbing).

## Design decisions

- **Directive vs. annotation vs. out-of-dialect.** Use a *directive* when the
  choice is a per-scope *translation strategy* (panic vs Result, borrow vs Rc,
  heap vs arena). Use an *annotation/type* when it's about a specific
  binding/type. Keep genuinely-unsupported things out-of-dialect (fail loud).
- **Unknown directive → `DialectError`.** Never silently ignore a `"use …"`
  string; that would reintroduce a fail-loud hole.
- **Nesting/override.** Inner directive overrides outer for its subtree. A scope
  with no directive inherits the enclosing mode (default = Option A + Result).

## Specs sketch (per directive sub-series)

- `"use panic"`: `throw` in the scope → emits `panic!`; the fn signature is
  **not** `Result`; a caller need not `?`. Differential: program aborts with the
  message (non-zero exit) rather than returning `Err`.
- `"use rc"`: a shared-mutable-alias program that fails ownership inference
  *without* the directive **compiles** *with* it, emitting `Rc<RefCell<T>>`.
- `"use arena"`: an arena-scoped `Vec` build → emits `bumpalo` allocation;
  differential prints the same result as the heap version.
- Unrecognized `"use frob"` → `DialectError`.

## Open questions

- Do directives attach only to functions, or also to bare blocks? (Lean:
  functions first; blocks later.)
- `"use rc"` granularity: whole scope, or only the specific aliased bindings the
  ownership pass flags? (Lean: only the flagged bindings, to keep the rest
  idiomatic.)
- Does `"use arena"` need an escape analysis to forbid arena-allocated values
  from escaping the scope? (Yes — required for soundness; ties to the ownership
  pass.)
