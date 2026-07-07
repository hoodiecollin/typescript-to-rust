# 039 — Array iteration adapters: `some` / `every` / `reduce` (plan)

Draws from the 029 catalog (Tier 1 · Array — iteration) and the 027 hybrid rule.
These three map **cleanly** to native Rust iterator adapters (Route **N**), so no
`tslib` — the callback lowers to a real closure (the 033 value-position-closure
machinery), and the result is idiomatic Rust.

## Routing (all native)

| JS | Rust | Closure arity |
|---|---|---|
| `xs.some(x => p)` | `xs.iter().any(\|&x\| p)` → `bool` | 1 |
| `xs.every(x => p)` | `xs.iter().all(\|&x\| p)` → `bool` | 1 |
| `xs.reduce((acc, x) => e, init)` | `xs.iter().fold(init, \|acc, &x\| e)` | 2 |

`some`/`every` reuse the single-param closure shape already used by `map`/`filter`
(`|&x|` copies the Copy element out of the `.iter()` borrow). `reduce` introduces
the **two-param closure** shape (`acc`, `elem`): `acc` is owned (the fold
accumulator, seeded by `init`), `elem` arrives from `.iter()` so it binds `&elem`.

## Scope / fail-loud residuals (unchanged contract)

- `reduce` **requires** an explicit `init` argument this slice. No-init `reduce`
  (`xs.reduce(cb)`) returns the first element and is `Option`-typed — deferred
  (fail-loud) with the `find`/undefined work.
- `find` is **not** in this slice: it returns `T | undefined` → `Option<T>`, whose
  faithful consumption needs the nullish/`undefined` semantics (issue #7). Left
  fail-loud.
- Callbacks stay single-statement expression/`return` arrows (033 limit); a
  user-declared method of the same name is a native call (`analysis.methodNames`
  guard), never hijacked.

## Differential proof

Each spec compiles the emitted Rust (COMPILES) and matches the TS-run stdout
(BEHAVES): `some`/`every` print `true`/`false`; `reduce` prints the folded number.
