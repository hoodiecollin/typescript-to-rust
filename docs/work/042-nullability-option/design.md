# 042 — Nullability / `Option` model (plan)

Graduates the dialect's biggest deferred surface: nullability. `T | undefined`,
`T | null`, and optional properties/params map to Rust `Option<T>`. This is the
**Full Option model** (Collin, 2026-07-06) and it simultaneously graduates #7
(`??`) and unblocks `Array.find` (#29). A rippling dialect decision, so it is
staged into landable slices, each differential-green.

## Type mapping

| TS | Rust |
|---|---|
| `T \| undefined`, `T \| null`, `T \| null \| undefined` | `Option<T>` |
| optional property `field?: T` | `Option<T>` (field) |
| optional param `(x?: T)` / `(x: T \| undefined)` | `Option<T>` (param) |
| return `T \| undefined` | `Option<T>` |

`null` and `undefined` **both** map to `None`. JS distinguishes them, but the
dialect treats both as "absent" — the pragmatic, single-representation choice
(documented divergence; `??`/`== null` already conflate them in JS anyway).
A bare `undefined`/`null` *type* (not in a union with a real `T`) stays fail-loud.

New `RustType`: `{ kind: "option"; inner: RustType }` → `Option<inner>`.

## Value construction — `Some`-coercion

The core mechanism: a plain `T` value flowing into an `Option<T>` slot is wrapped
in `Some(...)`; `undefined`/`null` becomes `None`. Coercion sites (each threads
the *expected* type):
- `let x: T | undefined = v;` → `let x: Option<T> = Some(v);` (`= undefined` → `None`)
- struct literal field whose declared type is `Option` → `Some(value)` / `None`
- `return v;` in a fn returning `Option<T>` → `return Some(v);`
- call arg to an `Option` param → `Some(arg)` / `None`
- a value assigned to an `Option`-typed binding (`x = v`) → `Some(v)`

New HIR: `{ kind: "some"; value }` → `Some(v)`; `{ kind: "none" }` → `None`.
A dedicated `coerceToOption(expr, targetTy)` helper wraps at each site.

## Consumption

- **`??`** (graduates #7): `x ?? d` → `x.unwrap_or(d)` when `d: T`;
  `x.or(d)` when `d` is itself `Option<T>`. `x ?? throw` / side-effecting `d` →
  `.unwrap_or_else(|| …)`.
- **Equality with null/undefined**: `x === undefined` / `x === null` →
  `x.is_none()`; `x !== undefined` / `!== null` → `x.is_some()`.
- **Narrowing** `if (x !== undefined) { …x… }` → `if let Some(x) = x { … }`
  (the guarded binding shadows `x` as `T` in the block). The symmetric
  `if (x === undefined) { … } else { …x… }` maps to the same `if let … else`.
  Early-return narrowing (`if (x === undefined) return; …x…`) lowers via
  `let x = x.expect("…");` after the guard (a checked unwrap; the guard proves it).
- **Optional chaining** `a?.b` → `a.map(|a| a.b)` (`a: Option<_>`), `a?.b?.c` →
  `a.and_then(|a| a.b).map(|b| b.c)`; a chain that bottoms out in a call
  `a?.m()` → `a.map(|a| a.m())`. The whole chain's type is `Option<…>`.
- **`find`**: `xs.find(p)` → `xs.iter().find(|&&x| p).copied()` → `Option<T>`
  (the deferred #29 item; trivial once `Option` is modeled).

## Slices (each lands green)

1. **042a — core**: `option` type + `undefined`/`null` → `None`, optional
   annotations on `let`/params/returns, `Some`-coercion at let/return/param
   sites, `??` → `unwrap_or`. Closes #7's core.
2. **042b — optional struct fields**: `field?: T` → `Option`, `Some`-coercion in
   struct literals, `console.log` of an `Option` (Debug), field access.
3. **042c — equality + narrowing**: `=== undefined/null` → `is_none`/`is_some`,
   `if (x !== undefined)` → `if let Some`, early-return `expect`.
4. **042d — optional chaining + `find`**: `?.` → `map`/`and_then`, `find` → Option.

## Fail-loud residuals

Mixed `T | U` unions of two *real* types (not with null/undefined) stay
fail-loud (that is enum/union territory, a separate decision). `null` vs
`undefined` distinction is intentionally collapsed.
