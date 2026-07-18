# 080 — String concatenation (`+`) → `format!`

> **Status: DESIGN COMPLETE (2026-07-13). Quick codegen fix.** Graduates issue
> **#47**: a string `+` whose operand is a field access or method-call result
> emitted `String + String`, which cargo rejects (E0308). Surfaced while
> implementing #43/071 (not caused by it — a plain class reproduces it).
>
> Spec-first: this `design.md` → RED `specs.md` → impl → archive.

## Problem

Every string `+` lowered to a plain `binary` HIR node and emitted `left + right`
verbatim. Rust's `Add for String` wants `&str` on the RHS, so **all** string concat
emitted invalid Rust — not just the field/method cases in the issue:

```
"hi " + this.name        →  "hi ".to_string() + self.name     // String + String ❌
x.greet() + "/" + x.name →  x.greet() + "/".to_string() + x.name  // ❌
"n=" + n   (n: f64)      →  "n=".to_string() + n               // String + f64 ❌
```

A bare `a + b` of two `String` locals fails identically. There were no passing
*differential* string-concat tests (they'd have hit this), so the gap was masked.

## Decision (2026-07-13, with Collin)

**Detected string concat lowers to a single `format!("{}{}…", parts…)`.** Chosen
over keeping `+` and borrowing each RHS: `format!` handles every operand kind
(`String`, `&str`, field, method result, **and number coercion** `"n=" + n`)
uniformly — it borrows its args via `Display`, so there is no borrow / clone /
move / method-return-type reasoning. It is the idiomatic Rust for building a string
from mixed parts.

The borrow-and-keep-`+` alternative needs per-operand handling (literal RHS bare,
`String` RHS `&`, number RHS `.to_string()`, field **LHS** `.clone()`, and new
method-return-type tracking for a method-call RHS) — strictly more cases, more
fragile, and still cargo-loud on the method-RHS case until that machinery lands.

## Detection (the load-bearing part — required by either strategy)

A `+` is a **string concatenation** iff at least one operand is **provably a
string**. In JS, `string + anything` concatenates, so one provable-string operand
is sufficient and sound — a numeric `+` is never misclassified.

`isStringExpr(e)` returns true only when provably string:

- **string literal** / **template literal** → true
- **identifier** → `bindingTypes.get(name)?.kind === "String"`
- **non-computed member** `this.f` / `x.f` → the field's type is `String`
  (receiver struct via `currentClass` for `this`, `bindingTypes` for a named
  receiver; then `structFields`)
- **`+` binary** → `isStringExpr(left) || isStringExpr(right)` (recursive)
- anything else (incl. a **method call** — no return-type table) → **false**
  (unknown ≠ string; never a false positive)

## Flattening

`a + b + c` parses `((a + b) + c)`. Flatten a string-concat `+` into a flat parts
list, **descending only into `+` children that are themselves string concats** so a
parenthesized numeric subtree stays intact:

- `"x" + a + b` → `["x", a, b]` → `format!("{}{}{}", "x", a, b)`
- `"x" + (a + b)` (a,b numeric) → `["x", (a+b)]` → `format!("{}{}", "x", a + b)`
  — the inner arithmetic is one part, **not** spliced.

## Emit

New HIR node `{ kind: "strConcat"; parts: HirExpr[] }`. Emitter renders
`format!("{}{}…", p0, p1, …)` with one `{}` per part. A **string-literal** part
renders as a bare `&str` (`"x"`, not `"x".to_string()`); every other part via
`emitExpr`. The format string contains only `{}` placeholders (no user data), so no
brace escaping is needed.

## Fail-loud / residuals

- **Method-call operands on *both* sides with no literal/field** (`a.f() + b.f()`)
  — detection can't prove either is a string (no method-return-type table) → stays a
  numeric `+` → **cargo-loud** `String + String`. Not a silent miscompile; graduating
  it needs method-return typing (separate, out of this quick fix). Not in the repro.
- **`+=` string append** (`s += "x"`) is an assignment, not a `+` binary — untouched
  here (own concern if it surfaces).

## Specs sketch (→ `specs.md`, `tests/string-concat.test.ts`)

- literal + field (`"hi " + this.name`); method-result LHS chain
  (`x.greet() + "/" + x.name`); two `String` locals (`a + b`); number coercion
  (`"n=" + n`); parenthesized numeric subtree preserved (`"x" + (a + b)`);
  regression: numeric `+` (`1 + 2`) **byte-for-byte unchanged** (no `format!`).
