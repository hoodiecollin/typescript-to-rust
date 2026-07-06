# 034 — Ownership refinement, first increment: use-after-move → `.clone()`

> **Status: FIRST SLICE LANDED.** Pass: `packages/compiler/src/ownership.ts`
> (`refineMoves`). Specs: `packages/compiler/tests/ownership-clone.test.ts`.
> This is the first increment of the "mature ownership/borrow" track. It clears
> the most common Option-A move error (`E0382 use of moved value`) for the
> straight-line case; the harder cases (loops, structs, Rc/arena escape) are
> explicitly deferred to later increments / series 028b–c.

## Problem

Option A emits plain moves. A non-`Copy` value that is **moved** — bound to
another `let`, or passed as an owned call/ctor argument — and then **used again**
is a Rust `E0382` (use of moved value):

```ts
const a: string = "hello";
const b: string = a;     // moves `a`
console.log(a);          // E0382 — `a` used after move
console.log(b);
```

Before this pass the emitter produced `let b: String = a;` then `println!("{}", a)`,
which cargo rejects. That rejection is *loud* (never a silent miscompile), but it
means correct, ordinary TS fails to translate. This increment makes it translate.

## Mechanism

A post-lowering **HIR → HIR** pass (`refineMoves`), wired last in `lower()`:

```
return refineMoves(refineStrings(refineNumerics({ items, main, mainRet, mainAsync })))
```

sitting alongside `refineNumerics`/`refineStrings`. It runs once per body — each
`fn`, each class method, each constructor, and `main` — over the statements in
**document order**:

1. **`movable` set** = params + `let` bindings whose type is a `Clone`-able
   non-Copy (`isCloneableMovable`): `String`, or `Vec`/`HashMap` of
   scalar/`String` elements. Copy scalars need no clone; refs can't move; structs
   are excluded (no `#[derive(Clone)]` yet — see Deferred).
2. **Record**, per movable name: the sequence number of its **last** occurrence
   (`lastUse`) and every **move site** (`moves`). A move site is either a `let`
   whose init is a bare movable ident, or an **owned** call/ctor argument that is
   a bare movable ident (`arg.borrow === "owned"`).
3. **Clone** every move site whose sequence number precedes the binding's last
   use: `mv.seq < lastUse.get(mv.name)` → rewrite the operand to
   `{ kind: "method", receiver: e, name: "clone", args: [] }`. The textually-last
   use is left a bare move — **no needless clone**.

Example results:

| TS | Rust |
|---|---|
| `const b = a; log(a); log(b)` | `let b = a.clone(); … a … b` |
| `take(s); log(s)` (owned param) | `take(s.clone()); … s` |
| `take(s); take(s); log(s.len)` | `take(s.clone()); take(s.clone()); … s` |
| `const b = a; log(b)` (no reuse) | `let b = a;` (bare — last use) |

## Why straight-line, and why that's safe

The pass reasons over a single linear pass in document order. It does **not**
model control-flow joins, so it is deliberately conservative: it only *adds*
clones, and only when it can *prove* a later textual use exists. Anything it
can't prove safe it leaves as a bare move — which, if actually wrong, cargo
catches (`E0382`). So the failure mode is a **loud cargo error**, never a wrong
value. This preserves the project's #1 fail-loud contract.

## Deferred (fail-loud today — cargo catches, later increments fix)

- **Loops.** A value moved inside a loop body but live across iterations needs a
  clone the straight-line last-use test won't place (last textual use ≠ last
  dynamic use). Conservative today → cargo error if it bites.
- **Nested-scope shadowing / re-binding.** `movable` is name-keyed and flat; a
  shadowed name in an inner block is treated as the same binding.
- **Structs.** No `#[derive(Clone)]` on emitted structs, so struct moves can't be
  cloned. A near-future improvement is to derive `Clone` on plain data structs and
  fold struct types into `isCloneableMovable`.
- **Conditional moves** (moved on one branch, used after the join) — needs the
  CFG the straight-line model omits.
- **The real fix for give-ups:** when a value genuinely needs shared ownership
  rather than a clone, that's the `use rc` (028b, Rc<RefCell>) and `use arena`
  (028c, bumpalo) escape hatches — this pass is the *cheap* first line (clone),
  those are the *structural* answers.

## Feeds

The ownership track this opens is the prerequisite the 028 directive series
(`use rc` / `use arena`) builds on: `refineMoves` handles the common
clone-is-fine case so the heavier directives are reserved for genuine shared- or
arena-ownership. See `docs/plan.md` ownership section.
