# 070 — Implicit / non-field-init constructors — specs

Graduates issue **#36** / the 060 constructor deferral. A class **without an
explicit field-initializing constructor** now lowers to a valid `struct` + `new`.
Each field's construction value comes from one of three sources (design §Decision):
ctor-assigned → field initializer → `Option<T>`/`None` (via 066).

Test file: `packages/compiler/tests/implicit-constructors.test.ts`. Each behaving
spec differential-matches (compile → cargo run == TS-via-Bun == expected). Reject
specs assert `lower`/`emit` throws.

## Behaving

- **IC1 — no constructor, field initializer.** `class A { x = 5 }` (no ctor, no
  annotation) synthesizes `fn new() -> A { A { x: 5.0 } }`; the initializer types
  as `f64` via the numeric literal pass. `new A().x` prints `5`.

- **IC2 — no constructor, annotated field initializer.** `class C { label: string = "hi" }`
  synthesizes `new()` filling `label` from `"hi".to_string()`. Prints `hi`.

- **IC3 — empty constructor, no fields.** `class B { constructor() {} }` → a
  fieldless struct with `fn new() -> B { B {} }`. Constructs and runs.

- **IC4 — partial constructor: uninitialized field falls back to its initializer.**
  `class P { x: number; y = 0; constructor(x: number) { this.x = x } }` synthesizes
  `new(x)` filling `x` from the param and `y` from its initializer `0.0`. Prints
  the ctor param and `0`.

- **IC5 — no ctor assignment, no initializer → `Option<T>`/`None`.** `class Q { x: number }`
  (no initializer, no ctor) makes `x: Option<f64>`, `new()` sets `x: None`; a read
  narrows via `?? d` (066). `new Q().x ?? 7` prints `7`.

- **IC6 — partial constructor with an uninitialized, non-initialized field →
  `Option<T>`/`None`.** `class R { a: number; b: number; constructor(a: number){ this.a = a } }`
  fills `a` from the param and `b` as `None` (`Option<f64>`); `new R(3).b ?? 9`
  prints `9`, `new R(3).a` prints `3`.

- **IC7 — several field initializers, no ctor.** `class S { x = 1; y = 2; z = 3 }`
  synthesizes `new()` with all three defaults. Prints `1 2 3`.

- **IC8 — a Some-provided initializer for an optional-typed field.**
  `class T { flag: boolean | undefined = true }` (annotated optional field with an
  initializer) fills `flag` as `Some(true)`. `new T().flag ?? false` prints `true`.

## Reject (fail-loud residuals preserved)

- **IC-R1 — `protected` field in an implicit-ctor class stays fail-loud.**
  `class C { protected x = 5 }` → throws `/protected/i`.

- **IC-R2 — class decorator stays fail-loud** (permanent by-design). `@sealed class C { x = 5 }`
  → throws.

- **IC-R3 — a field initializer with no honest construction value stays fail-loud.**
  Per the design's Decision, an *un-assigned, un-initialized* field is always
  `Option<T>`/`None` (even `p: Point` → `Option<Point>`). The genuinely
  value-less case the design leaves fail-loud is an **initializer the three
  sources can't honestly produce** — one that references another field / `this`
  (design §Open sub-details: "support order or fail-loud"). `class C { x = 1; y = this.x }`
  → throws (cross-field / `this`-referencing initializer is not a construction
  constant).

## Open sub-details resolved (design §Open sub-details — impl, not forks)

- **Initializer referencing another field / `this`.** Fail-loud: a field
  initializer that references `this` or another field name is rejected (out-of-order
  / cross-field init is ambiguous under struct-literal totality). Only self-contained
  literal/const initializers are synthesized. (IC-R covered generically by
  fail-loud when the initializer isn't a supported constant form.)

- **Synthesized `new()` vs a user `static new`.** A user-declared `static new`
  collides with the synthesized zero-arg `new` → fail-loud rather than silently
  shadowing.

- **Numeric-pass typing of an initializer literal.** Reuse `inferInitType` (the
  existing literal-typing helper, already used by `lowerStaticConst`); `5` → `f64`.
  No parallel inference path.
