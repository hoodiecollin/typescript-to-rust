# 052 — Generator state machines (yield-in-loop / branch)

Graduates the fail-loud generator residual: a `function*` whose body contains
**loops, branches, or non-`yield` statements interleaved with yields** now
compiles to a resumable **state-machine `struct` + `impl Iterator`**. This is the
real CPS transform 035 deferred — the largest generator investment — and it
introduces a **substantial new subsystem**: intra-function CFG construction plus
**live-variable analysis across yield points**. Per the #19 DECISION (2026-07-07),
Collin chose the full state machine over adapter-chain pattern-matching.

The straight-line finite-yield path (035, `vec![…].into_iter()`) is **not
regressed** — it stays the lowering for its shape; the state machine is only for
the loop/branch shapes it can't express. Pairs with #20 (`yield*` delegation),
which becomes a nested drive of the delegate's iterator inside `next()` — noted
but out of this series' scope.

## Public contract (unchanged)

A generator still lowers to a free `fn` returning `impl Iterator<Item = T>`; the
item type still comes from the `Generator<T>` / `IterableIterator<T>` / `Iterable<T>`
return annotation (`lowerGenerator`, `lower.ts`). Only the *body* of that fn
changes: instead of `return vec![…].into_iter()`, it constructs and returns the
generated state-machine struct:

```rust
fn range(n: f64) -> impl Iterator<Item = f64> { RangeGen::new(n) }
```

Keeping the public shape as `impl Iterator<Item = T>` means the existing `for-of`
consumption path (`lowerForOf`, the `analysis.generators` branch) composes with
**no change** — it already binds `x` by value over `Item = T` and drops `.iter()`.
#20 consumption also composes for free.

## Worked example (052a — the counting loop)

```ts
function* range(n: number): Generator<number> {
  for (let i = 0; i < n; i++) {
    yield i;
  }
}
for (const x of range(3)) { console.log(x); }   // 0 1 2
```

```rust
struct RangeGen { state: u32, n: f64, i: f64 }

impl RangeGen {
  fn new(n: f64) -> Self { RangeGen { state: 0, n, i: 0.0 } }
}

impl Iterator for RangeGen {
  type Item = f64;
  fn next(&mut self) -> Option<f64> {
    loop {
      match self.state {
        0 => { self.i = 0.0; self.state = 1; }          // init
        1 => {                                          // loop test
          if !(self.i < self.n) { self.state = 3; continue; }
          self.state = 2;                               // resume target
          return Some(self.i);                          // ← yield
        }
        2 => { self.i += 1.0; self.state = 1; }         // loop update, back to test
        _ => return None,                               // state 3: done
      }
    }
  }
}
```

`n` (a param) and `i` (a `let` live across the `yield`) become **struct fields**;
`state: u32` is the resume discriminant. `next()` is a `loop { match self.state }`
that runs non-yielding states straight through (`continue` the loop) and `return
Some(v)` at each yield after recording the resume state. The trailing `_ => None`
is the terminal state and makes the match exhaustive.

## The new subsystem: CFG + liveness across yields (`analysis.ts`)

This is the genuinely new machinery. Two passes over a generator body:

1. **CFG construction.** Build a basic-block graph of the body. Blocks split at
   every `yield` (a yield ends a block; its successor is a fresh *resume block*)
   and at every control-flow join (`if`/`else` merge, loop head/back-edge). Loops
   (`for`/`while`) desugar to head-test → body → update → back-edge blocks so a
   `yield` inside the body has a well-defined resume successor.

2. **Live-variable analysis across yield points.** Standard backward liveness
   (`live-in`/`live-out` per block via `use`/`def` sets). The load-bearing query
   is: **is a local live across any `yield`?** — i.e. live-out of a yielding block
   and used in a reachable resume block. **Any local that is live across a yield
   becomes a struct field.** A local never live across a yield stays a plain
   `let` inside its state arm (no field needed).

### What becomes a struct field

| Source | Field? | Reason |
|---|---|---|
| every generator **param** | always | captured at construction (`new`) |
| a `let`/`const` **live across a yield** | yes | must survive suspend/resume |
| a `let`/`const` **not live across any yield** | no | local to one state arm |
| the resume **discriminant** | yes (`state: u32`) | selects the arm on re-entry |

Field types come from the local's lowered `RustType` (the same annotation-driven
typing lowering already does). Params keep their lowered param types.

### State numbering

