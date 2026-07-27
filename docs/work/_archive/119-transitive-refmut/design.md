# 119 — Transitive `refMut` (graduate the borrowed-param-forwarded-to-`&mut` residual)

Graduates issue **#102** (`ownership`, `deferral-graduation`). Discovered during
series 117 (#101), pre-existing and orthogonal to VecDeque.

## The bug

A function that takes a container param **by shared reference** but then **forwards
that param to a callee that mutates it** emits Rust that borrows a `&T` as `&mut`:

```ts
function inner(q: number[]): void { q.push(9); }   // inner mutates q → &mut Vec
function outer(q: number[]): void { inner(q); }     // outer only forwards q
const a: number[] = [1, 2, 3];
outer(a);
console.log(a.length);
```

emitted today:

```rust
fn inner(q: &mut Vec<f64>) { q.push(9.0); }
fn outer(q: &Vec<f64>)     { inner(&mut q); }   // ❌ E0596 + E0308
```

`inner` correctly infers `&mut Vec`. `outer` only *forwards* `q` (never mutates it
directly), so param ownership leaves it `ref` (`&Vec`). The call site then forces
`&mut q` from `inner`'s `refMut` param — and `&mut` on a `&Vec` is illegal.

## Root cause (two disagreeing sites)

The issue frames this as one fixpoint change, but the target output `inner(q)` is a
**reborrow**, which needs two coordinated fixes:

- **Site A — the signature** (`analysis.ts`): `classifyParam` classifies each param
  from its *direct* body uses only, in a **single pass** (no transitive fixpoint over
  free-fn / method params, unlike the self-mutating-method fixpoint). So `outer.q`
  stays `ref`.
- **Site B — the call site** (`lower/expressions.ts`): the arg borrow is chosen purely
  from the *callee's* param ownership. `inner` wants `refMut` → it emits `&mut q`, with
  no knowledge that `q` is itself a borrowed param.

Why both — trace what each produces:

| | `outer.q` sig | call site | Rust | result |
|---|---|---|---|---|
| today | `&Vec` | `&mut q` | `&mut &Vec` vs `&mut Vec` | E0596 + E0308 |
| A only | `&mut Vec` | `&mut q` | `&mut &mut Vec` vs `&mut Vec` | still E0308 (no coercion) |
| **A + B** | `&mut Vec` | `q` (reborrow) | `&mut Vec` — Rust auto-reborrows | ✅ |

The **read-only** case already works with neither fix, because `&&T → &T`
deref-coerces; `&mut &mut T → &mut T` does **not** — which is exactly why only the
`&mut` transitive case breaks.

## Part A — transitive `refMut` promotion fixpoint (`analysis.ts`)

A unified fixpoint over all param scopes (free fns *and* methods), inserted after
`fns` and `methodParams` are built and **before** `mutableBindings` (which reads them
to mark `mut` locals):

> If a scope's param `p` (currently `ref`, non-`Copy`) is passed as a **bare
> identifier** argument into a callee position whose ownership is `refMut`, promote
> `p` to `refMut`. Iterate to a fixpoint — forward chains (`outer→middle→inner`)
> converge upward.

Callee resolution mirrors the two existing call-adaptation paths:
- callee `Identifier` → `fns.get(name)?.params`
- callee `MemberExpression` (`.prop(...)`) → `methodParams.get(prop)` (name-keyed, the
  documented same-name-across-classes method limit).

**Guard rails (all preserve fail-loud — anything unhandled still hits cargo):**
- **Bare identifier only.** `g(q)` promotes; `g(q.slice())`, `g([...q])`,
  `g(cond ? q : r)` do **not** — those are fresh values, not a borrow of `q`.
- **`ref → refMut` only.** Never touch `move` (owned — `&mut` of an owned param is the
  separate `mut p` concern) or `isCopy` params.
- **Termination.** Monotonic (only ever `ref → refMut`), bounded by total param count;
  the 3-hop chain converges in two iterations.

Because `methodParams` is name-keyed (last-wins), promoting a method param mutates the
one shared `ParamInfo[]` for that name — consistent with the existing 060 method-param
model.

## Part B — reborrow at the forwarding call site (post-lowering HIR pass)

`refineTransitiveRefMut(module)`, modeled on `fixKeyBorrows`: for each fn / method /
ctor, collect the param names whose lowered `ty` is `&mut T`
(`ty.kind === "ref" && ty.mut`), then walk the body:

- **free-fn call arg** `{kind:"call", args:[HirArg…]}` — if `arg.borrow === "refMut"`
  and `arg.expr` is an `ident`/`path` in the refMut-param set → set `arg.borrow =
  "owned"` (emits bare `q`; Rust auto-reborrows at the `&mut Vec` site).
- **method call arg** `{kind:"method", args:[HirExpr…]}` — if arg is
  `{kind:"ref", mut:true, expr:<ident in set>}` → replace with `arg.expr` (bare `q`).

Chosen as a post-lowering pass (not an emit-site guard) because the emit site
(`expressions.ts`) has no enclosing-scope knowledge, while the HIR pass has every
param's final lowered type — matching the codebase's ownership-refinement passes
(`refineOwnership`, `computeAutoRc`, `fixKeyBorrows`). It runs after lowering has baked
param `&mut T` types; ordering vs the other refinements is irrelevant (it only rewrites
a borrow adornment on an already-`&mut` binding).

Only `refMut` args are touched. A `ref` arg on a refMut param (`&q` → `&&mut T → &T`)
already coerces and is left alone. A `refMut` arg whose ident is **not** a refMut param
(an owned `T` local needing a genuine `&mut q`) is left alone → still correct.

## Scope

Free functions **and** methods (per the issue-owner decision). The method path reuses
`methodParams` and the same name-keyed limit documented for series 060.

## Fail-loud preserved

Every non-bare forward, and every forward where the enclosing param is not itself a
`&mut` binding, stays exactly as today → cargo-loud if genuinely wrong. Never silent.

## Graduation

Flip the **VD5** pin in `tests/vecdeque-interop.test.ts` — 117 reframed it to a
read-only 2-hop chain precisely to sidestep this. Series 119 adds the `&mut` variants
(free-fn 2-hop and 3-hop, method 2-hop) plus a read-only regression guard.
