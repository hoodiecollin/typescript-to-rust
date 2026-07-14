# 079 — Closure-captured containers (env-threading, by-need borrows)

> **Status: SHIPPED (2026-07-14).** Graduates closure capture of a container (read
> **or** mutated), issue **#46** (split from #45). Dialect calls made with Collin
> 2026-07-11. Keeps the 048 **no-real-closures** architecture: captured containers are
> **threaded as call-site parameters**, borrowed **by need** (`&` / `&mut`). Specs:
> `specs.md` → `packages/compiler/tests/closure-captured-containers.test.ts` (CC1–CC16).
>
> **Impl notes / deviations:**
> - **Stored path (`const add = (…) => …`)** — a pure pre-analysis AST transform in
>   `normalizeArrows` (`lower.ts`). `classifyStoredCapture` collects the arrow's free
>   container captures (excluding params — incl. destructured — and body locals via
>   `collectBoundNames`); `threadStoredCapture` hoists the arrow to a `__arrow_n` fn
>   with the captured containers **prepended as leading params** carrying their owned
>   type annotation (synthesized by `containerAnnotationOf` from the declaration /
>   `new Set<T>()` / array-literal), and records a call-site rewrite (`add(a)` →
>   `__arrow_n(s, a)`). The fn-pointer binding is **dropped**. The threaded param's
>   `&`/`&mut` borrow and the call-site `&s`/`&mut s` are then derived by the existing
>   `analyzeFunction` ownership inference + `lowerCall` — no new borrow machinery.
> - **Inline path (`.map`/`.filter`/…)** — `freeVarsOf` now returns
>   `{ names, mutated }` (a bare captured-container method-mutation is recorded in
>   `mutated`, not rejected); `liftCallback` forwards a container free var as `&T` /
>   `&mut T` (reusing the 057 `{kind:"ref"}` param + a `ref` forwarded arg) via
>   `isCaptureContainerType`. **Read-only** inline capture ships (CC6).
> - **Escape check** (`assertNonEscaping`) — every use of the stored binding must be a
>   direct call; a returned / stored / passed closure is fail-loud (CC9, CC10).
>
> **Fail-loud residuals (kept):**
> - **Shared/aliased captured container** → the `Rc<RefCell>` row (needs `refineRc`
>   into `liftedFns`) stays fail-loud (`ctx.aliased` guard, CC11).
> - **Inline *mutable* container capture** — the 048/057 numeric-surface body typer
>   can't type a mutating expression body (a block body isn't liftable at all), so it
>   stays fail-loud (CC7). The stored path covers mutable capture (CC2/CC3/CC5/CC8).
> - **Field-of-captured mutation** (`c.entries.set(…)` on a captured owner) — a nested
>   receiver → deeper shape (→ Rc row), still fail-loud (unchanged from #45).
> - **Scalar mutable capture / captured container reassigned wholesale** — unchanged
>   048 fail-loud (CC12, CC13). **Capture through two closure levels** — fail-loud.

## Problem

The dialect has **no real closures**. Two lowering paths, both losing captures:

- A **stored arrow** `const add = (x) => {…}` is lifted to a **free `fn`** (top-level or
  `__arrow_*` + a fn-pointer binding, `lower.ts:522–671`). A free fn can't see an enclosing
  local, so `const s = new Set(); const add = x => s.add(x); add(1)` → cargo **E0425** (`s`
  out of scope).
- An **inline callback** (`.map`/`.filter`) is lifted by `liftCallback` (`lower.ts:6175`),
  which forwards free vars as **params restricted to Copy scalars** — a captured container
  (Set/Map/Vec/String) is rejected **even read-only** (`"not a Copy scalar"`, `lower.ts:6277`).

Additionally `freeVarsOf` (`lower.ts:6036`) only flags a **scalar** mutable capture (an `=`
LHS or `++`); a **method** mutation on a captured container (`s.add(x)`) **slips past** it and
dies later at the Copy gate or at cargo. And `refineRc` (`rc.ts`) does **not** recurse into
closure/lifted-fn bodies, so a promoted `Rc<RefCell>` wouldn't be rewritten inside one.

So #46 is not "add `Rc`" — it is **"how does a container-capturing closure work at all,"** in
an architecture that deliberately avoids real closures.

*(Note: `.forEach(x => s.add(x))` already works — it lowers to a plain `for` loop referencing
`s` directly, `lower.ts:6559`, sound when `s` is `mut`. Not a #46 gap.)*

## Decisions (2026-07-11, with Collin)

### 1. Emission model — env-threading, non-escaping only (extend lift-to-fn)

Keep 048's model. A capturing closure's captured **containers become extra parameters** of the
lifted fn, threaded at **every call site**. **No real Rust closure, no `move`.**

- **Inline callback** — `liftCallback` already forwards free vars as trailing params + args;
  extend it to accept container captures (below) instead of rejecting non-Copy.
- **Stored-and-called closure** — the `__arrow_*` lift threads the captured container as a
  param, and **every call site `add(a)` is rewritten to `__arrow(<env>, a)`**. This requires
  `add` to be **non-escaping** (only invoked directly).
- **Escaping closure** — one that is returned, stored in a field/array, or passed to a callee
  that retains it (the environment would outlive the call) → **fail-loud**. Env-threading
  can't represent it; real closures would be a separate, larger series.

### 2. Capture strength — by-need borrows (memory model: idiomatic, `Rc` last)

Per captured container, pick the weakest binding that works:

| Capture | Emitted param | Body |
|---|---|---|
| **read-only** (no mutator called on it) | `&T` | `env.len()`, `env.get(k)`, … |
| **mutated, owned & non-aliased** | `&mut T` | `env.insert(x)` / `env.push(x)` |
| **mutated, and the container is aliased/shared** (062/#45) | `Rc<RefCell<T>>` (clone) | `env.borrow_mut().insert(x)` |

`&mut T` threading is sound because each call `__arrow(&mut env, a)` borrows `env` **only for
that call** — sequential calls don't overlap. The **`Rc<RefCell>` row reuses #45/078's
promotion** (a shared captured container is one more alias shape); it is **sequenced after #45
lands** and **stays fail-loud** in the interim (never a `RefCell`-panic-shaped emit).

## Mechanism

### Capture classification (extend `freeVarsOf`)

`freeVarsOf` returns read-only free vars and throws on scalar mutable capture. Extend it (or a
sibling pass) to also report **captured containers** and, for each, whether the body calls a
**mutating method** on it (`mutatingMethods`, `analysis.ts`) → `read` vs `mut`. A captured
container whose owner is aliased/shared (062 alias-escape set) → the `Rc` row (→ #45).

### `liftCallback` (inline) — forward containers by ref

At the free-var loop (`lower.ts:6271`), replace the Copy-scalar rejection for a container type
with: forward `&T` (read) or `&mut T` (mut) as the lifted-fn param; pass `&env` / `&mut env` at
the single call site. Body references to the container already lower to method calls on the
param name — no rewrite beyond the param type.

### Stored closure (`const add = …`) — thread the env + rewrite call sites

In the arrow-binding lift (`lower.ts:522`): when the arrow captures a container, keep the
`__arrow_*` free fn but **append the captured container(s) as leading param(s)** (`&`/`&mut`),
and **rewrite every `add(args)` call site to `__arrow(<&|&mut>env, args)`**. Drop the
fn-pointer binding for `add` (it now carries a bound environment — it is no longer a plain
value). **Verify `add` never escapes** (only appears as a direct callee); any other use →
`UnsupportedError`. Multiple captured containers thread as multiple params (stable order).

### Escape check

A small analysis over the closure binding's uses (sibling to alias-escape): `add` is
non-escaping iff every use is a direct call `add(...)`. A use as an argument, a return value, a
field/array store, or a reassignment → escaping → fail-loud.

### `Rc` row (deferred to #45 sequencing)

When the captured container is aliased/shared, promotion routes it to `Rc<RefCell<T>>` (062/#45
`refineRc`); the threaded param becomes the `Rc` clone and body mutations become
`borrow_mut()`. Because `refineRc` doesn't yet enter lifted-fn bodies, this also needs
`refineRc` to rewrite inside `analysis.liftedFns`. **Both are #45-coupled → fail-loud until #45
lands.**

### Reuse

048/057 `liftCallback` + `freeVarsOf` + the `__arrow_*` lift; `mutatingMethods` (read/mut
classification); 062/#45 alias-escape + `refineRc` (the `Rc` row); `analysis.liftedFns`.

## Fail-loud residuals

- **Escaping closure** — returned, stored in a data structure, or passed to a retaining callee
  → env-threading can't represent it (would need real closures, a later series).
- **Shared/aliased captured container** needing `Rc<RefCell>` → fail-loud until **#45/078**
  lands, then promote.
- **Scalar mutable capture** (`x = …` / `x++` on a captured scalar) — unchanged 048 fail-loud
  (out of scope; the container graduation does not touch it).
- **A captured container reassigned wholesale** inside the closure (`s = new Set()`) — a scalar-
  style rebind of the binding, not a method mutation → stays fail-loud.
- **Capture through more than one closure level** (a closure capturing a var captured by an
  outer closure) — scope boundary; fail-loud.

## Impl sequence

1. **Classification** — extend `freeVarsOf` to report captured containers + read/mut (via
   `mutatingMethods`); keep the scalar-mutable-capture throw.
2. **Inline path** — `liftCallback` forwards a captured container as `&T`/`&mut T` (drop the
   Copy-scalar rejection for containers); borrow the arg at the call site.
3. **Stored path** — thread the env param(s) into `__arrow_*`; rewrite `add(args)` call sites;
   drop the fn-pointer binding; **escape check** → fail-loud otherwise.
4. **`Rc` row** *(after #45)* — shared captured container → `Rc<RefCell>`; teach `refineRc` to
   rewrite inside `liftedFns`. Fail-loud interim.
5. RED `specs.md` → GREEN (differential — read + owned-mutable capture; escaping + shared →
   fail-loud).

## Specs sketch

- **Read-only capture** — `const arr = [1,2,3]; const sum3 = () => arr[0]+arr[1]+arr[2]; console.log(sum3())`
  → `__arrow(&arr)`; differential-matches.
- **Owned-mutable stored closure** — `const s = new Set<number>(); const add = (x:number)=>{ s.add(x); }; add(1); add(2); console.log(s.size)`
  → `__arrow(&mut s, x)` per call; `2`; differential-matches.
- **Owned-mutable inline** — `const acc: number[] = []; [1,2,3].forEach(x => acc.push(x*2))` (or
  `.map`) → container forwarded `&mut`; differential-matches.
- **Multiple captures** — a closure mutating two owned containers → two threaded params.
- Fail-loud: an **escaping** closure (`return add` / `arr.push(add)`); a **shared** captured
  container (aliased owner → #45 interim); a captured **scalar** reassignment.
- Regression: a Copy-scalar capture (`const k=2; xs.map(x=>x*k)`) — **byte-for-byte unchanged**
  (048 path); `.forEach` container mutation unchanged.

## Open sub-details (impl, not dialect forks)

- Whether classification lives in `freeVarsOf` (return a richer descriptor) or a sibling pass;
  threading the read/mut + shared flags to both lift paths.
- Call-site rewrite for a stored closure that is **also** shadowed / reassigned — interacts
  with the `reassigned` set already consulted at `lower.ts:532`.
- Param **order/stability** when a closure captures several containers + Copy scalars (a single
  deterministic ordering for both the sig and every call site).
- The `refineRc`-into-`liftedFns` recursion (the `Rc` row) — coordinate with #45's
  promoted-set so a captured shared container is one entry, not two.
- Borrow granularity for an inline callback that both reads and mutates the same captured
  container (single `&mut`, reads via the `&mut`).
