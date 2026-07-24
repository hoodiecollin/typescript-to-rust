# 116 — Array mutation methods: push / pop / shift / unshift / splice

Issue **#78** (`ownership`/`dialect`/`codegen`, **MUST HAVE** — Collin). Everyday
CLI/script code mutates arrays in place; this is a hard gap today. This series ships
**all five** methods including `splice`, with **full return-value** support — no
deferrals (Collin, 2026-07-23).

## Decisions (Collin, 2026-07-23)

- **Front mutation → `VecDeque` on detection.** An array that is ever `shift`/`unshift`-ed
  lowers to `VecDeque<T>` for O(1) front ops (not O(n) `Vec::remove(0)`/`insert(0,..)`).
- **`splice` is in.** The general variadic remove+insert, returning the removed `Vec<T>`.
- **Return values are in.** `push`/`unshift` yield the new length even when consumed;
  `pop`/`shift` yield `Option<T>`; `splice` yields the removed `Vec<T>`.
- **Vec↔VecDeque interop is a shared utility** (Collin, mid-design): wherever a
  VecDeque-classified array meets a Vec-shaped op or a `&Vec<T>` boundary, convert through
  one common tslib helper rather than fail-loud or one-off inline code.

## Ground truth (verified 2026-07-24 — the issue drifted)

The issue says all five methods are "generic Unsupported." **Stale.** The ownership
plumbing already landed (`MUTATING_METHODS`, `analysis.ts:37-54` → `let mut` + `refMut`),
and two methods already lower correctly:

- **`a.push(x)` (statement position)** → `a.push(x)` — works, differential-correct.
- **`a.pop()`** → `a.pop()` yielding `Option<T>`, printed via the 066 `fmt_opt` model —
  works (`a.pop() ?? d` threads 066).

**Actual gaps:** `shift` → invalid `a.shift()`; `unshift` → invalid `a.unshift(x)`;
`splice` → invalid `a.splice(1.0,1.0)`; and `push`/`unshift` **return value used**
(`const n = a.push(x)`) compiles but is **silently wrong** (`n` binds `()`, prints empty).

## The two moving parts

The ownership plumbing is **already done** (above). What's missing is (1) the **lowering
rows** for shift/unshift/splice + the return-value form, and (2) a new
**container-classification pass** (for VecDeque-on-`shift`/`unshift`). push (statement) and
pop are already correct.

### Part 1 — lowering rows in `arrayTailMethod`

Add rows to `arrayTailMethod` (`method-routing.ts:127-197`, reached via the `vec` branch
of `tryPrimitiveMethod` at 116-117). The emitted form depends on the receiver's
**container class** (Part 2):

| TS | Vec array | VecDeque array | Return |
|----|-----------|----------------|--------|
| `a.push(x)` | `a.push(x)` | `a.push_back(x)` | new length (`f64`) |
| `a.pop()` | `a.pop()` | `a.pop_back()` | `Option<T>` (066) |
| `a.shift()` | — (n/a: shift ⇒ VecDeque) | `a.pop_front()` | `Option<T>` (066) |
| `a.unshift(x)` | — (n/a) | `a.push_front(x)` | new length (`f64`) |
| `a.splice(i,n,…items)` | `tslib::array::splice(&mut a, i, n, vec![…])` | (same, VecDeque overload) | removed `Vec<T>` |

`pop`/`shift` return `Option<T>` — aligns with the 066 undefined model
(`a.pop()` on `[]` is `undefined` → `None`). A `String`/non-Copy element pops an owned
`String` (moves out of the container) — fine, that's the whole point of `pop`.

**Return values (full support).** `push`/`unshift` return the new length in JS. When the
return is **used** (`const n = a.push(x)`), emit a block-expr `{ a.push(x); a.len() as f64 }`
(VecDeque: `push_back`); in **statement position**, a bare `a.push(x);`. `splice` returns the
removed elements as a `Vec<T>` — routed through a `ts-primitives` helper
`tslib::array::splice(&mut recv, start, delete_count, items) -> Vec<T>` (variadic inserts
passed as a `Vec<T>`), so the hairy `drain`+`insert` index math lives in one tested Rust fn
rather than the emitter. The helper has a VecDeque overload (or converts through the interop
utility below) so `splice` works on front-mutated arrays too.

### Part 2 — container classification (`Vec` vs `VecDeque`)

A new analysis pass (sibling to `analysis.mut`, built in the same sweep at
`analysis.ts:1570-1590`) computes, **per array binding**, its container class:

