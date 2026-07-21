# 106 — Append-assignment → in-place string mutation

Issue **#88** (under perf epic **#86**), sub-task **2a**. Turns the O(n²) rebind form
`s = s + …` into an amortized-O(n) in-place append, the driver of `strbuild`'s
remaining benchmark loss.

## Problem

`benchmarks/corpus/strbuild.ts` builds a string in a loop:

```ts
for (let i = 0; i < 20000; i = i + 1) {
  s = s + "abc" + (i % 10);
}
```

The string-concat lowering (series 080) turns the RHS `+` chain into a `strConcat`
node, and the assignment emits:

```rust
s = format!("{}{}{}", s, "abc", i % 10);   // each iter: alloc |s|+4 buffer, copy all of s
```

Every iteration allocates a **fresh** buffer sized `|s| + k` and copies the entire
accumulated string into it — quadratic total work. A warmed JIT builds the string in a
mutable rope/buffer, so `strbuild` is one of only two workloads TTR loses end-to-end
(steady-state ~135ms vs Bun ~28ms, 0.2×).

Note: Rust's `String` already `impl AddAssign<&str>`, so `s += "abc"` appends in place —
the quadratic cost is **specific** to the `s = s + a + b` *rebind* form that lowers to
`format!`. That form is exactly what this pass targets.

## Ruling

A standalone, pure, idempotent HIR → HIR refinement pass — `refineStrAppend` (mirrors
`refineStrings`/`refineNumerics`/`refineIterFusion`) — that recognizes the **self-append**
shape and rewrites the statement to append the tail parts to the accumulator **in place**.

### Pattern detected

A statement `expr( assign(op: "=", target: ident(S), value: strConcat(parts)) )` where:

- **G1** — `target` is a plain identifier `S` (not a member/index expression).
- **G2** — `parts[0]` is exactly `ident(S)` — the accumulator is the *head* of the chain
  (true string-append semantics), and there is ≥1 tail part.
- **G3** — `S` is an owned, mutable `String` **local** declared by a `let mut S: String`
  in the same body.

Only the head-appended form is rewritten. `s = "x" + s` (prepend) and `s = a + s + b`
(`S` not the head) keep their `format!` — an in-place prepend/splice is not a plain
append, and order of parts is observable.

### Soundness

Under TTR's move-by-default model, any *alias* of `S`'s old value is an independent
`.clone()` buffer (a plain `let t = s` that moved `s` would make `s` dead, so the
existing `format!` form — which also reads `s` — could not have compiled). Therefore
whenever the current `format!` code compiles, `S` is a live owned `String` and mutating
it in place is observationally identical to allocating a new buffer and rebinding.

G3 restricts the rewrite to owned `String` locals, so a `&str` param, a `&mut String`
param, a struct field, or a captured variable is never touched. And Rust's borrow checker
is the backstop: if a live borrow of `S` existed, the emitted `&mut s` (inside `write!`)
would fail to compile rather than silently misbehave.

Output is **byte-identical** to the `format!` form — `write!` uses the same `Display`
formatting for every part.

### Emission

A new HIR expr node `strAppend { target, parts }` (`parts` = the tail, `parts[0]`
dropped). It emits a single `write!`, mirroring the `strConcat` arg convention (a string
literal renders as a bare `&str`, every other part via `emitExpr`):

```rust
write!(s, "{}{}", "abc", i % 10).unwrap()
```

`write!(s, …)` autoref-borrows `s` as `&mut String` and appends through its
`std::fmt::Write` impl (amortized-O(1) push, capacity doubling) — no whole-buffer realloc.
The `Result` is infallible for `String`, so `.unwrap()` never panics. The statement wrapper
adds the trailing `;`.

`write!` needs `std::fmt::Write` in scope → `stdImports` gains a branch:
`usesKind(scan, "strAppend")` ⇒ `use std::fmt::Write;`.

### Pass placement

Inserted into the refine chain after `refineStrings` (binding types are final by then).
It shares no node shapes with `refineIterFusion`, so ordering relative to fusion is free.

## Scope

- **In:** the `s = s + …` self-append rebind (the measured `strbuild` build loop).
- **Out (2c, still deferred):** borrow-yielding `split` — the *scan* half of `strbuild`
  (`s.split("5")` allocating a `Vec<String>` per round). Tracked under #88 as a separate
  increment; unblocked now that #89 landed but not part of this series.

## Results (measured 2026-07-21)

Shipped, correct, byte-identical. Full compiler suite **1354/0** (1347 baseline + 7 new
specs); the `strbuild` correctness gate is byte-identical across node/bun/ttr.

The rewrite fires and even composes with #90 — the strbuild build loop lowers to:

```rust
write!(s, "{}{}", "abc", ((i as i64) % 10) as f64).unwrap();
```

(`use std::fmt::Write;` imported; no `s = format!`.) The O(n²) build is eliminated.

**But `strbuild` stays a benchmark loss** — the *same lesson* `arraypipe` taught: the
headline cost was not where the issue body assumed. Isolating the two halves (release
binaries, min of 12 runs, this machine):

| variant | e2e (min) | note |
|---|---|---|
| build-only (`s = s + …` loop, returns `s`) | **4.6ms** | ≈1ms compute over the 3.6ms startup floor — the loop is now cheap |
| full `strbuild` (build + split/indexOf scan) | **103ms** | ⇒ the split-scan half is **~99ms** |

So 2a did its job — it moved the build from an O(n²) copy to an amortized-O(n) append,
shaving strbuild's **e2e ~138ms → 103ms** and **steady-state ~135ms → 99.4ms**. The
remaining loss (steady **99.4ms** vs Bun 20.2ms, 0.2×) is **entirely** the 300-round
`s.split("5")` loop materializing a `Vec<String>` of ~thousands of one-char heap `String`s
each round — which is exactly **2c (borrow-yielding `split`)**, still deferred under #88.
Flipping `strbuild` to a win requires 2c, not 2a.

**Lesson kept:** measure the halves before claiming a workload is fixed. 2a is a real,
correct O(n²)→O(n) win on the build pattern (and benefits any `s = s + …` accumulator in
real code), but it does not by itself flip `strbuild`.
