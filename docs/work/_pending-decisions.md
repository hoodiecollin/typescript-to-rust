# Pending Design Decisions — the 9 `needs-user-input` issues

Status: **options drafted, awaiting Collin's decisions.** Per the process rule
(`CLAUDE.md`), no final `design.md` or impl until the dialect-shape calls below are
made. Each section: the problem, the current fail-loud behavior, the viable
options with tradeoffs, and the recommended default. Recommendations lean on the
project ethos — **fail-loud honesty, Option-A idiomatic borrows, std-only, minimal
slice first.**

## Coupling map (design these together)

- **Errors: #18 ↔ #17 are ONE decision.** The error *representation* (#18) is what
  `instanceof` discrimination (#17) consumes. Pick it once; land #18 then #17.
- **Class #4 gates #17 polymorphism** and shares the derive/nested-field machinery
  with #22/#23.
- **Closures: #9 ↔ #11 ↔ #12** share one capture pass + one closure representation.
- **Async: #15 ↔ #13 ↔ #14.** Combinators want #14 (async methods/arrows) to be
  broadly useful; `spawn` is joined to #13's un-awaited-call policy.
- **Generators: #19 ↔ #20.** `yield*` delegation rides whichever #19 strategy wins.
- **Dialect-ethos calls (mostly standalone): #28, #3, #6.**

---

## #28 — Struct equality (`===`/`!==` on objects)

**Problem.** JS `===` on objects is *identity* equality; Rust `==` via
`derive(PartialEq)` is *structural*. Blindly mapping `===`→`==` is a silent
semantic flip. Today `structA === structB` lowers to `==` but `derives.ts`
deliberately omits `PartialEq`, so it's *accidentally* fail-loud via an opaque
rustc `E0369` — not a clean dialect error.

**Options.**
- **A — structural `==`, documented divergence.** Ergonomic, idiomatic, matches how
  most translated value-struct code is written. Cost: silent divergence from JS
  identity; requires a new "Semantic divergences" section in `dialect.md` (none
  exists — the doc is a pure rejection catalog today).
- **B/D — reject object `===` (fail-loud), keep scalar `===`.** Honest; upgrades the
  opaque `E0369` into a real dialect diagnostic; reversible. Cost: rejects some
  genuinely-fine value-equality code.
- **C — pointer identity.** Non-starter under Option A (moves/clones make pointer
  identity meaningless).

**Note:** `f64` is `PartialEq` but not `Eq`, so Option A does *not* unblock
struct map/set keys (#21 needs `Eq + Hash`). Don't oversell A.

**Recommended:** **B/D** — reject object `===`, keep scalars. Upholds fail-loud,
reversible, and **decouple the `PartialEq` derive** so #21/#22/#23 can still derive
it on-demand for other features (`.includes`, map keys) without committing the
operator semantics.

> **DECISION (2026-07-07): structural `==` by DEFAULT; identity only under
> `"use rc"` / `"use arena"`.** Collin's call (overrides the recommendation):
> - **Default:** object `===`/`!==` → structural `==`, deriving `PartialEq` (gated
>   on all fields being `PartialEq`-eligible via a new `isTypePartialEq` in
>   `derives.ts`). This is a **documented semantic divergence from TS** — requires a
>   NEW "Semantic divergences from TypeScript" section in `docs/dialect.md` (the doc
>   is currently a pure rejection catalog) + a fixture pinning the structural
>   behavior.
> - **Under `"use rc"`:** `===` → real pointer identity (`Rc::ptr_eq`) — meaningful
>   because the instance has a stable heap home.
> - **Under `"use arena"`:** `===` → pointer identity on the arena allocation.
> - Open design sub-questions: how the emitter selects structural-vs-identity per
>   operand (needs operand-type + active-directive info at the `===` lowering site,
>   `lower.ts:~1907`); `f64`-field structs are `PartialEq` but not `Eq` (still can't
>   be map/set keys — don't oversell for #21).

---

## #18 + #17 — Error representation & `instanceof` catch discrimination

**Problem.** Today `E` is uniformly `String`, or `Box<dyn std::error::Error>` once
any custom error class is declared (022). Custom errors accept only the
`{ message }` shape. So multiple error types lose identity + fields, and a
`catch (e) { if (e instanceof FooError) … }` has nothing to discriminate on
(`instanceof` in a catch is fail-loud).

**Options (representation — the shared decision).**
- **(a) Whole-program generated `enum`** (`AppError { NotFound{msg}, Validation{field,msg}, Other{msg} }`)
  + hand-written `Display`/`Error`. → #17 becomes a native exhaustive `match`; owned
  narrowed bindings; fields first-class; **no external crate**. Cost: biggest
  pipeline change (new HIR enum item, `From` glue, `programErrType` returns the
  enum, `lowerThrow` builds variants, `lowerErrorClass` relaxes to typed fields).
- **(b) Keep `Box<dyn Error>` + `downcast_ref` per branch.** Smallest change but
  *doesn't solve the issue*: `downcast_ref` borrows fight ownership on
  consume/rethrow; no exhaustiveness; fields hidden.
- **(c) `thiserror`-derived enum.** Same benefits as (a), less boilerplate, but
  first non-`tslib` dependency — an ethos departure + a Cargo-manifest emission seam.

**Recommended:** **(a) whole-program enum, std-only**, and **design #18 + #17 as one
series** (representation lands in #18, catch-lowering in #17). Widen custom-error
fields to **message + declared typed fields** (ctor limited to `super(message)` +
`this.f = f`). Keep **program-uniform `E`** (preserves the `?`-composes invariant;
note the "one class widens everyone" tax as accepted).

> **DECISION (2026-07-07): (c) `thiserror`-derived enum.** Collin accepts the
> external-crate dependency for the ergonomics. Consequences to design: a
> **Cargo-manifest / dependency-injection seam** is now in scope (the first
> non-`tslib` dep — thread it through `rust-oracle/Cargo.toml` and the harness); the
> generated enum uses `#[derive(thiserror::Error, Debug)]` + `#[error("…")]`
> attrs instead of hand-written `Display`/`Error`. Still one program-wide enum;
> still widen fields to message + typed fields. **Design #18 → #17 together.** Open
> sub-question for the design: how the `#[error("…")]` format string is synthesized
> when an error carries fields beyond `message`.

---

## #4 — Class `extends` / inheritance

**Problem.** `class B extends A` is rejected wholesale (`class inheritance
(extends/implements)`). In scope: field inheritance, method override, `super`,
polymorphic base-typed use. (`class X extends Error` is already special-cased;
`abstract` already forbidden.)

**Options.**
- **1 — Reject forever, steer to composition + `interface`** (reclassify to
  Forbidden with a better message). Zero risk; matches the owned/nominal/no-magic
  stance. Cost: a real TS feature stays unusable.
- **2 — Composition desugar** (`struct B { base: A, … }`, forwarders, `super.m()`→
  `self.base.m()`, `super(args)`→`base: A::new(args)`). Stays in owned Option-A;
  `super`/reuse map mechanically. Cost: every inherited-field access must rewrite
  to `.base.x`; **no polymorphic substitutability**.
- **3 — Trait-based** (base as `trait` + default methods; fields as accessor
  methods). The only option with real subtype polymorphism (`&dyn A`), so it pairs
  with #17. Cost: fields-as-traits is a big impedance mismatch; `super` needs
  synthetic helpers; `dyn`/`Box` reintroduces the heap Option A avoids; largest
  surface.
- **4 — `Rc`-based dynamic.** Reopens the settled memory-model decision — rejected.

**Recommended:** **Option 1 (forbid, steer to composition)** as the honest default;
add the **non-polymorphic slice of Option 2 (reuse-only)** *only if* real fixtures
demand code reuse. Polymorphism forces `dyn`/`Box`, which fights Option A — keep it
out. Decide **#4 before #17** (polymorphism is the shared core).

> **DECISION (2026-07-07): the composition + trait HYBRID (Options 2 + 3
> combined).** Collin's call (overrides the recommendation):
> - **Data + `super` + inherited-field reuse → composition.** `class B extends A` →
>   `struct B { base: A, …own }`; `super.m()` → `self.base.m()`; `super(args)` →
>   `base: A::new(args)`; inherited `b.x` → `b.base.x`. Mechanical, zero-cost,
>   Option-A-clean.
> - **Method reuse + polymorphism → a shared trait.** Emit `trait IA { …default
>   bodies… }`, `impl IA for A` + `impl IA for B` (B overrides what it redefines).
>   Base-typed use → `impl IA` (mono, zero-cost) or `&dyn IA` / `Box<dyn IA>`
>   (hetero) — **`dyn` heap/dispatch cost appears ONLY in polymorphic positions.**
> - **Inherited-field access through a `dyn IA` → generate trait accessor methods**
>   (`fn x(&self) -> &f64`) for shared fields, so polymorphic code can read base
>   data.
> - Largest surface of any #4 option (new `HirTrait`, trait-vs-struct split, `dyn`
>   in the ownership pass, pairs with #17 downcast) → write a full `design.md` and
>   **sequence it last.** `super` calling a trait *default* body needs a synthetic
>   helper (design detail).

---

## #6 — Module system (`export` / `import`)

**Problem.** All module syntax is fail-loud at the parse gate (not in `MODELED`).
Emission is single-unit: one `Program` → one Rust file. `09_modules` is the last
`test.todo`.

**Options.**
- **1 — Single-file inline/flatten.** Resolve imports by inlining items into one
  module; erase `import`/`export`. Zero harness change. Cost: not a real module
  system (no encapsulation/visibility, name-collision hazard).
- **2 — File → inline Rust `mod` in one crate.** `export`→`pub`, `import`→`use
  crate::x::…`, each file an inline `mod` in one `lib.rs`. Real encapsulation, still
  single compilation unit (harness intact). Cost: lowering/analysis become
  module-aware (per-`mod` scope, cross-`mod` resolution, visibility).
- **3 — Multi-file/multi-crate cargo project.** Most faithful; but new emitter
  contract (set of files, not a string) + new harness project mode — breaks the
  one-unit oracle. Largest surface.
- **4 — Defer entirely.** Zero risk; leaves the last todo.

**Recommended:** **Option 2** — real `export`→`pub`/`import`→`use` while keeping the
harness single-unit. **CLI takes an entry file + transitive local-relative
resolution** (refuse bare/package imports). **Named exports only** — keep
`export default`, `export * from`, dynamic `import()` fail-loud (default has no Rust
analog; re-export barrels cut against the no-barrel ethos).

> **DECISION (2026-07-07): Option 2 (file → inline Rust `mod`, one crate).**
> Confirmed. Entry-file + transitive local-relative resolution, named exports only,
> `export default` / `export * from` / dynamic `import()` stay fail-loud.

---

## #3 — Missing type-annotation enforcement

**Problem.** The rule ("annotate everything except a trivial-literal `const n = 5`")
is enforced inconsistently: untyped **params** and **fields** fail loud, but untyped
`let`/`const` **bindings** silently pass (Rust infers a type we never validated),
and a **missing return type** silently defaults to `-> ()` (only cargo catches the
mismatch, not fail-loud).

**Options.**
- **A — annotations mandatory everywhere, no exception.** Simplest, zero inference;
  rejects `const n = 5`; breaks existing literal fixtures.
- **B — narrow trivial-literal exception (formalize current intent).** Untyped OK
  iff initializer is a single scalar literal; everything else untyped fails loud;
  add return-type enforcement. Matches `dialect.md` as written; low churn.
- **C — widen to any statically-obvious literal** (scalars + homogeneous scalar
  arrays). Most ergonomic; risks drifting toward a mini type-inferencer.

**Recommended:** **B** — smallest change that closes the hole without contradicting
the shipped catalog. Missing annotation → **`UnsupportedError`** (fixable/"annotate
it", consistent with the param message; can't flip an existing Unsupported into a
Dialect error). Treat `-5`, `null`, `undefined` initializers as **non-trivial**
(require annotation).

> **DECISION (2026-07-07): Option C — wider syntactic inference.** Collin's call:
> allow untyped bindings for any statically-obvious literal initializer — scalars
> **plus homogeneous scalar arrays** (`[1,2,3]` → `Vec<f64>`). Still fail-loud on
> empty/mixed arrays, non-literal initializers, and (the real hole) **missing
> return types** — stop defaulting those to `-> ()`. Missing annotation stays
> `UnsupportedError`. Keep the inference **purely syntactic** (no callee/flow
> typing) to stay single-pass-no-`tsc`; each widening is a documented dialect
> commitment.

---

## #9 — Value-position closures (`Fn`/`FnMut` + capture)

**Problem.** Arrows only lower as immediate iterator-adapter callbacks. A closure
as a *value* — stored, passed as a param, returned, or capturing an outer binding
— is fail-loud. Needs a Rust closure *representation* × a *capture strategy* under
Option A.

**Options (representation).**
- **A — generic `impl Fn` / `F: Fn`** (monomorphized). Zero-cost, idiomatic, fits
  the move-in param model. Can't express closure-in-struct-field / `Vec<closure>`.
- **B — `Box<dyn Fn>`.** Uniform, non-generic, covers all storage cases. Cost: heap
  + dynamic dispatch (departs from the zero-cost bias).
- **C — `fn`-pointer, non-capturing subset only.** Trivially sound first slice; but
  excludes the interesting capturing case.

**Capture strategy (the real work):** a new `analysis.ts` pass computing
free-var set, capture mode (ref/mut-ref/move), and `Fn`/`FnMut`/`FnOnce`.
Simplest-sound first cut: **capture by `move`, `Fn`+`FnMut` only, require captured
non-`Copy` unused after** (sidesteps closure lifetimes); `FnOnce` + by-ref-with-use
stay fail-loud.

**Recommended:** **A primary, fall to B only where A can't express** (struct field /
`Vec` of closures). Capture: the move-`Fn`/`FnMut` first cut above. **#9 owns the
representation + shared capture pass; #11 (non-`Copy` inline) and #12 (`let`-bound
arrow) reuse them.**

> **DECISION (2026-07-07, revised): lambda lifting to named pure fns + fn-pointers
> — NO closure/capture machinery.** Collin's reframe (supersedes the `impl Fn` +
> capture-pass answer). Closures are *not* the mapping destination; captures are the
> entire source of difficulty, so we eliminate them by closure conversion.
>
> **The mechanism:**
> - **Callback bodies → named pure `fn`s.** Each arrow/callback body is lifted to a
>   top-level function whose former free variables become explicit parameters.
>   Anonymous arrows get synthesized, hoisted names (e.g. `__cb_map_1`).
> - **Iterator-adapter boundary → a trivial forwarding shim.** Rust's `.map`/
>   `.filter`/`.fold`/etc. are typed to take `Fn`, so we cannot pass a bare
>   multi-arg `fn`; we emit a thin auto-generated shim closure `|x| __cb(*x, n)`
>   that forwards the element **plus read-only outer scalars/refs by value/copy**
>   (lifted into `__cb`'s param list). This is the ONLY closure we ever emit, and
>   its captures are always the trivial read-only-by-copy kind Rust handles with no
>   analysis. **`map(x => x + n)` stays ergonomic** (forwarding read-only outer
>   scalars is explicitly allowed — Collin's call).
>   ```ts
>   const bump = 10; xs.map(x => x + bump);
>   ```
>   ```rust
>   fn __cb(x: f64, bump: f64) -> f64 { x + bump }
>   xs.iter().map(|x| __cb(*x, bump)).collect()
>   ```
> - **Function *values* (param / stored / returned) → `fn` pointers.** Only
>   non-capturing top-level fns / arrows qualify (they coerce to `fn(T) -> U`),
>   zero-cost, no generics in the signature.
>   ```rust
>   fn apply(f: fn(f64) -> f64, x: f64) -> f64 { f(x) }
>   ```
>
> **Deleted from scope (the hard machinery that no longer exists):** the
> capture-analysis pass, `Fn`/`FnMut`/`FnOnce` inference, `Box<dyn Fn>`,
> move/by-ref capture reasoning, closure lifetimes. **#9 collapses to lambda-lifting
> + fn-pointers.** **#11 and #12 shrink with it** — #11 (non-`Copy` inline) becomes
> "the shim borrows/clones the element"; #12 (`let`-bound arrow) is just a
> non-capturing `fn`-pointer binding. Neither reuses a capture pass anymore.
>
> **Stays fail-loud (honest boundary):** stateful/mutable-capture callbacks (a
> closure counter, `onClick(() => this.x++)`), and a runtime-selected function value
> that isn't a nameable top-level fn — the user lifts to a named fn taking the
> needed data as explicit args. Idiomatic Rust doesn't reach for these either.

---

## #15 — Promise combinators / concurrency

**Problem.** Async is strictly sequential `await asyncFn(...)`. All concurrency
(`Promise.all`/`race`/`allSettled`, `.then`, timers, spawn) is fail-loud. tokio is
already wired (`join!`/`select!`/`spawn` available; timers need the `"time"`
feature; dynamic `join_all` wants the `futures` crate).

**Scope bundles.**
- **Minimal:** `.then` desugar (→ inline `await` + callback) + fixed-arity
  `Promise.all`/`race` → `join!`/`try_join!`/`select!`. **Zero new deps, zero
  ownership change.** Highest value per surface.
- **Medium:** + dynamic `join_all`/`allSettled` (adds `futures`) + awaited timers
  (adds `"time"`).
- **Full:** + `spawn`/task concurrency + callback `setTimeout` — drags in the
  **Send + 'static + `Arc<Mutex>` tax** across the ownership model.

**Recommended:** **Minimal first.** **Defer `spawn` (Full), design it jointly with
#13** (un-awaited-call policy). Medium (`futures` + timers) as the next slice.
Note: `Promise.race` drops losers (JS leaves them running) — confirm that's an
acceptable documented divergence or make it fail-loud. #14 (async methods/arrows)
is effectively a prerequisite for combinators to be broadly useful.

> **DECISION (2026-07-07): Full scope — including task `spawn`.** Collin's call
> (overrides the minimal recommendation): the async concurrency series covers
> `.then` desugar, `Promise.all`/`race`/`allSettled` (fixed-arity `join!`/`select!`
> + dynamic `join_all`/`allSettled` via the `futures` crate), timers (tokio
> `"time"`), **and `tokio::spawn` task concurrency + callback `setTimeout`.** This
> accepts the **Send + `'static` + `Arc<Mutex<…>>` ownership tax** — the ownership
> pass must learn to emit `Arc`/`Arc<Mutex>` for state shared across spawned tasks
> (a substantial analysis extension). **Design jointly with #13** (un-awaited-call
> → `spawn`) and lean on **#14** (async methods/arrows) as a prerequisite. Confirm
> `Promise.race` cancellation-of-losers as a documented divergence during design.
> Large surface → its own multi-slice series.

---

## #19 — Generators with yield-in-loop / branch

**Problem.** Only straight-line finite `yield a; yield b;` lowers (→
`vec![…].into_iter()`). Loop-yield, conditional-yield, nested-yield are fail-loud.

**Options.**
- **(a) Pattern-match common shapes → std iterator adapters** (`for…yield`→
  `(a..b).map`, guard→`.filter`, `yield*`→`.flat_map`/`.chain`). Cheap, idiomatic,
  lazy, reuses `impl Iterator` + `for-of` path. Cost: brittle catalog; near-misses
  drop to fail-loud; no stateful-loop story.
- **(b) Full state-machine `struct` + `impl Iterator`.** General (CPS transform).
  Cost: a whole new subsystem (CFG, liveness across yield points, state numbering,
  borrow-safe captures) — the largest generator investment.
- **(c) Coroutine crate / nightly `gen`.** Off-target (non-std dep or unstable
  toolchain).
- **(d) Stay fail-loud / trivial widening.**

**Recommended:** **(a) adapter chains first** — buys the common cases at low cost,
stays lazy/idiomatic; land (b) only when fixtures demand stateful/interleaved
yields. Initial catalog: **range-`map` + guard-`filter`**, defer `flat_map`/`chain`
to land with #20's `yield*`. Keep the **`impl Iterator<Item=T>`** return contract so
#20 consumption composes.

> **DECISION (2026-07-07): (b) full state-machine.** Collin's call (overrides the
> adapter-chain recommendation): compile the generator body to a resumable
> generated `struct` + `impl Iterator`, running to the next `yield` in `next()`.
> Requires the real CPS subsystem — **CFG construction + live-variable analysis
> across yield points** (any local live across a `yield` becomes a struct field),
> state numbering, and borrow-safe capture. New HIR (generator-struct item) + new
> emitter templates. Keep the **`impl Iterator<Item=T>`** public return so #20
> consumption composes. Residual that stays fail-loud: references held across a
> yield point (the hard borrow case), nested `try` across yields. Largest generator
> investment → its own series; `yield*` (#20) becomes a nested drive of the
> delegate's iterator inside `next()`.

---

## Sequencing (all 9 now decided — small/foundational → large)

Ordered by size and dependency now that scope is locked. The last three (#15, #19,
#4) each grew into large multi-slice series by Collin's scope choices.

1. **#3** (type enforcement, wider syntactic inference) — smallest; closes the
   silent binding/return-type hole.
2. **#28** (struct equality) — structural-`==` default + divergences doc section +
   `isTypePartialEq`; the `"use rc"`/`"use arena"` identity path couples to the
   **#27** directive work, so coordinate with that.
3. **#9** (closures: **lambda-lifting to pure fns + fn-pointers**, no capture pass) —
   foundational; **#11/#12 shrink onto it** (shim borrows/clones the element;
   `let`-bound arrow → fn-pointer), so land it before them.
4. **#18 → #17** (thiserror error enum → `instanceof` discrimination) — one unit;
   introduces the **first non-`tslib` Cargo dependency + manifest-emission seam**.
5. **#6** (modules → file-to-inline-`mod`) — analysis-wide (per-`mod` scope,
   cross-`mod` resolution, visibility, CLI entry-file resolver).
6. **#15** (async concurrency — FULL incl. `spawn`) — large; needs the
   `Arc`/`Arc<Mutex>` ownership extension; **joint with #13**, leans on **#14**.
7. **#19** (generators — FULL state machine) — large; new CPS subsystem
   (CFG + liveness across yield points); **pairs with #20** `yield*`.
8. **#4** (inheritance — composition + trait hybrid) — largest; new `HirTrait`,
   trait-vs-struct split, `dyn` in the ownership pass; **pairs with #17** downcast,
   so sequence after the error series.

## Next phase

Design passes (investigate → options → decision) are **complete for all 9**. The
next phase is writing the formal `docs/work/<NNN-slug>/design.md` + `specs.md` per
series (in the order above), then RED→GREEN impl per the BDD workflow. Each series
also: add its node types / relaxations to `validate.ts` + mirror in `dialect.md`
(including the new **Semantic divergences** section from #28), and flip the issue
label `needs-design` → `has-design` once its design doc lands.
