# 098 — String methods · specs

Each `SM*` row is a differential (compile → cargo run → compare stdout to
Bun-run TS). Each `SM-FL*` row is a transpiler fail-loud pin. Maps to
`tests/string-methods.test.ts`.

## Supported (differentials)

| ID | Source shape | Observes |
|---|---|---|
| SM1 | `s.indexOf("b")`, `s.indexOf("z")` | char-indexed position; `-1` on miss |
| SM2 | `s.indexOf("a", 2)` | `from` skips earlier matches |
| SM3 | `s.lastIndexOf("a")` | last occurrence; `-1` on miss |
| SM4 | `s.at(0)`, `s.at(-1)` via `??` | negative-from-end; consumed with `?? "?"` |
| SM5 | `const c = s.at(10); console.log(c)` | OOB → `Option::None` → prints `undefined` (066) |
| SM6 | `if (s.at(-1) ...)` bound + narrowing `!== undefined` | `if let Some` narrowing over `.at` |
| SM7 | `s.padStart(5)`, `s.padEnd(5)` (1-arg) | default-space pad |
| SM8 | `"a".concat("b", "c")` | `strConcat` / `format!` join |
| SM9 | `s.split(",", 2)` | at most `limit` pieces, remainder dropped |
| SM10 | `s.split("", 2)` | empty-sep + limit → `split_chars_limit` |
| SM11 | `s.substr(2)`, `s.substr(1, 2)`, `s.substr(-2)` | from-end start; length count |
| SM12 | `"héllo".length` | char count (`.chars().count()`), non-ASCII = 5 not 6 bytes |

`.length` in an f64-mixing binary (`s.length - 1`, `s.length === n`, `i < s.length`
with an `f64` counter) stays a pre-existing numeric-pass gap — the `len` node is
`usize` and the sibling literal/counter is `f64`. It affects arrays' `.len()`
identically, is unchanged by this series (byte-`len` had the same mismatch), and is
not graduated here. The clean contexts are the bare `usize` uses (Display print,
index/`.get`).

## Fail-loud (pins)

| ID | Source shape | Rejects because |
|---|---|---|
| SM-FL1 | `s.charCodeAt(0)` | UTF-16 code-unit fork deferred |
| SM-FL2 | `s.codePointAt(0)` | UTF-16 / code-point fork deferred |
| SM-FL3 | `String.fromCharCode(65)` | UTF-16 static fork deferred |
| SM-FL4 | `s.match(/x/)` | RegExp deferred (Tier 3) |
| SM-FL5 | `s.localeCompare(t)` | locale-aware ops not modeled |