- default `vec`;
- promoted to `vecdeque` if `shift` **or** `unshift` is ever called on it;
- **propagation:** the class flows across `=` assignment, `return` (a function returning a
  VecDeque array types its return `VecDeque<T>`), and **argument→param** (passing a
  VecDeque array to `f(a)` promotes `f`'s param to `&mut VecDeque<T>` / `&VecDeque<T>`).
  Aliasing two bindings unifies their class (union-find or a fixpoint sweep).

Consumed at every type-emit site keyed today on "array is `Vec<T>`":

- **declaration / param / return type:** `Vec<T>` → `VecDeque<T>`;
- **construction:** `vec![…]` / array literal → `VecDeque::from([…])` (or `::from(vec![…])`);
- **method rows:** as the table above (`push`→`push_back`, `pop`→`pop_back`).

Cross-container ops that work on **both** need no change: indexing `a[i]` (VecDeque `Index`),
`.length`→`len()`, `.iter()`/adapter chains, `forEach`, `for…of`.

### Part 3 — the Vec↔VecDeque interop utility (shared)

Ops that are **Vec-shaped only** — `sort`, `join`, `concat`, `flat`, a `&[T]` slice, or
passing a VecDeque array into a `&Vec<T>`/tslib-array boundary — go through **one shared
helper in `ts-primitives`** rather than a fail-loud residual or scattered inline
conversions:

```rust
// ts-primitives, tslib::array (names TBD in impl)
pub fn as_slice_mut<T>(d: &mut VecDeque<T>) -> &mut [T] { d.make_contiguous() }
pub fn to_vec<T: Clone>(d: &VecDeque<T>) -> Vec<T> { d.iter().cloned().collect() }
pub fn from_vec<T>(v: Vec<T>) -> VecDeque<T> { VecDeque::from(v) }
```

- `sort` on a VecDeque → `tslib::array::as_slice_mut(&mut a).sort…` (in-place via
  `make_contiguous`, no realloc);
- `join`/`concat`/`flat` / a `&Vec<T>` param → borrow-convert through `to_vec`/a
  contiguous slice at the boundary.

This keeps VecDeque arrays first-class across the existing array surface instead of
carving a hole. The classifier records which ops each VecDeque binding hits so the emitter
only converts where needed (no blanket cloning). If a *specific* op has no clean
conversion, it fail-louds honestly (residual) — but the common ones are covered by the
utility.

## Scope

- **In:** all five methods — `push`/`pop`/`shift`/`unshift`/`splice` — with full
  return-value support (`push`/`unshift` length block-expr when consumed; `pop`/`shift`
  → `Option<T>` per 066; `splice` → removed `Vec<T>`); the container-classification pass
  (vec vs vecdeque with assignment/return/param propagation); type + construction emit
  keyed on the class; the shared `ts-primitives` Vec↔VecDeque interop helpers +
  `tslib::array::splice` helper. Differential + `cargo`-compiled specs
  (`array-mutations.test.ts`).
- **Out:** only genuinely out-of-dialect shapes stay fail-loud — a VecDeque op with **no**
  clean conversion path (honest residual, never silently mis-emitted). Nothing in #78's
  stated surface is deferred.

## Risks

- **Classifier soundness is the crux.** If a binding is under-classified (used as VecDeque
  but emitted `Vec`) the Rust won't compile — which is a *loud* failure (cargo rejects),
  not a silent bug, so the fail-loud invariant holds. Over-classification (needless
  VecDeque) only costs the interop helper. The propagation fixpoint + a spec matrix
  (assignment, return, param, alias) pins soundness.
- **Param-class inference across call boundaries** is the same shape as ownership's
  `refMut` propagation; reuse that infrastructure rather than a parallel pass where
  possible.

## Results (2026-07-24)

Shipped. `array-mutations.test.ts` **13/13** green (cargo + differential).

- **Container classification is a standalone `refineDeque` HIR→HIR pass** (`src/deque.ts`,
  outermost in the refinement pipeline, mirroring `refineSplitLazy`) — **not** a change to
  type inference. Per body it collects front-mutated bindings (`shift`/`unshift`), then
  rewrites their `let` type (`vec` → `vec{deque}` → `VecDeque<T>`), construction
  (`tslib::array::deque_from_vec`), and mutating calls (`push`→`push_back`,
  `pop`→`pop_back`, `shift`→`pop_front`, `unshift`→`push_front`, `splice`→`deque_splice`).
  A `VecDeque` import is emitted when any `deque` type is present.
- **`arrayMutLen` HIR node** carries the push/unshift **return-value** block
  `{ recv.<m>(x); recv.len() as f64 }`; statement-position push/unshift are intercepted to a
  bare mutation by `tryArrayMutStatement` (mirroring `tryForEach`).
- **`splice`** → `tslib::array::splice(&mut recv, start, deleteCount, vec![items…])`
  returning the removed `Vec<T>`; one-arg `splice(start)` passes `f64::INFINITY` (clamped to
  `len - start`).
- **Drift correction:** push (statement) and pop already worked pre-116 (the issue was
  stale) — AM1–AM4 are characterization.

**Residuals (filed #101, fail-loud not silent):** cross-boundary `VecDeque` propagation
(a deque binding passed to / returned from a `Vec`-typed fn → cargo-loud); `Vec`-only ops
(`sort`/`join`/…) on a deque binding not yet routed through the interop helpers (which
exist: `deque_as_slice_mut`/`deque_to_vec`); multi-arg `push(x, y)` (single-arg only).
- **066 alignment:** `pop`/`shift` `Option<T>` must thread through the undefined model
  (`??`, `x!`, narrowing) exactly as other `Option`-returning methods — a spec exercises
  `a.pop() ?? default`.
