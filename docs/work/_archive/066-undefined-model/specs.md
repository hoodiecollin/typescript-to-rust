# 066 — Specs: first-class `undefined`/`null` as `Option<T>`

BDD scenarios for the undefined/null absence model (design decisions A–F). Each
scenario has a stable ID and maps to the design's specs sketch + impl sequence.
Behavioral specs differential-match (compile → `cargo run` stdout == TS-via-Bun
stdout); shape specs pin the emitted Rust; fail-loud specs assert `UnsupportedError`.

The partial `Option` machinery from series 042 (`T | undefined` → `Option<T>`, `??`
→ `unwrap_or`, `!== undefined` narrowing → `if let Some`, `Some`/`None` boundary
wrapping) is **reused**; these specs extend it to close the 066 gaps: print render,
JS-truthiness (`||`/`&&`/`if`/`!`), default params, `x!`, the both-present 056
warning, and the fail-loud arithmetic guard.

## A · Representation & print (decisions A, C-print)

- **UND1** `let x: number | undefined = undefined; console.log(x)` prints the literal
  `undefined` (canonical `None` spelling). Differential-matches JS.
- **UND2** `let x: number | undefined = 5; console.log(x)` prints `5` — a `Some(v)`
  unwraps to the `v` render, not `Some(5)`. Differential-matches JS.
- **UND3** `null` and `undefined` both denote `None`: `let a: string | null = null`
  and `let b: string | undefined = undefined` each print `undefined`. (Collapse.)
- **UND4** A present string `let s: string | undefined = "hi"; console.log(s)` prints
  `hi` (no quotes), matching JS `console.log`.
- **UND5** Mixed print: `console.log("v:", x)` with `x: number|undefined = undefined`
  prints `v: undefined`; with `x = 3` prints `v: 3`.

## B · Coercion sites (decision D)

- **CO1** `x ?? 0` (nullish) → `x.unwrap_or(0.0)`; `None` yields `0`, `Some(v)` yields
  `v`. Differential-matches JS `??`. (Regression: series 042 already green.)
- **CO2** `x ?? d` is **absence-only**: `let x: number | undefined = 0; console.log(x ?? 9)`
  prints `0` (present `0` is not absence), matching JS.
- **CO3** `x!` (non-null assertion) on a `Some` → `.unwrap()` yielding the inner `T`:
  `let x: number | undefined = 5; const n: number = x!; console.log(n)` prints `5`.
  Emitted shape contains `.unwrap()`.
- **CO4** default param `function f(x: number = 5)`: `f()` → `5`, `f(2)` → `2`.
  Differential-matches JS. Emitted body contains `unwrap_or`.
- **CO5** `x!` on a `None` **panics** at runtime (accepted explicit opt-in): the Rust
  run exits non-zero (`rr.ok === false`). Not a miscompile.

## C · JS-truthiness (`||`/`&&`/`if`/`!`) (decision E)

- **TR1** `x || d` uses **JS falsy** semantics, not `unwrap_or`: `let x: number = 0;
  console.log(x || 7)` prints `7` (present falsy `0` triggers the fallback).
  Differential-matches JS.
- **TR2** `x || d` with a truthy present value returns `x`: `let x: number = 3;
  console.log(x || 7)` prints `3`.
- **TR3** `"" || d` (empty string falsy): `let s: string = ""; console.log(s || "fb")`
  prints `fb`. Differential-matches JS.
- **TR4** `if (x)` on a falsy number takes the else branch: `let x: number = 0;
  if (x) { console.log("t") } else { console.log("f") }` prints `f`.
- **TR5** `!x` on a falsy value is `true`: `let x: number = 0; console.log(!x)` prints
  `true`; on truthy `let x = 5` prints `false`. Differential-matches JS.
- **TR6** `x && y` returns the last operand under JS semantics for present values, and
  short-circuits on a falsy left: `let a: number = 0; console.log(a && 5)` prints `0`.
- **TR7** `if (opt)` on an `Option` narrows on presence: `let x: number | undefined = 5;
  if (x) { console.log("present") } else { console.log("absent") }` prints `present`;
  `undefined` prints `absent`. (Absence is falsy.)
- **TR8** **Regression:** boolean `&&`/`||`/`!` stay native short-circuit ops (no
  truthiness helper wrapping a `bool`): `const a = true; const b = false;
  console.log(a && b || a)` compiles and the emitted shape does NOT contain
  `is_truthy` around the bare booleans.

## D · Both-present divergence warning (decision C, 056 channel)

- **WARN1** `let y: number | null | undefined = 3` compiles (→ `Option<f64>`) and
  records a **non-fatal** 056-channel warning (`mod.warnings` contains a note about
  the collapsed `null`/`undefined` divergence). Not fail-loud.
- **WARN2** A single-spelling union (`number | undefined`) warns **nothing**
  (`mod.warnings` has no undefined-model note).

## E · Emptiness is present, never absence (decision A)

- **EMP1** `Option<Vec<T>>` keeps `None` vs `Some(vec![])` distinct: a `T[] | undefined`
  field that is `[]` is `Some(vec![])` (present-but-empty), and prints/behaves as an
  empty array, distinct from absent. (`[]` is present.)
- **EMP2** `0`, `""` are present values, never `None`: `let n: number | undefined = 0;
  console.log(n ?? 9)` prints `0` (covered by CO2); this spec pins the emitted shape
  wraps the present `0` as `Some(0.0)`, never `None`.

## F · Fail-loud residuals (decisions D, F, B)

- **FL1** Un-narrowed optional in **arithmetic** is fail-loud: `let x: number | undefined
  = 5; console.log(x + 1)` → `UnsupportedError` (points at `??`/narrow/`!`). Never
  emits invalid `Option + f64`.
- **FL2** Un-narrowed optional passed to a `T`-expecting callee is fail-loud:
  `function g(n: number) {}` called as `g(x)` with `x: number | undefined` →
  `UnsupportedError`.
- **FL3** Bare/unannotated absence stays fail-loud: a bare `null` type
  (`let x: null = null`) → `UnsupportedError` (just `strictNullChecks`).
- **FL4** Un-narrowed optional **indexed** / used as a `T` in a value position without
  explicit coercion is fail-loud. (Arithmetic form FL1 is the canonical proof; this
  pins the general rule.)

## Narrowing forms recognized (decision impl sub-detail)

- **NR1** `if (x !== undefined) { use(x) }` narrows to `if let Some(x)` (series 042c,
  regression) — the inner `T` is usable in-branch (e.g. `x + 1` compiles).
- **NR2** `if (x != null)` (loose, catches both spellings) narrows the same way.
- **NR3** `if (x === undefined) return; use(x)` — narrowing forms beyond the enumerated
  set fall through fail-loud rather than miscompile (documents the boundary).
</content>
</invoke>
