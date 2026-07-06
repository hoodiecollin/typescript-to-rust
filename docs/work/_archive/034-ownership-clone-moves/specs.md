# 034 specs — use-after-move → `.clone()`

Transcribed as BDD tests in `packages/compiler/tests/ownership-clone.test.ts`
(differential: emitted Rust compiles **and** its stdout matches the Bun-run TS).

1. **A `String` moved into a `let`, then reused, is cloned.**
   `const a = "hello"; const b = a; log(a); log(b)` → both print `hello`; emitted
   Rust contains `a.clone()`.
2. **A `Vec` moved into a `let`, then reused, is cloned.**
   `const xs = [1,2,3]; const ys = xs; log(xs.length); log(ys.length)` → `3\n3`.
3. **The last use is NOT cloned (no needless clone).**
   `const a = "x"; const b = a; log(b)` → Rust has no `a.clone()` and contains
   `= a;` (bare move).
4. **An owned argument moved then reused is cloned.**
   `function take(s: string){} take(s); log(s)` — `take` ignores its param so it
   takes ownership; the reuse forces a clone at the call site. Prints `hi`.
5. **Two moves of the same binding clone all but the last.**
   `take(s); take(s); log(s.length)` → both calls clone, final use is bare; `2`.

All five green; full suite 329 pass / 1 todo / 0 fail at landing.
