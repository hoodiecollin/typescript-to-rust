# 119 — Specs (transitive `refMut`)

Cargo-compiled + differential (emitted Rust runs; stdout === TS-via-Bun), same
harness as 117. IDs `TR*`.

## Graduations (RED before impl — cargo rejects today)

- **TR1 free-fn 2-hop `&mut` forward** (the #102 repro): `inner(q){ q.push(9) }`,
  `outer(q){ inner(q) }`, `outer(a)`. `a` reflects the push.
  - `extra`: emitted `fn outer(q: &mut Vec<f64>)` and the call site is a bare
    reborrow `inner(q)` (no `&mut q`).
- **TR2 free-fn 3-hop chain** (fixpoint convergence): `push1(q){ q.push(1) }`,
  `mid(q){ push1(q) }`, `top(q){ mid(q) }`, `top(a)`. All three params promote to
  `&mut Vec`.
- **TR3 method-param 2-hop `&mut` forward**: a class method `fill(q)` that forwards
  `q` to a free fn `add(q){ q.push(...) }`; the caller's array reflects the push.
- **TR4 forward + local direct mutation coexist**: `outer(q){ q.push(0); inner(q) }`
  where `inner` also pushes — `q` already `refMut` from the direct push; the forward
  must stay a bare reborrow, not `&mut q` (no double-borrow regression).

## Regression guards (GREEN-from-start)

- **TR5 read-only forward still works** (guards the `&&T → &T` path we must not
  disturb): `read(q){ return q.length }`, `fwd(q){ return read(q) }` — no promotion,
  no reborrow rewrite; `fwd.q` stays `&Vec`.
- **TR6 non-bare forward stays as-is**: `outer(q){ inner(q.slice()) }` passes a fresh
  `Vec` — `outer.q` stays `&Vec` (read-only), and `inner` gets an owned/`&mut` fresh
  temp. (Differential: behaves; `a` is unchanged by `outer`.)