Number the CFG's *resumption points* — entry, and every block that a `yield`'s
successor can re-enter — as `0, 1, 2, …`, with one reserved **terminal** state
(the last, `_ => None`). Non-resumption blocks are inlined into the arm that flows
into them (they run straight through and `continue`). The numbering is: entry = 0,
each yield's resume target gets the next number, and internal blocks reuse `state`
assignments only where the CFG actually re-enters them. The mapping from
CFG-block → state number is emitted as the `match` arms.

### Capture (params + locals), borrow-safe

Params are moved into the struct in `new(...)` (owned, Option-A). Locals live
across yields are initialized to their lowered init value in the entry arm (or a
type-appropriate placeholder in `new`, overwritten by the init arm — the entry
arm always runs first). Because every carried value lives in the struct by
**value**, there are no borrows spanning a `yield` in the generated code —
suspension is just "return with `self` intact." The one shape that *would* need a
borrow across a suspend (a `&`/`&mut` local held across a yield) is the fail-loud
residual below.

## New HIR + emitter

- **New HIR item `HirGenerator`** (`hir.ts`, added to the `HirItem` union
  alongside `HirFn`/`HirStruct`/…): carries the struct `name`, the item type, the
  ordered `fields` (`{ name, ty }` — params then across-yield locals then `state`),
  the `new` constructor param list, and the ordered `states` (each a state number
  + its lowered `HirStmt[]` arm body, where a `yield e` lowers to a new
  `{ kind: "yieldReturn"; value, resumeState }` HIR stmt → `self.state = k; return
  Some(e);`). The public `fn range(...) -> impl Iterator<…>` wrapper is emitted
  from the same item.
- **Emitter** grows one template: `HirGenerator` → the `struct` + `impl New` +
  `impl Iterator for Name { type Item = …; fn next(&mut self) { loop { match
  self.state { … } } } }` + the wrapper `fn`. Field access inside arms is
  rewritten to `self.<field>` (a carried local `i` prints as `self.i`); non-carried
  locals stay bare `let`.
- **`lower.ts`** — `lowerGenerator` gains a **shape dispatch**: if the body is the
  035 straight-line all-`yield` sequence, keep the existing `vec![…].into_iter()`
  lowering unchanged; otherwise run the CFG/liveness passes and build a
  `HirGenerator`. The 035 early-outs (missing annotation, missing item type, no
  body, `yield*`, bare `yield`) stay as-is.
- **`validate.ts` / `dialect.md`** — relax the "body is not a straight-line
  sequence of `yield`" rejection: loops, `if`/`else`, and blocks around yields are
  now MODELED; update the Generators table. The residuals below stay listed.

## Slices (each lands green)

1. **052a — single counting loop.** A `for (…) yield i` (and the `while`
   equivalent) → struct + `impl Iterator`. Establishes the whole subsystem: CFG,
   liveness (`i`, `n` → fields), state numbering, the `next()` template, the
   wrapper fn. Differential: `for-of` over `range(n)` yields the right sequence.
2. **052b — conditional / branch yields.** `if (p) yield a; else yield b;` and a
   `yield` guarded by an `if` inside a block. Adds branch blocks to the CFG (join
   nodes, branch-selected resume states); confirms a local live only on one branch
   is carried correctly.
3. **052c — interleaved / multiple loops + non-yield statements.** A generator
   with a pre-loop statement, two sequential loops, and a local accumulator
   mutated across yields (`let sum = 0; for (…) { sum += i; yield sum; }`). Stress
   test for across-yield liveness of a mutated accumulator and for state numbering
   across multiple loop regions.

## Fail-loud residuals (stay `UnsupportedError`)

- **A reference held across a yield point** — a `&`/`&mut` local (e.g. a borrow of
  a param or of an element) that is live across a `yield`. Carrying it in the
  struct would require a self-referential / lifetime-bearing generator struct,
  which the owned Option-A model doesn't express. This is the hard borrow case;
  it stays fail-loud (the user rebinds to an owned/index value).
- **Nested `try` across yields** — a `yield` inside a `try`/`catch` (suspension
  across an unwinding scope) has no clean state-machine encoding here; stays
  fail-loud.
- **Unchanged from 035:** async generators (`async function*` → `Stream`, out of
  std) and generator methods / expressions stay `DialectError`; `yield*`
  delegation, bare `yield`, and un-annotated generators stay their existing
  residuals (`yield*` graduates with #20).

## Relationship to #20

`yield*` delegation (#20) rides this state machine: a `yield* inner()` becomes a
**nested drive of the delegate's iterator inside `next()`** — a state that holds
the delegate iterator as a field and pumps `self.inner.next()` until exhausted
before advancing. Coupled/adjacent; designed in its own series once 052 lands.
