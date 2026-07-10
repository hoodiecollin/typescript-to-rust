# 056 — Bitwise operators · specs

Differential oracle unless noted: emitted Rust compiles **and** its run matches the
TS run (via Bun). A handful assert against the **Rust** result where the dialect
deliberately diverges from JS's 32-bit truncation, or assert a fail-loud
`UnsupportedError`, or inspect the emitted text / `module.warnings`.

## Behaves (differential-match JS on in-range values)

1. **`&` `|` `^`** — `a & b`, `a | b`, `a ^ b` on small integers match JS.
2. **`~`** — `~a` (→ Rust `!a`) matches JS (`~6 === -7`).
3. **`<<` `>>`** — `a << n`, `a >> n` (arithmetic, sign-propagating) match JS for
   in-range values.
4. **operator values flow through bindings** — `const c = a & b; …c…` compiles and
   matches (the result binding is inferred `i128` with no annotation).
5. **precedence** — `a & b | c` groups as `(a & b) | c` (Rust `&` tighter than `|`),
   matching JS; a mixed `a + b & c` parenthesizes correctly.

## Diverges (assert the Rust result; documented non-JS behavior)

6. **`>>>`** — `-1 >>> 0` is `4294967295` in JS but **`-1`** in our `i128` dialect;
   the spec asserts the Rust value and is annotated as intended divergence.
   `16 >>> 2` (in-range) still matches JS (`4`).
7. **shift-count masking** — `1 << 130` does **not** panic; it is `1 << (130 & 127)`
   = `1 << 2` = `4` (which also happens to match JS's `1 << (130 & 31)`).

## Boundaries (compile across the type edge)

8. **as index** — a bitwise result used as an array index compiles (`arr[i & 1]` →
   `arr[(… as usize)]`).
9. **into float arithmetic** — a bitwise result used in float arithmetic compiles
   (`(a & b) * 2.5` → `((… ) as f64) * 2.5`) and matches JS.

## Fail-loud (`UnsupportedError`)

10. **fractional literal operand** — `6.5 & 3` is rejected (we refuse JS's silent
    `ToInt32` truncation).
11. **negative shift count** — `4 >> -1` is rejected.

## Diagnostics

12. **warning channel** — a module using any bitwise op accumulates a non-fatal
    warning on `module.warnings` mentioning the wide-int (`i128`) divergence.
13. **inline note** — the emitted line carries `// bitwise: wide-int (i128), not JS
    int32`.

## Non-bitwise regression

14. **`&&` / `||` unaffected** — logical operators still lower to native
    short-circuit ops (not bitwise), no `i128`, no note.
