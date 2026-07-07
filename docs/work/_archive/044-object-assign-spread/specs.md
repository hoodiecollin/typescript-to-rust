# 044 — specs

Differential specs in `packages/compiler/tests/object-assign-spread.test.ts`.

## 044a — Object.assign
- **ASN1** `Object.assign({}, a, b)` merges into a fresh map (later source wins);
  emitted is the `{ let mut __o = IndexMap::new(); __o.extend(...); … __o }` block.
- **ASN2** `Object.assign(a, b)` extends the target and evaluates to the merge.
- **ASN3** a later source overrides an earlier key.

## 044b — object spread
- **SPR1** `{ ...a, k: v }` builds a merged map with the explicit entry applied
  in source order.
- **SPR2** `{ ...a, ...b }` (later spread wins on key collision).
- **SPR3** an explicit key before a spread is overridden by the spread.

## Fail-loud
- **SPR4** array spread `[...a]` stays fail-loud.
