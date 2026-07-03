# 018 — Specs

Unit specs drive the public `emit(...)` entry (parse → lower → emit → Rust
string) and assert that an own `continue` in a C-style `for` runs the `update`
before continuing, `break` is unchanged, and the deferred/green cases hold. The
cargo-backed BEHAVES proof lives in the differential tests. IDs are referenced
from the test files.

## Unit — for-continue via `emit` (`tests/for-continue.test.ts`)

Reference shape (a fn wrapping the loop so it is a complete item):
```ts
function run(): number {
  let sum: number = 0;
  for (let i = 0; i < 5; i = i + 1) {
    if (i === 2) { continue; }
    sum = sum + i;
  }
  return sum;
}
```

- **FORCONT1** an own `continue` inlines the `update` before it — the `update`
  `i = i + 1;` appears at both the `continue` site and the loop bottom.
  emitted Rust contains `continue;` and `i = i + 1;` occurs at least twice.

- **FORCONT2** a `break` in the same `for` stays a bare `break` (exits the loop).
  `function run(): number { let s: number = 0; for (let i = 0; i < 9; i = i + 1)
  { if (i === 4) { break; } if (i === 2) { continue; } s = s + i; } return s; }` →
  contains `break;`.

- **FORCONT3 (green control)** a `for` without a `continue` is unchanged — the
  `update` appears exactly once.
  `function run(): number { let s: number = 0; for (let i = 0; i < 3; i = i + 1)
  { s = s + i; } return s; }` → `i = i + 1` occurs exactly once.

- **FORCONT4** a `for` with **no** `update` but a `continue` no longer throws
  (nothing to skip — `continue` was already sound).
  `function run(): number { let s: number = 0; let i: number = 0; for (; i < 3;)
  { i = i + 1; if (i === 2) { continue; } s = s + i; } return s; }` →
  `emit(...)` does not throw.

## Oracle — differentials (`tests/compiler.test.ts`)

- **Tier 2 (BEHAVES) — mixed break + continue:**
  ```ts
  function pick(): number {
    let sum: number = 0;
    for (let i = 0; i < 6; i = i + 1) {
      if (i === 3) { break; }
      if (i === 1) { continue; }
      sum = sum + i;
    }
    return sum;
  }
  console.log(pick());
  ```
  → Rust stdout equals the TS stdout (`2`).

- **Tier 2 (BEHAVES) — nested for/for, each with its own continue (barrier):**
  ```ts
  function count(): number {
    let k: number = 0;
    for (let i = 0; i < 3; i = i + 1) {
      for (let j = 0; j < 3; j = j + 1) {
        if (j === 1) { continue; }
        k = k + 1;
      }
      if (i === 0) { continue; }
      k = k + 10;
    }
    return k;
  }
  console.log(count());
  ```
  → Rust stdout equals the TS stdout (`26`) — the inner `continue` advances `j`,
  the outer `continue` advances `i`, each independently (the barrier holds through
  the real compiler).
