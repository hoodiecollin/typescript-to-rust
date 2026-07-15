# 086 — Closure-`Rc<RefCell>` capture (shared/aliased captured mutable container)

> **Status: SHIPPED (2026-07-14).** Graduates the **`Rc<RefCell>` row** that series
> **079** (issue #46) deferred: a **shared/aliased** mutable container captured by a
> **direct-call** stored closure. Dependency **#45/078** shipped. Implements the settled
> 062 auto-`Rc<RefCell>` / capture-the-clone model for containers through the **one**
> shared promoted-set (`computeAutoRc`/`refineRc`) — no fork. Specs: `specs.md` →
> `packages/compiler/tests/closure-rc-capture.test.ts` (RC1–RC14, all green).
>
> **Impl notes / deviations:**
> - **Container tracking in `computeAutoRc`** — a `Vec`/`Set`/`Map`/`String` binding is
>   tracked in the **same** union-find as class bindings (a parallel `containerBinding`
>   set), with three new edges: a bare-ident collection-mutator seed (`s.insert`/`xs.push`
>   inside `__arrow_n` — `CONTAINER_MUT_METHODS`), a container alias edge (`const t = s`),
>   and a container arg→param edge into a lifted-fn param. **`AutoRcResult` shape
>   unchanged** — containers are edges, not fields.
> - **The owned-vs-shared split** is a **container-shared** flag (a `const t = s` alias),
>   **not** the ≥2-member gate. Every captured container is arg-threaded into `__arrow_n`
>   (a ≥2-member component by construction), so the ≥2 gate can't distinguish owned from
>   shared. A container component promotes **iff mutated ∧ contains a `containerShared`
>   member**; a lone owned container keeps 079's `&mut` (byte-for-byte). Class components
>   keep the 062/069 ≥2-member gate.
> - **`refineRc` generalized from class-only to any inner** — `wrapRc` unwraps any `&`
>   (a threaded `&mut Set` param → owned `Rc<RefCell<Set>>`); the `let`-promotion, param
>   seeding, `len`-read `.borrow()`, and the container in-place mutators
>   (`CONTAINER_MUT_METHODS` → `.borrow_mut()`) all key on `rc` membership, not class-ness.
>   The "teach `refineRc` into lifted-fn bodies" capability was **already satisfied** —
>   the stored closure is lifted to a top-level `module.items` fn *before* analysis, so
>   `refineRc` already iterates it; the work was the promotion wiring.
> - **`lower.ts`** — the `ctx.aliased` fail-loud branch in `threadStoredCapture` is
>   **removed** (aliasing is now owned authoritatively by `computeAutoRc`); the dead
>   `collectAliasedVars`/`ctx.aliased` plumbing is gone. A **two-level capture guard**
>   (`scopeVars`, the immediately-enclosing function scope) fails loud when a captured
>   container is from a scope > 1 level out (env-threading can't reach it).
> - **Two new fail-loud residuals surfaced** (both settled 062 shapes, not new forks):
>   (a) **re-entrant read-in-mutate** of a shared cell (`m.set(k, m.get(k)+v)` →
>   `m.borrow_mut().insert(k, m.borrow()…)` would panic) → `DialectError` (RC3b); (b) the
>   two-level capture above (RC8).
> - **Scope beyond #46 (intended):** a plain (no-closure) aliased+mutated container also
>   promotes now — previously a **silent `.clone()` miscompile** (`const t = s` cloned, so
>   `t` never saw `s`'s writes). This is the faithful 062 semantics, a strict correctness
>   win, verified against the full container-suite sweep with zero regressions.

## The gap (issue #46, the graduating case)

079 threads a captured container as a **by-need borrow** param — `&T` (read) or `&mut T`
(owned-mutable, non-aliased). That is sound only when the container is **exclusively
owned**: each call `__arrow_n(&mut s, x)` borrows `s` for that call alone, and no other
binding observes `s`. The one shape it can't express — and fails loud on (079 CC11,
`ctx.aliased` guard) — is a **shared/aliased** container:

```ts
const s = new Set<number>();
const t = s;                                 // JS: t and s are the SAME Set
const add = (x: number): void => { s.add(x); };
add(1);
add(2);
console.log(t.size);                          // must observe the writes → 2
```

`&mut s` threading is wrong here: `const t = s` moves/clones the `IndexSet`, so `s` and
`t` become independent values and `t` never sees the closure's inserts. The faithful
model is 062's: promote the container to `Rc<RefCell<IndexSet>>`; `const t = s` becomes
`Rc::clone(&s)`; the closure captures a **clone** of the handle; mutations go through
`.borrow_mut()`, and `t.size` reads through `.borrow()`. Both handles point at one cell.

This is exactly the `Rc<RefCell>` model 062 already ships for **class** bindings. The
only reason it doesn't reach containers today is that `computeAutoRc` / `refineRc` gate
**promotion** on `classOfType(ty)` being non-null (a `struct C`), so a `Set`/`Map`/`Vec`/
`String` binding is never seeded, aliased, or promoted. This series lifts that gate for
the **captured-container** shape, reusing the one promoted-set representation.

## What already works (grounding — do NOT rebuild)

- The **emitter is fully generic** over the `Rc` inner type: `emitType` prints
  `Rc<RefCell<${inner}>>` for any inner (`Rc<RefCell<IndexSet<f64>>>` prints fine);
  `rcNew` → `Rc::new(RefCell::new(v))`; `rcClone` → `Rc::clone(&x)`; a `method` named
  `borrow`/`borrow_mut` prints `.borrow()`/`.borrow_mut()`; the `use std::rc::Rc; use
  std::cell::RefCell;` imports are auto-added by a generic `usesKind` scan. Nothing is
  hardwired to structs (verified 2026-07-14).
- **`refineRc`'s borrow insertion is type-agnostic.** `maybeBorrow` / the `method` case
  splice `.borrow()`/`.borrow_mut()` whenever the receiver ident is in the scope's `rc`
  set (`rc.has(name)`) — it does **not** re-check class-ness. Only the **promotion
  decision** (`rcBody`'s `let` case, param seeding) is class-gated.
- The stored-closure path (`normalizeArrows` → `threadStoredCapture`) is a **pre-analysis
  AST transform** that already: hoists the arrow to a `module.items` fn `__arrow_n`,
  prepends the captured containers as leading params, rewrites every `add(a)` call site to
  `__arrow_n(s, a)`, drops the fn-pointer binding, and enforces `assertNonEscaping`.
- The lifted `__arrow_n` is an ordinary `module.items` fn, so `computeAutoRc` **already
  walks its body** and `refineRc` **already visits it** — the "teach `refineRc` to enter
  lifted-fn bodies" work is **already satisfied by construction** (the stored path lifts
  to a real top-level fn, not an un-visited closure body). The residual work is the
  *promotion* wiring, not the *traversal*.

## Decision (implement the settled 062/079 model — no new fork)

**A captured container whose owner is aliased/shared promotes to `Rc<RefCell<T>>` through
the existing shared promoted-set**, exactly as a class binding does. Concretely, three
coordinated edits, all riding `computeAutoRc` + `refineRc` (no parallel machinery):

### 1. Container-alias tracking + a captured-container promotion seed (`alias-escape.ts`)

`computeAutoRc` gains a **container namespace** alongside its class namespace. A binding
whose lowered type is a **capture container** (`vec` / `set` / `hashmap` / `String`,
reusing `isCaptureContainerType`) is tracked in the same union-find:

- **Alias edge** — `const t = s` where `s` is a tracked container binding unions `t ↔ s`
  (today only class idents alias; extend the bare-ident-alias case to containers).
- **Arg↔param edge** — a container arg threaded into a `__arrow_n` leading param unions
  `arg ↔ param` (today the arg-edge requires the arg be class-typed; admit a container
  arg into a promotable callee param too).
- **Mutation seed (new)** — a lowered collection mutator (`insert` / `shift_remove` /
  `push` / `pop` / … — the lowered `Set`/`Map`/`Array` mutators) on a **bare-ident**
  receiver marks that binding mutated. Today `noteExpr` only marks a mutator on a
  **field** receiver (078) or a `&mut self` class method; the bare-ident container
  mutator inside `__arrow_n` (`s.insert(x)`) is the new trigger.

The existing **≥2-member ∧ ≥1-mutated** gate then promotes the alias closure exactly as
for classes: `s` (mutated in `__arrow_n`) ∪ `t` (aliased) ∪ the `__arrow_n` param
(arg-threaded) is a ≥2-member component with a mutated member → promoted whole.
`AutoRcResult`'s shape is **unchanged** — containers are one more alias shape, added as
union-find edges, not new fields (matching #45's "one representation" scope item 3).

A **lone** captured container (079 CC2/CC3/CC5 — owned, non-aliased, mutated but never
aliased) stays a **1-member component** → **not** promoted → keeps 079's `&mut` threading
**byte-for-byte** (the ≥2-member gate is the owned-vs-shared split, no regression).

### 2. Generalize the promotion gates from class-only to class-or-container

The handful of `classOfType`-gated spots in `computeAutoRc` and `rcBody` that decide
**membership / promotion** (not borrow insertion) accept a promoted container binding:

- `computeAutoRc.walk` (`let` case) tracks a container binding's "class" as a sentinel
  container tag (or simply tracks the binding as promotable-container) so the alias / arg
  edges above are threaded. Construction is a container node (`setNew` / `mapNew` / an
  array literal / a `String`), not `new C()`.
- `rcBody`'s `let` promotion (`refineRc`) promotes a `promotedLocals`-listed container
  binding: `const s = new Set()` → `s.init = rcNew(inner)` and `s.ty = { kind:"rc", inner
  }`; `const t = s` (alias of an rc container) → `rcClone`. The `rc.add(name)` +
  `s.mut = false` bookkeeping is unchanged. This needs the `let` case to promote when
  `promotedLocals.has(s.name)` **regardless of whether `s.ty` is a class** — the current
  code already keys promotion on `promotedLocals.has(s.name)`; the only class-specific bit
  is computing the wrapped `s.ty`, which generalizes to `wrapRc(s.ty)` for any inner.
- Param seeding (`rcBody`) wraps a promoted container **param** of `__arrow_n` to
  `Rc<RefCell<T>>` and adds it to `rc` — again keyed on `scopeParams.has(p.name)`, with
  the type wrap generalized past the class check.

Everything downstream — `maybeBorrow` on `s.borrow().len()` reads (`t.size` → HIR `len` →
`t.borrow().len()`), the `method insert` → `s.borrow_mut().insert(x)` rewrite, the
call-site `__arrow_n(Rc::clone(&s), x)` param-clone — is **already** driven by `rc.has`
membership, so it works unchanged once the binding/param is in the `rc` set.

### 3. Stored-closure path: stop failing loud, thread the container for promotion (`lower.ts`)

`threadStoredCapture` currently throws on `ctx.aliased.has(cap)`. Replace the throw with
the **thread-and-let-refineRc-promote** path: still prepend the captured container as a
leading param and rewrite the call sites (as 079 does for the owned case), but **do not**
force the `&mut` param — let `computeAutoRc` decide. Because the arrow-lift is a
pre-analysis transform and promotion is a post-lowering pass, the pre-analysis transform
just produces the ordinary threaded `__arrow_n(s, a)` shape; `computeAutoRc` then sees the
alias (`const t = s`), the mutation (`s.insert` in `__arrow_n`), and the arg-thread, and
promotes the whole closure. The `assertNonEscaping` guard **stays** (an escaping closure
is still fail-loud — env-threading, `Rc` or `&mut`, can't represent a captured environment
that outlives the call).

The `ctx.aliased` set (`collectAliasedVars`) still identifies the aliased case; but instead
of a fail-loud gate it becomes a **no-op** for threading (the container is threaded either
way) — the aliasing is re-derived, authoritatively, by `computeAutoRc`'s union-find, which
is where the promotion actually happens. (Keeping `collectAliasedVars` would fork the
alias source; the design **removes** the fail-loud branch and lets `computeAutoRc` own it.)

## Why the traversal capability is "teach `refineRc` into lifted-fn bodies"

079's design framed the residual as "`refineRc` doesn't recurse into lifted/closure
bodies." In this architecture the stored closure is **lifted to a top-level `module.items`
fn** *before* analysis, so `refineRc` already iterates it (`for item of module.items`). The
capability the row actually needed was: **make the promoted-container binding + its
threaded param + its aliases share one union-find component and one `rc` membership set, so
the borrows `refineRc` splices inside that lifted fn (`s.borrow_mut().insert`) and at its
call sites (`Rc::clone(&s)`) come from the same promotion as the outer-scope reads
(`t.borrow().len()`).** That is edits 1–2. No new recursion into an un-visited body is
required; the "rewrite borrows inside the lifted fn" happens because the lifted fn is a
first-class item whose param is now a promoted rc container.

## Fail-loud tail to PRESERVE (reject-specs)

Unchanged from 079 — only the direct-call shared/aliased container graduates:

- **Escaping closure** — a captured-container closure that is **returned**, **stored** in a
  field/array, or **passed** as a value → `assertNonEscaping` fail-loud (the env outlives
  the call; real closures are a separate series). *(RC-reject: returned; stored-in-array.)*
- **Two-level capture** — a closure capturing a var captured by an outer closure → the
  capture walk does not descend nested arrows → fail-loud. *(RC-reject.)*
- **Scalar mutable capture** (`n++` on a captured scalar) / **wholesale container rebind**
  (`s = new Set()` inside the closure) — separate 048 rejections, not this row. *(RC-reject.)*
- **Inline mutable capture** (`.map(x => acc.push(...))`) — the numeric-surface body typer
  can't type a mutating body (079 CC7) → fail-loud, unchanged. The **shared/aliased**
  graduation is the **stored/direct-call** path only.
- **Non-`Clone` element under sharing** / **mutate-during-iteration over the promoted cell**
  (→ #41) / **`Rc` cycles / `Weak`** — unchanged 062/068/077 residuals.

## Impl sequence

1. **`alias-escape.ts`** — track container bindings in the union-find; add the bare-ident
   collection-mutator seed; admit container alias + arg↔param edges. Generalize the
   promotion projection so a promoted container binding/param lands in
   `promoted`/`promotedParams` (shape unchanged).
2. **`rc.ts` (`refineRc`)** — generalize the `let`-promotion, alias-clone, and
   param-seeding type-wrap from class-only to any inner (`wrapRc` already generic). Borrow
   insertion is already membership-driven — no change.
3. **`lower.ts` (`threadStoredCapture`)** — remove the `ctx.aliased` fail-loud branch;
   thread the aliased container like the owned one (let `computeAutoRc` promote). Keep
   `assertNonEscaping`. Remove the now-dead `collectAliasedVars` / `ctx.aliased` plumbing
   if nothing else consumes it.
4. RED `specs.md` → GREEN (differential — the CC11 shape now runs and matches JS;
   fail-loud tail still rejects). Update 079 CC11 (it asserted `toThrow`) — it now
   graduates, so move/replace it here and leave a regression note.

## Specs sketch

- **RC1 shared/aliased Set** — the CC11 shape (`const t = s; add mutates s; console.log(t.size)`)
  → both promoted `Rc<RefCell<IndexSet<f64>>>`; `t.borrow().len()` sees `2`;
  differential-matches. Emitted-text: `Rc::new(RefCell::new(`, `Rc::clone(&s)`,
  `.borrow_mut().insert(`.
- **RC2 shared/aliased array** — `const a: number[] = []; const b = a; const push = (x)=>{a.push(x)}; push(1); console.log(b.length)` → `Rc<RefCell<Vec<f64>>>`; `1`.
- **RC3 shared/aliased Map** — analogous with `Map` (literal key, sidestepping the
  `&str`-key limitation as CC4 does).
- **RC4 alias observed both ways** — mutate through the closure, read through **both** `s`
  and `t` → both see it.
- **RC5 regression: owned-mutable (079 CC2) stays `&mut`** — `const s = new Set(); const
  add=(x)=>{s.add(x)}; add(1); console.log(s.size)` (no alias) → **not** promoted, `&mut
  IndexSet` threaded, byte-for-byte 079. Emitted-text: `&mut`, no `Rc::new`.
- **RC-reject** — escaping (returned / stored-in-array) captured-container closure;
  two-level capture; scalar mutable capture; wholesale rebind — all `toThrow`.
- **RC regression: non-capturing arrow / read-only capture (CC1/CC15/CC16)** — unchanged.

## Open sub-details (impl, not dialect forks)

- Whether the container "class tag" in `computeAutoRc` is a real sentinel or the binding is
  tracked in a sibling `containerBindings` set feeding the same union-find — pick the one
  that keeps `AutoRcResult` unchanged and the class path untouched.
- The exact lowered-mutator name set for the bare-ident seed (reuse `COLLECTION_MUT_METHODS`
  ∪ the array mutators `push`/`pop`/`shift_remove`/… as lowered) — keep it in lockstep with
  `lower.ts`.
- `refineRc` `classOfExpr` currently returns a **class** name; a promoted container has no
  class. Confirm the container borrow path never needs `classOfExpr` (it doesn't — borrows
  are `rc.has`-driven; `classOfExpr` only serves promoted-**field** reads, a class-only
  shape). Guard against a container binding accidentally entering the field-read path.
- Multiple captured containers where **some** alias and some don't — per-binding promotion
  (the union-find already handles this; the lone ones stay `&mut`, the aliased ones promote).
