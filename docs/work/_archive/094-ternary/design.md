# 094 — Ternary `?:` → Rust `if`/`else` expression — design

**Status: APPROVED (2026-07-16, Collin). Proceeding to specs → impl.**

The second item of the "everyday-stuff" campaign (after 093 unions). A
`ConditionalExpression` (`cond ? a : b`) in **any value position** lowers to
Rust's `if`/`else` **expression**. This is a pure desugaring — no memory-model
risk — and it also **retires a special case**: 092 already lowers a ternary
*inside a `flatMap` callback* by hand-rolling a statement-`if` with `return`s;
094 makes that go through the same one node/emitter path as every other ternary.

## Decisions settled (2026-07-16, with Collin)

- **Heterogeneous arms (arms of different type):** **auto-synthesize a union.** An
  untyped `c ? 1 : "a"` synthesizes an anonymous primitive union
  (`__anonymous_union_<hash>`, reusing 093 case F) — `Num(1.0)` / `Str("a")`. A
  **typed** context (`const x: A | B = c ? … : …`, a union return / param / field)
  coerces each arm into the *declared* union's variants (no synthesis). See §4.
- **flatMap ternary:** refactor `liftFlatMapTernaryBody` (092) onto the new
  expression node — `return (if cond { … } else { … })` — so there is one lowering.
  The existing 085/092 differentials (they assert **stdout**, not emitted shape)
  are the regression net.

---

## 1. The target shape

Rust's `if`/`else` is an expression, so:

```ts
const n: number = big ? 100 : 0;
```
```rust
let n: f64 = (if big { 100.0 } else { 0.0 });
```

The emitted conditional is **always parenthesized** — `(if … { … } else { … })` —
because Rust rejects a bare `if`-expression as the operand of a binary operator
(`1 + if c {2} else {3}` is a parse error; `1 + (if c {2} else {3})` is fine). The
parens are unconditional (harmless when redundant), so no precedence table is
needed.

Each arm is a **single expression** placed in the block-expression tail position
(`{ <expr> }`, no trailing `;`), so the block's value *is* the arm.

## 2. The HIR node

A new `HirExpr` variant (the first expression-position conditional; HIR already
had a *statement* `if`):

```ts
| { kind: "cond"; test: HirExpr; conseq: HirExpr; alt: HirExpr }
```

`test` is produced by the shared `truthyCond` helper — identical to `if`-statement
condition handling: a bare `bool` stays native, anything else is wrapped
`tslib::truthy::is_truthy(&…)` (full JS falsy semantics). Nested / chained
ternaries (`a ? b : c ? d : e`) fall out of recursion — the `alt` is itself a
`cond` node.

The node participates in the existing generic HIR walkers unchanged
(`hirHasAwait`, `exprHasBitwise` recurse via `Object.values`); numeric's
non-exhaustive `eachExpr` gets an explicit `cond` case so a usize arm
(`xs[c ? i : j]`) still propagates.

## 3. Lowering — two entry points

- **Typed context** (`lowerTyped(expr, T)`) — const-init with annotation, a union
  return, a union/typed param arg, a typed struct field, a typed array element. A
  `ConditionalExpression` here lowers **each arm through `lowerTyped(arm, T)`**, so
  the arms coerce to `T` uniformly. This reuses *everything*: `T = number` widens
  both arms to `f64`; `T = Shape` (a declared union) coerces `c ? circle : square`
  to `Shape::Circle(…)` / `Shape::Square(…)`; `T = number | undefined` `Some`-wraps
  a present arm. No new coercion logic.

- **Untyped context** (`lowerExpr`) — `console.log(c ? … : …)`, an arithmetic
  operand, any value position with no expected type. Handled by `lowerCond` (§4).

## 4. `lowerCond` — the untyped path & heterogeneous synthesis

1. `test = truthyCond(test)`.
2. Light-type each arm with `inferScalarInner` (literal / template / identifier →
   `String` / `f64` / `bool` / a named struct, or `null` when unresolvable).
3. **Homogeneous, or unresolvable** → emit `{ kind:"cond" }` with arms lowered by
   `lowerExpr`. When the light typer can't resolve an arm (a call, a member), the
   bare `if`/`else` is emitted and **rustc enforces arm-type unity** (cargo-loud on
   a genuine mismatch — an accepted fallback, never a miscompile).
4. **Heterogeneous, both primitive** → **auto-synthesize** an anonymous primitive
   union from the two arm types (`anonPrimUnionName` + `registerPrimitiveUnion`,
   idempotent), then wrap each arm with `coerceScalarToUnion` into its newtype
   variant. The value of the ternary is the union enum.
5. **Heterogeneous, a non-primitive arm, no type context** → **fail-loud**
   (§5) — a struct arm has no `Display`, so a printable union can't be synthesized;
   annotate the target with a declared union.

### Printability — the Display dependency

A synthesized union is reached mainly through `console.log`, so it must **print**.
093 case F primitive unions carry `displayImpl: false` (they were only ever
*narrowed*, never printed directly). 094 makes `registerPrimitiveUnion` set
`displayImpl = (every member is primitive)`, and `emitUnionEnum`'s Display gains a
**newtype arm** (`Enum::Str(inner) => write!(f, "{}", inner)`) — `f64`/`String`/
`bool` all impl `Display` and render exactly as JS `String(v)`
(`1.0`→`1`, `1.5`→`1.5`, `"a"`→`a`, `true`→`true`). Bonus: this also closes the
"a 093-F all-primitive union can't `console.log` directly" gap. A **mixed**
`string | Point` union keeps `displayImpl: false` (the `Point` arm has no Display),
so it is still narrow-then-print only — unchanged.

## 5. Residual fail-loud boundary

| Form | Why | Message |
|------|-----|---------|
| Heterogeneous untyped ternary with a **non-primitive** (struct/object) arm | no `Display` to synthesize a printable union; needs a declared union target | `heterogeneous ternary in an untyped value position with a non-primitive arm — annotate the target with a declared union type` |
| Homogeneous arms the light typer can't resolve but that genuinely differ | best-effort; rustc catches it | (cargo-loud: mismatched `if`/`else` arm types) |

Everything else — homogeneous arms of any type, typed-context arms (including a
declared-union target), nested/chained ternaries, a bare-statement ternary — is
supported.

## 6. Files touched

- `hir.ts` — the `cond` `HirExpr` variant.
- `emitter.ts` — `emitExpr` `cond` case (parenthesized `if`/`else`); `emitUnionEnum`
  newtype Display arm.
- `numeric.ts` — `eachExpr` `cond` case.
- `lower.ts` — `lowerTyped` `ConditionalExpression` case; `lowerExpr` case +
  `lowerCond` + the synthesis helper; `registerPrimitiveUnion` `displayImpl`;
  `liftFlatMapTernaryBody` refactor onto the node.
- `validate.ts` — no change (`ConditionalExpression` is already allowlisted).
