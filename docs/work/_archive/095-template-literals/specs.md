# 095 — Template literal specs

Differential specs (compile TS→Rust, run it, assert stdout === Bun-run TS === pinned
literal) unless marked a plain fail-loud `test()`. Lives in
`packages/compiler/tests/template-literals.test.ts`.

| ID | Source shape | Expect |
| --- | --- | --- |
| TMPL1 | `` `plain text` `` (no holes) | `plain text` |
| TMPL2 | `` `hi ${name}` `` (string interp) | `hi Ada` |
| TMPL3 | `` `${count} items` `` (number interp, leading hole) | `3 items` |
| TMPL4 | `` `${a}-${b}` `` (adjacent holes, string) | `x-y` |
| TMPL5 | multiple mixed scalar holes + literal chunks | pinned |
| TMPL6 | bool interp `` `flag=${b}` `` | `flag=true` |
| TMPL7 | expression hole `` `sum=${n + 1}` `` | `sum=6` |
| TMPL8 | escapes: newline + `"`/backslash in cooked text | pinned (round-trips) |
| TMPL9 | `const s: string = \`v=${n}\`` (typed-position) then log | `v=42` |
| TMPL10 | template as a `+` operand / nested in another template | pinned |
| TMPL11 | array interp `` `${[1,2,3]}` `` → JS join | `1,2,3` + rust contains `tslib::array::join` |
| TMPL12 | string-array interp `` `${names}` `` | `a,b,c` |
| TMPL13 | plain-struct interp `` `${point}` `` → `[object Object]` | `[object Object]` |
| TMPL14 | optional interp present `` `x=${maybe}` `` (Some) | `x=5` |
| TMPL15 | optional interp absent → `undefined` | `x=undefined` + rust contains `fmt_opt` |
| TMPL16 | union-enum interp `` `${u}` `` where `u: string \| number` → Display inner | pinned |
| TMPL-FL1 | tagged template `` tag`hi` `` | `toThrow` (Unsupported) |
| TMPL-FL2 | nested/object-element array interp `` `${[[1],[2]]}` `` | `toThrow(/nested\|object array/)` |
| TMPL-FL3 | Map/Set interp `` `${myMap}` `` | `toThrow(/template interpolation/)` |

Notes:
- TMPL13's struct-`[object Object]` and TMPL15's `undefined` follow JS `String()`
  semantics and the dialect's existing `console.log`/`fmt_opt` convention.
- TMPL11/12 assert the emitted-Rust substring so the array path is pinned to
  `tslib::array::join` (not an accidental `Display` fallthrough).
