# 038 — Complete move coverage: move-through-store + move-out-of-place

> **Status: LANDED.** Epic: GitHub issue #1 (`ownership`) — the final move-shape
> increment. Pass: `src/ownership.ts` (`refineOwnership`, extended). Specs:
> `tests/move-coverage.test.ts`. Closes the epic's move coverage: every in-dialect
> shape that would `E0382`/`E0507` on a plain move now clones (fail-loud otherwise).

## Why this exists

Series 037 (CFG + liveness) placed clones for moves of a bare **name** into another
`let` or an owned call argument. An empirical probe (compile each shape, read the
cargo error) found four more shapes that still hit `E0382`/`E0507`:

| Shape | Example | Error |
|---|---|---|
| store into a struct/array/hashmap literal | `const w: W = { s: s }; …s…` | `E0382` |
| store via a by-value method arg | `arr.push(s); …s…` | `E0382` |
| store via an assignment value | `s2 = s; …s…` | `E0382` |
| move a non-Copy field/index out (partial move) | `const n = p.name; …p…` | `E0382` |
| move out of a **borrowed** place | `f(p: P){ return p.name }`, `return v[0]` | `E0507` |

All are the same underlying fact — a non-Copy value is **consumed by move** in a
position where the source must stay valid — so all get the same fix: a `.clone()`.
The pass still only *adds* clones, so the fail-loud contract holds (anything it
can't prove stays a bare move cargo rejects loudly).

## Two mechanisms

### 1. Move-through-store (a *name* moved into an owning position)

The move-site set widens from "owned call argument" to every **owning position**: a
by-value method argument, an element of a struct/array/hashmap (or `bumpalo`)
literal, and an assignment's value. A shared `owning(sub, set)` helper in
`placeInExpr` registers a bare movable ident in any of these as a deferred move
site (cloned iff the liveness result shows a later use) — identical machinery to
037, just applied at more positions. (Method args are safe to treat uniformly:
they emit by-value, `recv.m(a)`, so every one is an owning position.)

### 2. Move-out-of-place (a *projection* read by value)

Reading a non-Copy projection (`obj.field`, `arr[i]`) by value moves out of its
base. `projectionMovesOut(e, liveOut, ctx)` decides whether that's illegal (→
clone) using the projection's **type** and its **base**:

- Compute the projection's value type from a per-body **type environment** (`env`:
  every param + `let`'s declared type) via `projType` — a struct field's type from
  the struct table, a `Vec`/`HashMap` element's from its container. A Copy or
  unknown-typed projection is never cloned.
- It **must clone** when the base can't be moved from:
  - the path goes through an **index** (`Vec`/`HashMap` never allow move-out → always `E0507`);
  - the base root is a **borrowed param** (`refParams` — behind a `&`/`&mut`, so `E0507`);
  - the base root is an owned binding that is **used again** (`liveOut` — a partial move that would break the later use, `E0382`).
- Otherwise (an owned local whose base is not reused) it's a **legal partial
  move** → left bare, no needless clone.

Applied at every move position: a `let` init, a `return` value, and each owning
operand inside `placeInExpr` (so `take(p.name)` and `xs.push(v[0])` clone too).

## Threading

`placeSeq`/`placeStmt`/`placeInExpr` now carry a `PlaceCtx { movable, map, structs,
env, refParams }` instead of loose params. `refineBody` builds `env` (param + let
types) and `refParams` (params whose type is a `ref`) once per body. The
`movable.size === 0` early-return is dropped — a projection clone can be needed in a
body with no movable *name* (e.g. returning a field of a borrowed struct param).

## Fail-loud (unchanged)

Only clones are added; every decision either matches a real cargo rejection or is a
conservative over-clone (a borrowed/unknown base → clone). A shape the type
environment can't resolve (`projType → null`) is left bare → cargo-loud, never a
wrong value.

## What this closes / what's left

Closes epic #1's move coverage — the four remaining probe shapes (H ctor
field-store reuse, I push+reuse, J nested projection out of a borrow, K loop moving
a struct into a growing `Vec`) all compile + behave. Genuinely out of scope (their
own future work, cargo-loud today): owned-`self` method receivers that move,
reborrow splitting across a single statement, and moves the type environment can't
type (dynamic shapes — not in dialect).
