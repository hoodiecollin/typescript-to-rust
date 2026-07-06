# 028c — `"use arena"` design spike (bumpalo)

> **Status: FIRST SLICE LANDED — this spike was implemented as designed.** The
> `refineArena` pass (`src/arena.ts`), `analysis.arenaScopes`, the `bumpNew`/
> `bumpVec` HIR exprs, and the pinned `bumpalo` dep are in; specs in
> `packages/compiler/tests/arena-directive.test.ts`. The lifetime-elision and
> cargo-is-the-escape-analysis insights below held: no `'a` is ever written and no
> bespoke escape pass was needed. The spike is retained as the rationale + the
> deferral boundary for the next increment (arena values in signatures/fields,
> arena `String`/trees, proactive escape diagnostics).

## What arena allocation buys, and why it's the hard directive

`"use arena"` opts a scope into **bump allocation**: a `bumpalo::Bump` arena is
created at scope entry, every heap allocation in the scope (`Vec`, boxed nodes,
strings) is carved from it, and the whole arena is freed at once at scope exit.
The payoff is allocation-heavy, phase-oriented code — build a big structure, use
it, drop it all — with no per-object `free` and excellent locality.

It is the hardest directive because, unlike `"use panic"` (a local `throw`
rewrite) and `"use rc"` (a per-binding type swap that stays within a body), arena
allocation **changes types in a way that infects signatures**: a bumpalo
collection carries the arena's lifetime (`bumpalo::collections::Vec<'a, T>`), and
that `'a` propagates to every binding, parameter, and return type that touches
an arena value. Soundness hinges on arena values **not escaping** the arena's
scope.

## The key insight: cargo *is* the escape analysis

The 028 plan lists "escape analysis for soundness" as a prerequisite and ties it
to the ownership pass. The spike's finding is that **we do not need to build a
bespoke escape analysis for the first slice** — Rust's borrow checker already is
one. An arena value that escapes its scope (returned, stored in an outer binding,
captured past the arena's lifetime) is a lifetime error the oracle (`cargo`)
rejects. That is exactly the project's fail-loud contract: a conservative
translation that would be unsound instead produces a **loud cargo error**, never
a silent miscompile.

So the sound-by-construction rule for the first slice is: **emit the arena and
its allocations; let cargo reject any escape.** No new analysis pass has to prove
non-escape ahead of time. (A later increment can add a proactive escape check to
turn those cargo errors into a cleaner `UnsupportedError` with a better message —
an ergonomics upgrade, not a soundness one.)

## Target shape (first slice)

Scope: `Array<number>` (and other Copy-element vecs) that are **built and
consumed within the same `"use arena"` body** — the no-escape subset.

```ts
"use arena";
const xs: number[] = [1, 2, 3];
xs.push(4);
console.log(xs.length);        // 4
```
→
```rust
fn main() {
    let arena = bumpalo::Bump::new();
    let mut xs = bumpalo::vec![in &arena; 1.0, 2.0, 3.0];
    xs.push(4.0);
    println!("{}", xs.len());
}
```

Notes that make this tractable:
- **Elide the type annotation** on an arena binding (`let mut xs = bumpalo::vec![…]`).
  `bumpalo::collections::Vec<'a, T>`'s lifetime is then inferred, so the emitter
  never has to *write* a lifetime — the single thorniest part of the naive plan
  disappears for the local case.
- `.len()`, indexing, `.push`, `.iter()` all exist on `bumpalo::collections::Vec`,
  so the existing `len`/`index`/`method`/`iterMap` emission works unchanged on an
  arena vec. Only the **construction** site differs (`vec![…]` → `bumpalo::vec![in &arena; …]`).
- The arena binding is a synthetic `let arena = bumpalo::Bump::new();` injected
  once at the top of the scope body.

## Proposed mechanism (mirrors `refineRc`)

1. **`analysis.arenaScopes`** — leading `"use arena"` on a free fn / script,
   detected exactly like `rcScopes`/`panicScopes`. `takeDirectives` consumes the
   directive (drop the "not yet implemented" throw for `"use arena"`, gate to
   free-fn/script like `"use rc"`).
2. **`refineArena` pass** (`src/arena.ts`, post-lowering, after `refineRc`):
   for each arena-scope body —
   - Prepend a synthetic `let arena = bumpNew` statement (`bumpNew` = new HIR
     expr → `bumpalo::Bump::new()`).
   - Rewrite each `let` whose init is an `array` literal (element type Copy) into
     a `bumpVec { elements }` HIR expr and **clear its type annotation** (`ty: null`).
   - Leave everything else; a non-arena-able allocation stays heap (`Vec`), which
     composes fine (arena and heap vecs coexist).
3. **New HIR exprs** `bumpNew` and `bumpVec` (elements). Emitter:
   `bumpalo::Bump::new()` and `bumpalo::vec![in &arena; <elems>]`. A
   `use`-prelude scan adds nothing (bumpalo paths are fully qualified); the crate
   dependency is pinned in `.scratch/Cargo.toml` (+ `Cargo.lock`), like `tslib`.
4. **Fail-loud residuals** (cargo-caught): an arena vec that escapes (returned,
   stored outer) → lifetime error; arena `String`/boxed nodes, arena params,
   nested arenas → not rewritten in the first slice, so they stay heap or hit
   cargo. All loud, none silent.

## Specs sketch (first slice)

- **Behavioral (differential):** the arena program above prints the same as its
  heap twin (`4`) — proving the arena path is a faithful drop-in for the
  no-escape case. (This is the design doc's "prints the same result as the heap
  version.")
- **Structural:** emitted Rust contains `bumpalo::Bump::new()` and
  `bumpalo::vec![in &arena;`, and no `"use arena"` string leaks.
- **Escape is loud:** a `"use arena"` fn that *returns* its arena vec fails the
  oracle (cargo lifetime error) — `runRust(...).ok === false`. Documents that
  escape is rejected, not miscompiled.
- **Directive hygiene:** `"use arena"` in a method body → `UnsupportedError`
  (same gate as `"use rc"`).

## Why implement this as its own series when picked up

The first slice is roughly the scale of 028b (`refineRc`): one analysis set, one
`takeDirectives` branch, one post-lowering pass, two HIR exprs + emitter arms, a
pinned crate dep, one spec file. The lifetime-elision insight and the
cargo-is-the-escape-analysis insight remove the two things that made the original
plan look large. What stays genuinely out of the first slice — arena values
crossing signatures with explicit `'a`, arena `String`/trees, proactive escape
diagnostics — is a real second increment and should not be attempted until a
concrete fixture demands it.

## Open questions (for the implementation series)

- Which allocations auto-route to the arena? First slice: only `array`-literal
  `let` inits with Copy elements. A broader rule (all `Vec` in the scope, boxed
  struct nodes) needs the lifetime-in-signature work.
- Do we ever *want* to write the explicit `bumpalo::collections::Vec<'a, T>`
  type? Only when an arena value appears in a position that needs an annotation
  (a struct field, a fn signature) — i.e. exactly the escaping cases deferred here.
- Selecting the allocator: keep the directive `"use arena"` = bumpalo for now;
  leave room for `"use arena typed"` / custom behind the same detect-and-route
  mechanism if ever needed.
