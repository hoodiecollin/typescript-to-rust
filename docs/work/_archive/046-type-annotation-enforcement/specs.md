# 046 — specs

Prefix `TYP`. Each slice carries at least one fail-loud spec; complete programs
assert their differential (compiled-and-run) behaviour.

## 046a — untyped scalar bindings (`packages/compiler/tests/type-annot-bindings.test.ts`)

- **TYP1** `const n = 5; console.log(n)` → runs, prints `5`; emitted `let n`
  carries no type annotation (Rust infers `f64`).
- **TYP2** `const s = "hi"; console.log(s)` → `hi`; untyped string binding lowers
  (`String`).
- **TYP3** `const b = true; console.log(b)` → `true`; untyped boolean binding
  lowers (`bool`).
- **TYP4** (fail-loud) `const x = f();` (non-literal call initializer, no
  annotation) → `UnsupportedError`.
- **TYP5** (fail-loud) `const x = a + b;` (binary-expression initializer) →
  `UnsupportedError`.
- **TYP6** (fail-loud) `const x = -5;` (unary-negative initializer) →
  `UnsupportedError`.
- **TYP7** (fail-loud) `const x = null;` and `const y = undefined;` →
  `UnsupportedError` (non-trivial; annotate).
- **TYP8** numeric interaction: `const i = 0; const arr = [10, 20]; console.log(arr[i])`
  → `10`; the untyped trivial-literal `i` still refines to `usize` and indexes
  (emitted `i` is `usize`), proving the gate leaves `ty = null` for `numeric.ts`.

## 046b — homogeneous scalar arrays (`packages/compiler/tests/type-annot-arrays.test.ts`)

- **TYP9** `const xs = [1, 2, 3]; console.log(xs.length)` → `3`; untyped number
  array lowers to `Vec<f64>` (`vec![1.0, 2.0, 3.0]`).
- **TYP10** `const ss = ["a", "b"]; console.log(ss[0])` → `a`; untyped string
  array → `Vec<String>`.
- **TYP11** `const bs = [true, false]; console.log(bs.length)` → `2`; untyped bool
  array → `Vec<bool>`.
- **TYP12** (fail-loud) `const xs = [];` (empty array, ambiguous element) →
  `UnsupportedError`.
- **TYP13** (fail-loud) `const xs = [1, "a"];` (mixed/heterogeneous array) →
  `UnsupportedError`.
- **TYP14** (fail-loud) `const xs = [[1, 2], [3]];` (non-scalar element) →
  `UnsupportedError`; likewise `const xs = [f(), g()];` (non-literal elements).

## 046c — mandatory return types (`packages/compiler/tests/type-annot-returns.test.ts`)

- **TYP15** (fail-loud) `function f(x: number) { return x; }` (missing return
  type) → `UnsupportedError` (no longer a silent `-> ()`).
- **TYP16** explicit `: void` still lowers: `function log(x: number): void { console.log(x); }`
  emits `-> ()` and runs.
- **TYP17** annotated return still works (regression): `function f(x: number): number { return x; } console.log(f(2))`
  → `2`.
- **TYP18** (fail-loud) a method with no return type — `class C { m(x: number) { return x; } }`
  → `UnsupportedError` (`lowerMethod` flip).
- **TYP19** (fail-loud) a `const`-bound arrow with no return type —
  `const f = (x: number) => x;` → `UnsupportedError` (routes through
  `lowerFunction`).
- **TYP20** an annotated arrow still lowers: `const f = (x: number): number => x; console.log(f(3))`
  → `3`.
