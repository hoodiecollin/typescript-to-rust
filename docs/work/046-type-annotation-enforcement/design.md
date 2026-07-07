# 046 — Type-annotation enforcement (plan)

Closes the dialect's last silent-inference hole. Today untyped **params** and
**fields** fail loud, but two sites leak:

1. an **untyped `let`/`const`** silently passes (`lowerVarDecl` leaves `ty = null`
   and lets Rust infer a type the validator never checked), and
2. a **missing return type** silently defaults to `-> ()` (`lowerFunction` /
   `lowerMethod` fall back to `UNIT`) — only the cargo oracle catches the
   mismatch, not our fail-loud gate.

Issue #3, **Option C — wider syntactic inference** (Collin, 2026-07-07): allow an
untyped binding for any *statically-obvious literal* initializer — scalars **and
homogeneous scalar arrays** — and fail loud everywhere else, including the real
hole (missing return types). Inference stays **purely syntactic**: a single pass,
no `tsc`, no callee/flow typing. Every widening is a documented dialect commitment.

Missing annotation is a **`UnsupportedError`** ("annotate it" — fixable, in the
dialect), matching the existing param message; never a `DialectError`.

## The rule — what may be left untyped

| Binding initializer | Untyped OK? | Inferred Rust |
|---|---|---|
| number literal (`const n = 5`) | ✅ | `f64` (Rust infers) |
| string literal (`const s = "hi"`) | ✅ | `String` |
| boolean literal (`const b = true`) | ✅ | `bool` |
| homogeneous number array (`[1, 2, 3]`) | ✅ | `Vec<f64>` |
| homogeneous string array (`["a", "b"]`) | ✅ | `Vec<String>` |
| homogeneous bool array (`[true, false]`) | ✅ | `Vec<bool>` |
| empty array (`[]`) | ❌ | — (ambiguous element) |
| mixed array (`[1, "a"]`) | ❌ | — (heterogeneous) |
| nested / non-scalar array (`[[1, 2]]`, `[{…}]`) | ❌ | — (element not a scalar literal) |
| non-literal (`f()`, `a + b`, `x`, `o.k`, `` `t${x}` ``) | ❌ | — |
| unary-negative (`-5`), `null`, `undefined` | ❌ | — |

Everything in the ❌ rows **requires an annotation** → `UnsupportedError`. Params,
fields, and return types are **never** inferable — always annotate.

## The syntactic literal-shape test

A single pure predicate `isObviousLiteralInit(expr)` — no scope, no types, one
look at the node:

- an ESTree `Literal` whose `typeof value` is `"number"` / `"string"` /
  `"boolean"` → **true** (a `Literal` with `value === null` is **false**);
- an `ArrayExpression` with **≥ 1** element where **every** element is a scalar
  `Literal` (per above) **of the same `typeof`** → **true**;
- anything else → **false**. This deliberately rejects `[]` (zero elements, no
  element type), mixed arrays (differing `typeof`), nested/object-element arrays
  (element is not a scalar `Literal`), `UnaryExpression` (`-5`), the `undefined`
  identifier, the `null` literal, calls, binaries, identifiers, member access,
  template literals, and object literals.

`-5` is a `UnaryExpression`, not a literal, so it needs an annotation — consistent
with the decision (unary-negative counts as non-trivial). `null`/`undefined` are
non-trivial for the same reason (their bare type is already fail-loud, per
`dialect.md`).

## Where each rule is enforced

| Site | Untyped allowed? | Enforcement point | Status |
|---|---|---|---|
| `let` / `const` binding | iff `isObviousLiteralInit` | `lowerVarDecl` (new gate when `ty === null`) | **new (046a/b)** |
| function / arrow return type | never | `lowerFunction` (flip the `: UNIT` default, L348-350) | **new (046c)** |
| method return type | never | `lowerMethod` (flip the `: UNIT` default, L1138-1140) | **new (046c)** |
| function / method / arrow **param** | never | `lowerParam` (already throws, L1170) | unchanged |
| class field | never | existing `class field '<name>' without a type` | unchanged |
| interface field | never | existing `interface field '<name>' without a type` | unchanged |

Arrows route through `lowerFunction`: `arrowToFunctionDecl` copies
`returnType: arrow.returnType ?? null` (L250), so the return-type flip in
`lowerFunction` covers a `let`/`const`-bound arrow with no fixup.

An **explicit `: void`** annotation still lowers to `UNIT` (via `lowerType` →
`{ kind: "unit" }`) — the flip only rejects an *absent* `returnType`, so a
genuinely unit-returning function annotates `: void` and keeps working.

## Interaction with `numeric.ts`

The literal-shape gate **validates only** — it must leave `ty = null` on the
`let`, exactly as today. It does **not** annotate the binding. That preserves the
numeric-refinement contract: `refineNumerics` keys on the binding *name*, not on
whether a type was written, and retypes a `let` in place
(`stmt.ty = { kind: "usize" }` in `applyTypes`) plus tags the initializer's number
literal `usize`. So `const i = 0; arr[i]` stays untyped through the gate, then the
`usize` fixpoint upgrades `i` — the trivial-literal number binding still flows
through the usize/i64 refinement unchanged. Homogeneous number arrays lower to
`vec![1.0, 2.0, …]` (element literals default `f64`); no index context reaches the
elements, so refinement leaves them alone and Rust infers `Vec<f64>`.

## Slices (each lands green)

1. **046a — untyped scalar bindings**: add `isObviousLiteralInit`; gate
   `lowerVarDecl` so an untyped `let`/`const` with a scalar-literal initializer
   passes (`ty = null` preserved) and anything else (`f()`, `a+b`, `-5`, `null`,
   `undefined`, an untyped identifier) fails loud. Confirms the numeric-refinement
   interaction still holds.
2. **046b — homogeneous scalar arrays**: widen `isObviousLiteralInit` to accept a
   non-empty same-`typeof` scalar-literal `ArrayExpression`; `[]`, mixed, and
   nested/object-element arrays fail loud.
3. **046c — mandatory return types**: flip the `: UNIT` default in `lowerFunction`
   and `lowerMethod` to `UnsupportedError`; an absent return type on a function,
   method, or `const`-bound arrow fails loud, while explicit `: void` still lowers
   to `-> ()`.

## Fail-loud residuals

- **Empty / mixed / nested arrays** stay fail-loud: an empty array has no element
  type, a mixed array is union/tuple territory (a separate decision), and a
  non-scalar element is not statically obvious in one pass.
- **Any non-literal initializer** (call, arithmetic, identifier, member access,
  template literal, object literal) requires an annotation — chasing its type is
  callee/flow inference, deliberately out of scope.
- **`-5`, `null`, `undefined`** initializers require an annotation (non-trivial by
  the decision).
- No backward *type propagation*: the gate never infers a binding's type from
  later use — it either reads the literal shape or fails loud.

## `dialect.md` sync

Same-change catalog updates (per the maintenance rule): the Variables & bindings
"An untyped binding outside the trivial-literal exception" row gets the concrete
message + the widened "scalar or homogeneous-scalar-array literal" exception; the
Required "Explicit type annotations" bullet's parenthetical widens to include
homogeneous scalar arrays; and a new Functions row records that a **missing return
type** now fails loud (was a silent `-> ()`).
