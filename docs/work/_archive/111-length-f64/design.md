# 111 — `.length` → `f64` coercion (dialect graduation)

Issue **#88** (the count consumer of the lazy-`split` work), but the fix is a general
**dialect graduation**, not split-specific. **Direction approved by Collin, 2026-07-23**
(the process rule for dialect-surface changes): do the general coercion now, so
`split`'s count consumer falls out for free.

## Problem

`arr.length` / `str.length` lower to a `usize` `.len()` / `.chars().count()`. That is
correct for a **usize** consumer (an array index, a range bound) but wrong for an
**f64** consumer: today

```ts
const n: number = arr.length;   // let n: f64 = arr.len();        ← usize into f64: no compile
return arr.length;              // return arr.len();              ← usize return from f64 fn
return arr.length + 1;          // arr.len() + 1.0                ← usize + f64
```

all emit invalid Rust. So the dialect **forbids** `.length` in a `number` context — the
accepted workaround was to accumulate counts through a `for…of` counter (see the corpus
`histogram`/`sieve` shapes). This also blocks the natural `split`-count consumer
(`const n = s.split(sep).length`), which is why #88 needed it.

## Ruling

A `usize` length in an `f64` context is cast `(… as f64)`. Lossless in practice — an
array/string length past 2⁵³ is unrepresentable in this process — so this sits under the
**same accepted-`i64` posture** as series 103 (documented divergence, no runtime panic).
It is a **representation coercion at the type boundary**, not a new number model:
`number` is still `f64`; `.length` is still a `usize` count; we only insert the cast the
Rust type-checker needs.

### Mechanism (numeric pass, `coerceLenToF64`)

The `len` HIR node gains an emit-only flag `f64?`; the emitter renders `(… as f64)` when
it is set. A new final step of `refineBody` — **after** usize retyping and range
promotion, so the settled `usize` slots are known — sets the flag on every `len` node
that is **not** in a `usize` slot:

- **usize slots (stay a bare `usize`)** — collected via the existing usize machinery:
  - an array **index** argument (`arr[i]`, `arr[arr.length - 1]`);
  - a `usize`-binding initializer / assignment RHS;
  - a `usize`-counter **`forRange` bound** (`for i in 0..arr.len()`);
  - an operand of a comparison against a **`usize` identifier** (an un-promoted
    `while (i < arr.length)`).
- **everything else** is an f64 consumer → `f64: true`.

**Soundness of the bias.** The `usize` set is the authority. A *missed* f64 context only
leaves a program that already did not compile (never a regression); only an *over-broad*
`usize` claim could regress a working index/bound loop — and the `usize` set is exactly
what the existing (already-shipped) index analysis proves. The full compiler suite is the
regression gate (every `.length`-bounded workload — `sieve`, `sort`, `arraypipe`, … —
must stay byte-identical).

Using an emit-only **flag** (not a `cast` wrapper node) matters: a `cast{f64}` over a
`len` would look like series 103b's i64-return **bridge** to `specializeReturnTypes`,
which could strip it and retype the function `-> i64` (breaking `return arr.length`). The
flag is inert to every other pass.

## Scope

- **In:** the `.length` → `f64` coercion for every f64 context (binding, return,
  arithmetic, argument, comparison-vs-fractional). `len.f64` flag + emitter + the
  `coerceLenToF64` numeric step. Differential specs (`length-f64.test.ts`). `dialect.md`
  update (the `.length` restriction is lifted).
- **Out:** any change to what `.length` *returns* (still a char/element count); the split
  count/index/adapter consumers themselves (series 112, which builds on this).

## Follow-on it unblocks

Series 112 — `split`'s **count** consumer (`s.split(sep).length` →
`s.split(sep).count() as f64`) is now byte-identical to a materialized
`parts.len() as f64`, so it can be added to `refineSplitLazy` without inventing a dialect
expansion. (Single-index and adapter/forEach also land in 112.)

## Results

_(filled in after the full suite: every `.length`-bearing workload byte-identical; the
new f64 contexts compile + run identically to node/bun.)_
