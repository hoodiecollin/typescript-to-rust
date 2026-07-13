# 080 — specs (string concatenation `+` → `format!`)

> Graduates #47. A detected string `+` lowers to `format!("{}{}…", …)`. Detection:
> a `+` is string concat iff an operand is provably a string; a numeric `+` is
> untouched. See `design.md`.

Spec IDs map to `packages/compiler/tests/string-concat.test.ts`.

## Concat correctness (differential)

- **SCAT1** — literal + field: `greet(): string { return "hi " + this.name; }` →
  `format!("{}{}", "hi ", self.name)`; `new Person("al").greet()` differential-matches
  (`"hi al"`).
- **SCAT2** — method-result LHS, chained: `x.greet() + "/" + x.name` →
  `format!("{}{}{}", x.greet(), "/", x.name)`; differential-matches.
- **SCAT3** — two `String` locals: `const a = "x"; const b = "y"; console.log(a + b);`
  → `format!("{}{}", a, b)`; differential-matches (`"xy"`).
- **SCAT4** — number coercion: `const n = 5; console.log("n=" + n);` →
  `format!("{}{}", "n=", n)`; differential-matches (`"n=5"`), matching JS's
  string-coercion of a number.
- **SCAT5** — parenthesized numeric subtree preserved:
  `const a = 2, b = 3; console.log("x" + (a + b));` → the inner `a + b` stays a single
  numeric part (`format!("{}{}", "x", a + b)`); differential-matches (`"x5"`).

## Emit shape

- **SCAT6** — SCAT2's program emits a `format!(` call and **no** bare `String +`
  concat for the string parts.

## Regression (unchanged)

- **SCAT7** — a purely numeric `+` (`const a = 1, b = 2; console.log(a + b);`) is
  **not** turned into `format!` (emits `a + b`) and differential-matches (`3`).
