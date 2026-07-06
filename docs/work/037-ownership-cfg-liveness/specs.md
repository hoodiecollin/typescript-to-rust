# 037a — Specs: CFG + backward liveness

Differential oracle (compile + stdout match), plus emitted-Rust assertions for
clone *placement*. These are the cases the straight-line `refineMoves` (034)
**cannot** get right — a loop back-edge or a branch join — that the liveness engine
must. All existing `ownership-clone.test.ts` (034) cases stay green (regression).

## Loop-carried moves (the headline — RED = cargo `E0382` today)

- **L1 — owned-arg move inside a `for`, no textual use after.** A `String` passed
  as an owned argument inside a counting `for`, with **no** later textual use of the
  binding. Straight-line sees the single occurrence as a last use → bare move →
  `E0382` on iteration 2. The engine's back-edge makes the binding live at the loop
  bottom → clone at the call site. Compiles **and** behaves.

  ```ts
  function score(s: string): number { return 1; }   // unused param → owned/move
  const s: string = "hi";
  let total: number = 0;
  for (let i = 0; i < 3; i = i + 1) { total = total + score(s); }
  console.log(total);   // → 3
  ```

- **L2 — `let`-alias move inside a `while`.** `const b = s` inside a loop body
  moves `s` each iteration; the engine clones it. Compiles + behaves.

## Branch joins (RED = needless `.clone()` today)

- **B1 — mutually-exclusive branches, move dead after join.** A binding moved in the
  `then` branch and *read* in the `else` branch (mutually exclusive) with no use
  after the join. Straight-line (document order) sees the else-read as a "later
  use" and clones the then-move needlessly. Liveness proves the then-move is dead
  after the join → **no clone**. Assert the emitted Rust has no `.clone()`, and it
  behaves.

- **B2 — move reused after the join → still cloned.** A binding moved in a branch and
  read *after* the join must clone (regression that the join-liveness keeps working).

## Precision / no-regression

- **P1 — straight-line last use stays bare** (034 carried forward): a move that is
  genuinely the last use is not cloned.
- **P2 — straight-line reuse still cloned + behaves** (034 carried forward).
- **P3 — nested loop** exercises the fixpoint: a move inside a doubly-nested loop is
  cloned.

## Fail-loud preserved

- The pass still only *adds* clones. Anything it can't prove stays a bare move that
  cargo rejects loudly — never a wrong value. (No new rejection is introduced; the
  engine strictly *reduces* rejections vs 034.)
