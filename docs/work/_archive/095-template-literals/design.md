# 095 — Template literals (`` `hi ${x}` ``) → JS-faithful string building

Third item in the "everyday-stuff" campaign (unions ✅ · ternary ✅ · **template
literals** · then `++`/`--` · destructuring · string methods). See the campaign
memory `093-union-types-campaign`.

## Problem

A `TemplateLiteral` is fail-loud today — it is **not** in `validate.ts`'s allowlist
(`Unsupported TemplateLiteral`). The *type layer* already treats one as a `String`
(`scalarKindOf`/`isStringExpr` both return `String`/`true` for a `TemplateLiteral`),
so it participates correctly in string-concat detection and typing — there is simply
no **lowering** for it.

Everyday scripts lean on templates constantly: `` `Hello, ${name}!` ``,
`` `${count} items` ``, log lines, path building. This closes that gap.

## AST shape (oxc)

```
TemplateLiteral {
  quasis:      TemplateElement[]   // cooked string chunks; quasis.length === expressions.length + 1
  expressions: Expression[]        // the ${…} holes, interleaved between quasis
}
TemplateElement { value: { cooked, raw }, tail }
```

Rendered order is `quasi[0], expr[0], quasi[1], expr[1], …, quasi[n]`. A leading or
trailing empty template (`` `${x}` `` → `quasis = ["",""]`) yields empty cooked
chunks, which we drop.

## Core mechanism — reuse the shipped `strConcat` node (series 080)

A template is exactly sugar for a `+`-concatenation, and the 080 `strConcat` HIR
node already emits `format!("{}{}…", parts…)` where a `{kind:"string"}` part renders
as a bare `&str` literal and every other part coerces via `Display`. So:

```
TemplateLiteral  →  { kind: "strConcat", parts: [ …cooked quasis interleaved with lowered ${} parts… ] }
```

