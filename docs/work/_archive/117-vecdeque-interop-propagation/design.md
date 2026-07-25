# 117 — VecDeque interop + cross-boundary propagation

Issue **#101** (`ownership`/`dialect`/`codegen`/`deferral-graduation`) — the residual
tail of series 116 (#78, array mutations). Series 116 shipped front-mutated arrays →
`VecDeque` as a **per-body** `refineDeque` pass; three residuals stayed fail-loud
(cargo-caught, never silent). This series graduates all three:

1. **Cross-boundary propagation** — a deque binding passed to / returned from a
   `Vec`-typed function currently mismatches at cargo (E0308). Graduate via
   **whole-program container-class propagation** across `arg→param` and `return`
   edges (Collin, 2026-07-24 — chose *full call-graph propagation*, mirroring
   ownership's `refMut` fixpoint, over convert-at-boundary or better-fail-loud).
2. **Vec-only ops on a deque binding** — `sort`/`join`/`concat`/`flat` on a
   front-mutated binding don't route through the interop helpers yet. The helpers
   already exist (`deque_as_slice_mut`, `deque_to_vec`); wire them.
3. **Multi-arg `push(x, y)` / `unshift(x, y)`** — 116 shipped single-arg only.

Collin (2026-07-24): **all three in one series** (not split), **full call-graph
propagation** for #1.

## Ground truth (verified 2026-07-24)

- `refineDeque` (`src/deque.ts`) is a per-body pass: `collectDeque` gathers bindings
  front-mutated by name (`shift`/`unshift`/`arrayMutLen` unshift), `rewriteDeque`
  flips the `let` type (`vec` → `vec{deque}`), wraps `init` in
  `tslib::array::deque_from_vec`, and retargets mutating methods
  (`push`→`push_back`, `pop`→`pop_back`, `shift`→`pop_front`, `unshift`→`push_front`,
  `splice`→`deque_splice`). It **only rewrites `let` bindings** — never params or ret
  types, and never threads across call edges.
- The interop helpers are already in `crates/tslib/src/array.rs`:
  `deque_as_slice_mut(&mut VecDeque<T>) -> &mut [T]` (via `make_contiguous`),
  `deque_to_vec(&VecDeque<T>) -> Vec<T>` (contiguous clone), `deque_from_vec`,
  `deque_splice`. **No caller wires them yet.**
- Vec-only op emit sites: `iterSortDefault`/`iterSortBy` (`emitter.ts:2320-2323`,
  `tslib::array::sort_default(&mut recv)` / `sort_by(&mut recv, …)`); `join`/`concat`/
  `flat` are `call` nodes to `tslib::array::{join,concat,flat}` built in
  `arrayTailMethod` (`method-routing.ts:135-192`) with `recvRef = {borrow:"ref", expr}`.
- Multi-arg push: `arrayTailMethod` (value form → `arrayMutLen`) and
  `tryArrayMutStatement` (statement form) both hard-gate `args.length === 1`. Multi-arg
  falls through today.
- Ownership's model to mirror (`analysis.ts`): a per-fn signature fixpoint
  (`fns.get(name).params[i].ownership`) flows `refMut` across call edges; callers
  consult it to mark `mut` locals (`analysis.ts:962-995`) and to require `&mut` at the
  arg. `Borrow = "owned" | "ref" | "refMut"`; `HirParam { name, ty }`;
  `HirFn { params, ret }`; `call` node `{ callee: string, args: HirArg[] }`;
  `return` node `{ value: HirExpr | null }`.

## Design

Stay with the 116 architecture decision: **all deque logic lives in `refineDeque`**
(a standalone HIR→HIR pass), *not* in type inference. This series lifts `refineDeque`
from per-body to **whole-module two-phase** (classify → rewrite) and adds the interop
+ multi-arg rewrites.

### Part 1 — whole-module deque classification (the fixpoint)

Replace the per-body `collectDeque` with a module-wide classifier producing:

- `paramDeque: Map<fnName, Set<paramIndex>>` — params that are deque.
- `retDeque: Set<fnName>` — functions whose return is a deque.
- `localDeque: Map<body, Set<bindingName>>` — deque bindings per body (incl. a deque
  param, which is a local of its body).

`fnName` keys free functions by name and class methods by method name (name-keyed,
the **same documented same-name limitation** as ownership's `methodParams` — a genuinely
unresolvable cross-class collision stays cargo-loud, never silent).

**Seeds (per body):**
- Any binding (a `let` **or** a param) front-mutated (`shift`/`unshift`/`arrayMutLen`
  with `pushMethod` `unshift`) → `localDeque`. If it is a param → `paramDeque(fn, i)`.
- `return e` where `e` is a deque value → `retDeque(fn)`.

**`exprIsDeque(e, body)`** — a value is a deque if: it is an ident in that body's
`localDeque`; or a `call` to a `retDeque` fn; or already `deque_from_vec(…)`.

**Propagation edges (iterate to a fixpoint):**
1. **arg → param:** callsite `f(a…)` where arg *i* `exprIsDeque` → `paramDeque(f, i)`.
2. **param → arg (backward):** `paramDeque(f, i)` → at every callsite of `f`, the arg *i*
   binding (if a bare ident) → its caller body's `localDeque`. *(This is the #101
   `drain` case: `q` is deque inside `drain`, so every `drain(a)` promotes `a`.)*
3. **alias:** `let b = a` (or `b = a`) where `a` is deque → `b` deque.
4. **return → binding:** `let x = f(…)` where `retDeque(f)` → `x` deque.

Fixpoint terminates: the lattice is finite (a binding/param/ret is deque or not) and
edges are monotone (only ever add).

### Part 2 — rewrite (consumes the classification)

Per body, mirroring today's `rewriteDeque` but keyed on the classification and extended:

- **`let name = init`**, `name ∈ localDeque`, `ty.kind==="vec"`: set `ty.deque=true`.
  Wrap `init` in `deque_from_vec` **only if `init` is not already a deque value**
  (`!exprIsDeque(init)`) — so `const a = [1,2,3]` wraps, but `const x = f()` (f returns
  a `VecDeque`) and `const b = a` (a already deque) do **not** double-wrap.
- **param** `i ∈ paramDeque(fn)`, `ty.kind==="vec"`: set `ty.deque=true`. No construction
  (params aren't constructed); the caller passes a deque. The borrow (`&`/`&mut`) is
  decided independently by ownership and is orthogonal — flipping the element container
  from `Vec<T>` to `VecDeque<T>` under an existing `&mut` param yields `&mut VecDeque<T>`
  for free.
- **ret** of a `retDeque` fn, `ty.kind==="vec"`: set `ret.deque=true`.
- **mutating methods / `arrayMutLen` / `splice`** on any deque receiver (now including a
  deque **param**, not just a `let`): as today (`push_back`/`pop_back`/`pop_front`/
  `push_front`/`deque_splice`).

### Part 3 — Vec-only op interop (residual #2)

When a Vec-only op has a **deque receiver**, route through the existing helpers:

- **`iterSortDefault` / `iterSortBy`** (in-place): add an optional `deque?: boolean` flag;
  `refineDeque` sets it when the receiver is a deque binding. The emitter branches:
  - deque → `tslib::array::sort_default(tslib::array::deque_as_slice_mut(&mut recv))`
  - else → `tslib::array::sort_default(&mut recv)` (unchanged).
  This requires `sort_default`/`sort_by` to accept **`&mut [T]`** instead of `&mut Vec<T>`
  — slices have `sort_by`, and an existing `&mut Vec<T>` call site coerces to `&mut [T]`
  unchanged, so the Vec path is byte-compatible while the deque path passes the
  `make_contiguous()` slice.
- **`join` / `concat` / `flat`** (`call` to `tslib::array::{join,concat,flat}`): when the
  receiver arg (`recvRef`) is a deque binding, wrap its inner expr in
  `tslib::array::deque_to_vec(&recv)` while keeping the outer `borrow:"ref"`, emitting
  `&tslib::array::deque_to_vec(&recv)` — a `&Vec<T>` that coerces to `&[T]`. A `concat`
  **argument** that is itself a deque is wrapped the same way. The result of these ops is
  a fresh `Vec` (unchanged) — if that result binding is itself front-mutated, the
  classifier makes it a deque and `deque_from_vec` wraps it, consistently.

### Part 4 — multi-arg push / unshift

Generalize `arrayMutLen` from a single `arg` to `args: HirExpr[]`, and let
`tryArrayMutStatement` accept `args.length >= 1`:

- **statement `a.push(x, y)`** → two bare `push` methods (in order); `a.unshift(x, y)`
  → JS inserts the group at the front preserving order (`[x, y, …orig]`).
- **value `const n = a.push(x, y)`** → `{ a.push(x); a.push(y); a.len() as f64 }`.
- On a **deque** receiver: `push`→`push_back` (in order); `unshift(x, y)` → `push_front`
  in **reverse** (`push_front(y); push_front(x)`) so the front ends up `[x, y, …]`,
  matching JS. This reversal is `refineDeque`'s job (it owns the deque method retarget).

## Scope

- **In:** whole-module deque classification with `arg→param`, `param→arg`, `return`, and
  alias propagation to a fixpoint (free fns fully; methods name-keyed with the documented
  limitation); param/ret type flips; Vec-only op interop (`sort`/`join`/`concat`/`flat`)
  via the existing helpers; multi-arg `push`/`unshift`. Differential + `cargo`-compiled
  specs (`vecdeque-interop.test.ts`).
- **Out (stay fail-loud, cargo-loud never silent):** a genuinely unresolvable name-keyed
  method-param collision across classes (same limit as ownership); a Vec-only op with **no**
  clean conversion path (none known in this surface). Nothing in #101's stated surface is
  deferred.

## Risks

- **Classifier soundness is the crux** (as 116 flagged). Under-classification (used as
  deque, emitted `Vec`) → cargo rejects (loud, invariant holds). Over-classification →
  only an interop-helper cost. The fixpoint + a spec matrix (arg, backward-param, return,
  alias, chained) pins it.
- **Backward propagation (edge 2)** is the novel piece vs ownership (which only forward-
  requires `&mut`). A param that is deque forces every caller's arg binding to a deque —
  a mis-scan here would wrongly promote an unrelated binding. Guard: only promote a
  **bare-ident** arg (not an arbitrary expr), matching how the `let`/construction rewrite
  is name-anchored.

## Corpus

Per the corpus-coverage rule, add a workload fixture exercising a front-mutated queue
threaded through a free function and then sorted/joined (the combined cross-boundary +
interop path), plus each guard's negative/character­ization case in the spec file.

## Results (2026-07-24)

Shipped. `vecdeque-interop.test.ts` **16/16** green (cargo + differential).

- **`refineDeque` is now whole-module two-phase** (`src/deque.ts`): a `classify`
  call-graph fixpoint (`paramDeque`/`retDeque`/`localDeque`) followed by
  `rewriteBody` + `applyParamRetTypes`. A deque **param** is mirrored into its body's
  `localDeque` so intra-body forwarding/return/alias edges see it; `applyParamRetTypes`
  descends through `ref` wrappers (`dequeableVec`) to flip a borrowed `&mut Vec<T>`
  param to `&mut VecDeque<T>`. The existing `&`/`&mut` plumbing (ownership) is
  orthogonal — 117 only flips the element container on both ends of a call.
- **Interop** (`sort`/`join`/`concat`/`flat`): `iterSortDefault`/`iterSortBy` gained a
  `deque` flag → emitter routes through `tslib::array::deque_as_slice_mut`;
  `sort_default`/`sort_by` relaxed to `&mut [T]` (a `&mut Vec` caller coerces
  unchanged). `join`/`concat`/`flat` wrap a deque arg in `deque_to_vec(&d)` (a `&Vec<T>`
  that coerces to `&[T]`).
- **Multi-arg push/unshift**: `arrayMutLen` generalized `arg` → `args[]` (emitter loops);
  `tryArrayMutStatement` accepts `>= 1` args, reversing `unshift`'s so the `push_front`
  sequence lands JS order; `refineDeque` reverses a multi-arg value-form `push_front`.
- **Corpus:** `benchmarks/corpus/queue.ts` — a 2M-round front-mutated work-queue churn
  (the VecDeque O(1) front-op happy-path), auto-discovered by the bench harness.

### Scoped out (confirmed pre-existing, not a 117 regression)

- **Transitive `refMut` through a 2-hop call** — `function outer(q) { inner(q) }` where
  `inner` mutates `q` emits `outer(q: &Vec)` + `inner(&mut q)` (broken) **with zero deque
  involvement**. This is an *ownership* propagation gap, orthogonal to container class;
  VD5 was reframed to a **read-only** 2-hop forward chain (which compiles via `&&T → &T`
  deref coercion) so it exercises deque forwarding without conflating the ownership gap.
  Filed as a follow-up (see the issue).
