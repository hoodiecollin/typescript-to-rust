# 052 — specs

Spec-ID prefix `GEN`. Differential specs run the TS (via Bun) and the emitted
Rust and compare stdout — the state machine must produce the **same yield
sequence** the generator does. The 035 straight-line path must stay green
(regression guard) — the state machine is dispatched only for loop/branch shapes.

## 052a — single counting loop (`packages/compiler/tests/generator-loop.test.ts`)

- **GEN1** (differential) a counting-loop generator consumed by `for-of` yields
  the right sequence:
  ```ts
  function* range(n: number): Generator<number> {
    for (let i = 0; i < n; i++) { yield i; }
  }
  for (const x of range(3)) { console.log(x); }   // 0, 1, 2
  ```
  Emitted Rust contains a generated `struct` with a `state: u32` field and an
  `impl Iterator for` … `fn next(&mut self)` with a `match self.state`; the
  wrapper `fn range` still returns `impl Iterator<Item = f64>`.
- **GEN2** (differential) the `while`-loop equivalent produces the same sequence
  (confirms the CFG desugars `while` the same as `for`).
- **GEN3** an empty range (`range(0)`) yields nothing — the loop-test state goes
  straight to the terminal `_ => None` (differential: no output).
- **GEN4** the across-yield local `i` and the param `n` both appear as **struct
  fields** (`self.i`, `self.n` in `next()`); a local used only inside one state
  arm (not live across a yield) stays a bare `let`.

## 052b — conditional / branch yields (`packages/compiler/tests/generator-branch.test.ts`)

- **GEN5** (differential) a conditional-yield generator picks the right branch:
  ```ts
  function* pick(p: boolean): Generator<number> {
    if (p) { yield 1; } else { yield 2; }
  }
  for (const x of pick(true)) { console.log(x); }    // 1
  for (const x of pick(false)) { console.log(x); }   // 2
  ```
  Branch selection routes to distinct resume states.
- **GEN6** (differential) a `yield` guarded inside an `if` within a loop
  (`for (…) { if (i % 2 === 0) yield i; }`) yields only the passing elements.
- **GEN7** a local live on only one branch is carried correctly (differential: the
  branch that defines it produces the right value; the other branch never reads it).

## 052c — interleaved / multiple loops (`packages/compiler/tests/generator-interleaved.test.ts`)

- **GEN8** (differential) a mutated accumulator carried across yields:
  ```ts
  function* sums(n: number): Generator<number> {
    let sum = 0;
    for (let i = 0; i < n; i++) { sum += i; yield sum; }
  }
  for (const x of sums(4)) { console.log(x); }   // 0, 1, 3, 6
  ```
  `sum` and `i` are both across-yield fields; state numbering threads the update.
- **GEN9** (differential) two sequential loops in one generator yield the
  concatenated sequence (confirms state numbering across multiple loop regions and
  a non-yield statement between them).

## 052d — fail-loud residuals (`packages/compiler/tests/generator-failloud.test.ts`)

- **GEN10** (fail-loud) a **reference held across a yield** is rejected with
  `UnsupportedError` — e.g. a `&`/`&mut` local bound before a `yield` and read
  after it (the hard borrow case; the struct can't carry a lifetime-bearing ref).
- **GEN11** (fail-loud) a `yield` inside a `try`/`catch` (nested `try` across
  yields) stays `UnsupportedError`.
- **GEN12** (regression) the 035 straight-line finite generator
  (`yield 1; yield 2; yield 3;`) still lowers to `vec![…].into_iter()` — **not** a
  state machine — and stays green.
