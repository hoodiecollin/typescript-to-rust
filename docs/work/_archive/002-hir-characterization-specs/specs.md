# 002 — Specs

Natural-language behaviors, each pinned by a test in `tests/lower.test.ts`
(AST → HIR) or `tests/emitter.test.ts` (HIR → string).

## Lowering (AST → HIR)

- **L1** A read-only non-Copy parameter lowers to a shared borrow: its `ty` is
  `&T` (`{kind:"ref", mut:false, inner:…}`).
- **L2** A mutated non-Copy parameter lowers to a mutable borrow: `ty` is `&mut T`
  (`{kind:"ref", mut:true, …}`).
- **L3** A `number` parameter is Copy and keeps its base type (`{kind:"f64"}`),
  no borrow.
- **L4** `void` return lowers to `{kind:"unit"}`.
- **L5** `Array<number>` resolves to `{kind:"vec", elem:{kind:"f64"}}`.
- **L6** A reassigned local is marked `mut:true` on its `let`; a `const` never
  reassigned is `mut:false`.
- **L7** An argument passed at a `&mut` position carries `borrow:"refMut"` on its
  `HirArg`; at a move position it carries `"owned"`.
- **L8** `console.log(...)` lowers to a `println` node, not a generic call.
- **L9** `.length` lowers to a `len` node; a computed member (`a[0]`) lowers to an
  `index` node.
- **L10** Top-level function declarations become `items`; top-level statements
  become `main`.
- **L11** Fail-loud gates throw `UnsupportedError`: top-level statements alongside
  a user-defined `main`, a parameter without a type annotation, a `null` literal.

## Emission (HIR → string)

- **E1** An integer `number` emits with an explicit `.0`; a non-integer emits
  verbatim.
- **E2** A `string` emits as `"…".to_string()`.
- **E3** A `ref` type emits `&T`; a mutable `ref` emits `&mut T`.
- **E4** A literal integer **index** emits as bare `usize` (`a[0]`), never `a[0.0]`.
- **E5** `println` emits a JS-style space-separated format string
  (`println!("{} {}", x, y)`).
- **E6** A call argument with `borrow:"refMut"` renders `&mut x`; `"ref"` renders
  `&x`; `"owned"` renders `x`.
- **E7** A `unit` return type is elided (no `-> ()`); a non-unit return renders
  `-> T`.
- **E8** An async function renders `async fn`.