Non-empty cooked quasis become `{kind:"string", value: cooked}` parts (the emitter
`JSON.stringify`s them, so `\n`, `"`, `\`, `{` are escaped correctly). Each `${}`
expression is lowered by a **classifier** (below) that picks the JS-faithful
rendering for its static type.

This reuses the 080 emitter and its `rc.ts` walker wholesale; number/bool/string
scalar interpolation is byte-identical to how `"" + x` already behaves.

## Interpolation classifier — `lowerTemplatePart(expr)`

JS's template coercion is the `ToString` abstract operation, which differs by type.
Collin's decision (2026-07-16): **match JS behavior for arrays, objects, and
null/undefined** — not merely inherit `strConcat`'s cargo boundary. Classification
order, using the existing resolvers (`optionExprType`, `receiverTypeOf`):

1. **Option** (`optionExprType` non-null) → `{kind:"optDisplay", value}` — the
   existing series-066 node emitting `tslib::truthy::fmt_opt(&x)`: `Some(v)`→`v`'s
   render, `None`→the literal `undefined`. (The dialect conflates `null`≡`undefined`
   ≡`None` everywhere; template rendering follows the same convention as
   `console.log`, so `${x}` of an absent optional prints `undefined`.)

2. **Array** (`receiverTypeOf` → `vec`/`array`):
   - element is a Display scalar (`String`/`f64`/`bool`) → `tslib::array::join(&x, ",")`
     (a `call`+`raw` node, the exact shape `arr.join()` already lowers to). JS
     `` `${[1,2,3]}` `` → `"1,2,3"`. **No new node, no new tslib code.**
   - element is itself an array/struct/option (nested or object array) → **fail-loud**
     (`template interpolation of a nested/object array`). JS would deep-`join` /
     `[object Object]` per element; out of v1 scope, pinned as a clean signal.

3. **Plain data struct** (`receiverTypeOf` → `struct` **and** name ∈ `structFields`)
   → `{kind:"jsObjectStr", value}` (the one new node) → `{ let _ = &(expr);
   String::from("[object Object]") }`. Plain structs derive only `Clone`+`Debug`,
   **never `Display`** (`derives.ts`), so `[object Object]` is always the JS result.
   The `let _ = &(…)` preserves evaluation/side-effects of an effectful `${expr}`
   while borrowing (never moving) the value.

4. **Union enum** (`receiverTypeOf` → `struct` and name ∉ `structFields`, i.e. a
   union `enum` from 093/094) → a plain `Display` part (`format!("{}", x)`). Union
   enums *do* have `Display`, which renders the inner value — JS-faithful for
   `string|number` etc. This is Collin's "structs *with* a Display impl still use
   it" caveat: in this dialect the only `Display`-bearing "objects" are union enums.

5. **Map / Set / tuple / fn-pointer** (`receiverTypeOf` → `hashmap`/`set`/`tuple`/
   `fnPtr`) → **fail-loud** (`template interpolation of a <kind>`). JS gives
   `[object Map]`/`[object Set]`/a comma-join/source text — niche; pinned as clean
   signals rather than guessed.

6. **Scalar or untyped** (String/f64/bool, or `receiverTypeOf` returns null) → a
   plain `lowerExpr` part (`format!("{}", x)`). For an untyped expr the resolver
   can't classify, this is the conservative default and matches `strConcat`; a truly
   non-`Display` untyped part falls through to cargo (the existing 080 boundary).

## New HIR node

```ts
| { kind: "jsObjectStr"; value: HirExpr }   // ${plainStruct} → "[object Object]" (JS), evaluating value
```

Emitter:

```
{ let _ = &(<value>); String::from("[object Object]") }
```

`rc.ts` gets a `jsObjectStr` case that recurses into `value` (mirrors `strConcat`),
so an rc-field read inside the interpolated expr still gets its `.borrow()`. `numeric.ts`
`eachExpr` needs **no** change — like `strConcat` (also absent there), the node is
not a numeric-literal-typing site, and the switch has no exhaustiveness default.

## Typed positions

`lowerTyped` needs no template-specific case: a `TemplateLiteral` is a `String`, so
- `ty = string` (or no ty) → falls through to `lowerExpr` → the new `TemplateLiteral`
  case → `strConcat`;
- `ty = Option<string>` → the `option` branch `Some`-wraps `lowerTyped(expr, inner)`,
  recursing to the `String` path;
- `ty = a union with a `Str` variant` → `coerceScalarToUnion` wraps the template's
  String inner into the variant (reuses 093-F `inferScalarInner`, which already
  classifies a `TemplateLiteral` as `String`).

## Fail-loud residuals (v1)

- **Tagged templates** (`` tag`…` ``) — a `TaggedTemplateExpression`, a different
  node, never allowlisted → stays `Unsupported`.
- **Nested / object-element arrays** in `${}` (case 2b).
- **Map/Set/tuple/fn** in `${}` (case 5).
- Number formatting inside `${}` uses the same `format!("{}")` path as 080 `+`
  concat (Rust f64 `Display`), **not** `tslib::number::to_js_string`, so the rare
  `1e21`/`Infinity`-style divergences 080 already has are inherited unchanged (not
  a template-specific regression; a whole-pipeline number-fidelity pass is separate).

## Validator

Allowlist `TemplateLiteral` and `TemplateElement` in `validate.ts`'s `MODELED` set.

## Files touched

- `packages/compiler/src/hir.ts` — `jsObjectStr` node.
- `packages/compiler/src/emitter.ts` — `case "jsObjectStr"`.
- `packages/compiler/src/lower.ts` — `lowerTemplate` + `lowerTemplatePart` +
  `case "TemplateLiteral"` in `lowerExpr`.
- `packages/compiler/src/rc.ts` — `jsObjectStr` recurse case.
- `packages/compiler/src/validate.ts` — allowlist the two nodes.
- `packages/compiler/tests/template-literals.test.ts` — specs (see `specs.md`).
