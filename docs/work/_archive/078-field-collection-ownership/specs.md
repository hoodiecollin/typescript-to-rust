# 078 — Field-held mutable collections (`localVar.field.<mut>()` borrow tail): specs

> **Status: SHIPPED.** Differential-oracle BDD (compile → `cargo run` → compare stdout
> vs Bun-run TS), plus emitted-shape assertions. IDs map 1:1 to
> `packages/compiler/tests/field-collection-ownership.test.ts`. Graduates the
> `localVar.field.<mut>()` borrow-conflict tail that **#37/072 ships fail-loud**
> (issue **#45**): a plainly-owned owner mutates its field-collection directly; an
> aliased / field-stored owner promotes to `Rc<RefCell<T>>` via the shared
> `computeAutoRc` union-find and mutates through `borrow_mut`. The re-entrant-overlap
> tail routes to **#41** (stays fail-loud); closure-capture routes to **#46**.

## Clean (plainly-owned local)

- **FC1** owned local, no alias — `const c = new Cache(); c.entries.set("k", 1);
  console.log(c.entries.get("k") ?? -1)` → direct `c.entries.insert(..)` on a
  `let mut c`; differential-matches (`1`). The owner is declared `mut` (the missing
  072-clean-path piece), and no `Rc` appears.
- **FC2** owned local, a `Set` field mutated (`c.tags.add(..)`) then read
  (`c.tags.has(..)`) → direct `c.tags.insert(..)`; differential-matches; no `Rc`.
- **FC3** owned local, `delete` on a field map (`c.entries.delete("k")`) → direct
  `c.entries.shift_remove(&..)`; differential-matches; no `Rc`.

## Promote (aliased / field-stored owner)

- **FC4** aliased owner — `const c = new Cache(); const d = c; d.entries.set("k", 1);
  console.log(c.entries.get("k") ?? -1)` → both promoted to `Rc<RefCell<Cache>>`;
  `d.borrow_mut().entries.insert(..)`; `c` observes the write; differential-matches
  (`1`). Without promotion `const d = c` clones and `c` never sees the write (the
  #37 fail-loud tail / silent-divergence case).
- **FC5** field-stored owner (069 seed) — `const c = new Cache(); const h = new
  Box(c); c.entries.set("k", 1)` unions `Box#c` into `c`'s closure so both promote;
  the mutation through `c` is observed through `h.c`; differential-matches.
- **FC6** the promoted-owner read side stays coherent — after a `borrow_mut()`
  insert through one handle, a `borrow()` read through the alias returns the new
  value (`c.entries.get(..)` via the promoted field); differential-matches.

## Fail-loud residuals

- **FC7** a **lifted callback** that mutates a captured field-collection
  (`xs.map(k => c.entries.set(k, 1)...)`) is a **mutable capture** — a clean
  `DialectError` at `freeVarsOf` (the interim rejection now covers the
  field-collection shape). Closure-capture graduation is out of #45's scope
  (→ **#46**); `compile` throws (`/mutable capture/`).
- **FC8** mutate-during-iteration over a field-collection (a `for..of` over
  `c.entries` that inserts into it) stays **cargo-loud** (→ **#41**): the emitted
  Rust does not compile (double-borrow / no-such-method), no new panic emitted.
  `checkRust(...).ok === false`.

## Regression

- **FC9** `this.field` collection mutation (072) is **unchanged** — a `&mut self`
  method that calls `this.m.set(..)` still emits `self.m.insert(..)`, no `Rc` (the
  always-sound case #45 leaves untouched; a literal key sidesteps the orthogonal
  `&str`-param-vs-`String`-key limitation).
- **FC10** a plainly-owned `localVar.field` **read** (no mutation, 072 clean path)
  is unchanged — `c.entries.get(..)` with no `set` still needs no `mut` and no `Rc`.
</content>
</invoke>
