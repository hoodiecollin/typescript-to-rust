# 089 — `@t2r/std` `rng(seed)` shim — specs

Spec prefix **RNG**. Differential (TS-via-Bun vs Rust-run stdout) + shape
(emitted-Rust substring) + fail-loud (throws with the redirect message). All
programs `import { rng } from "@t2r/std"`; the harness resolves the workspace
package under Bun so the SplitMix64 reference stream matches the emitted
`tslib::rng` stream bit-for-bit. Test file:
`packages/compiler/tests/rng-shim.test.ts`.

The differential assertion is the whole point: every non-fail-loud spec asserts
`rust.stdout === runTs(src)` (identical stream), and pins an `expected` literal so
the algorithm itself is nailed down (a change to the constants would break it).

## Construction & `next()`

- **RNG1** — `const r = rng(42); console.log(r.next());` → the first SplitMix64
  draw for seed 42 (differential; emits `tslib::rng::Rng::new`).
- **RNG2** — two draws differ and are reproducible:
  `const r = rng(42); console.log(r.next()); console.log(r.next());` →
  two distinct floats in [0,1) (differential).
- **RNG3** — same seed ⇒ same stream: two handles `rng(7)` and `rng(7)` each
  drawn once print the **same** value (differential; determinism pinned).
- **RNG4** — different seeds ⇒ different first draw: `rng(1)` vs `rng(2)` first
  draws differ (differential).
- **RNG5** — an aliased import (`import { rng as makeRng }`) still routes
  (recognition is by specifier, not name): `makeRng(3).next()` (differential;
  emits `tslib::rng::Rng::new`).

## `int(min, max)` — half-open [min, max)

- **RNG6** — bounded integer: `const r = rng(9); console.log(r.int(0, 6));` → an
  integer in [0,6) (differential; the exact value is pinned).
- **RNG7** — sequence of draws is reproducible: `const r = rng(9); for (let i=0;
  i<5;i++) console.log(r.int(0, 100));` → five integers, identical under Bun and
  Rust (differential).
- **RNG8** — `int` consumes the same stream as `next`: interleaving
  `r.next()` then `r.int(0,10)` advances the shared state (differential — the
  second draw reflects the first having advanced state).

## `pick<T>(arr)` — uniform element

- **RNG9** — pick from a string array: `const r = rng(5); console.log(r.pick(["a",
  "b","c","d"]));` → one element, identical both sides (differential; emits
  `.pick(&`).
- **RNG10** — pick from a number array: `rng(5).pick([10,20,30])` → one element
  (differential).
- **RNG11** — pick from an array of a modeled struct, then read a field:
  `const p = r.pick(points); console.log(p.x);` → identical (differential;
  confirms `T: Clone` element flow through the handle).

## `shuffle<T>(arr)` — Fisher–Yates, new array

- **RNG12** — permutation is reproducible and identical both sides:
  `const r = rng(11); console.log(r.shuffle([1,2,3,4,5]).join(","));` → one
  permutation string, identical under Bun and Rust (differential; emits
  `.shuffle(&`).
- **RNG13** — `shuffle` does **not** mutate its argument: `const a=[1,2,3];
  const b=r.shuffle(a); console.log(a.join(","), b.join(","));` → `a` stays
  `1,2,3` (differential; returns a new array).
- **RNG14** — same seed ⇒ same permutation: two `rng(11)` handles shuffle the
  same array to the **same** result (differential; determinism pinned).

## Fail-loud (forbid bare `Math.random` + redirect)

- **RNG15** — bare `Math.random()` → throws `UnsupportedError` mentioning `rng`
  and `@t2r/std`.
- **RNG16** — bare `Math.random` as a value (uncalled, e.g. assigned) → throws
  mentioning `rng` and `@t2r/std`.
- **RNG17** — an unknown method on an rng handle
  (`const r = rng(1); r.bytes(4);`) → throws mentioning only
  `next`/`int`/`pick`/`shuffle` are available.
- **RNG18** — `rng` remains subject to the 084 guards: `import { rng } from
  "elsewhere"` is not recognized (throws — only `@t2r/std` is recognized), and an
  unknown `@t2r/std` name still throws (covered by STD15/STD16; re-assert `rng`
  specifically is only routed from `@t2r/std`).
