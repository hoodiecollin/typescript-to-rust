# 073 specs — `finally` + an escaping jump (carrier-enum)

Graduates 063's sole deferred residual (issue #31): a `finally` block combined with
a `return`/`break`/`continue`/`throw`-propagation that escapes the `try`/`catch`.
The finally+escape construct lowers to a per-construct control **carrier** enum
(`Normal | Return(V) | Err(E) | Break(t) | Continue(t)`); the dispatch site runs the
`finally` body **natively, once, before** replaying the recorded escape. Everything
else stays on 063's labeled block.

Each spec differential-matches: compile → `cargo run` → compare stdout with the same
program run through Bun. IDs map to `value-yielding-try-finally.test.ts`.

## RETURN + finally

- **CR1** `try { return f(n) } finally { F }` — `F` runs, then the value returns; both
  a non-throwing and a throwing input differential-match, and `F` is observed exactly
  once, before the return. (This is Collin's committed shape.)
- **CR2** `try/finally` no catch, body throws — `F` runs, then the error propagates
  (`Ctrl::Err`) to a caller that recovers.

## BREAK / CONTINUE + finally

- **CB1** `outer: for (…) { try { break outer } finally { F } }` — `F` runs, then
  `break 'outer` fires; labeled target.
- **CC1** `outer: for (…) { try { continue outer } finally { F } }` — `F` runs, then
  `continue 'outer`.
- **CB2** unlabeled `for (…) { try { break } finally { F } }` — `F` runs, then the
  implicit nearest-loop `break`.

## catch-arm escape + finally

- **CX1** `try { throw E } catch (e) { return 1 } finally { F }` — the `catch` runs,
  `F` runs, then `return 1`.

## Self-escaping finally (finally pre-empts the pending escape)

- **CS1** `try { return 1 } finally { return 2 }` → `2` (finally's return masks the
  pending return; dispatch is dead code).
- **CS2** `try { return 1 } finally { throw E }` → throws `E` (pending return masked;
  the error propagates to a recovering caller).

## Nesting (inner→outer finally order)

- **CN1** `try { try { return 1 } finally { F1 } } finally { F2 }` → `F1` then `F2`,
  then returns `1`.

## Regressions (still 063's labeled block, unchanged)

- **RG1** `finally` *without* an escape still takes 063's labeled-block path
  (`try { result = f() } finally { F }` then `return result`).
- **RG2** an escape *without* a `finally` still takes 063's labeled-block path
  (`try { return f() } catch { return d }`).
