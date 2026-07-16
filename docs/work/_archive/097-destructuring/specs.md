# 097 — destructuring specs

Differential specs (compile TS→Rust, run it, assert stdout === Bun-run TS === pinned
literal) unless marked a plain fail-loud `test()`. Lives in
`packages/compiler/tests/destructuring.test.ts`. IDs map to design.md shapes A–D.

| ID | Source shape | Expect |
| --- | --- | --- |
| **A. array over a Vec variable → Option** | | |
| DS1 | `const arr: number[] = [10,20,30]; const [a,b] = arr;` then `console.log(a,b)` | `10 20` (each `Some(v)` prints the value) |
| DS2 | in-bounds + out-of-bounds: `const [a,b,c,d] = arr` (arr len 3) → log `a,b,c,d` | `10 20 30 undefined` (OOB → None → `undefined`) |
| DS3 | Option consumed via `??`: `const [a] = arr; console.log(a ?? 0)` | element value (`unwrap_or`) |
| DS4 | Option narrowed: `const [x] = arr; if (x !== undefined) { console.log(x + 1) }` | value+1 (narrowed to `T`) |
| DS5 | string array `const s: string[] = ["hi","yo"]; const [a,b] = s; console.log(a,b)` | `hi yo` (element `.cloned()`) |
| DS6 | source stays live after destructure → still usable (`console.log(arr.length)` after) | pinned; source not moved out |
| **B. renamed object fields** | | |
| DS7 | `interface P{x:number;y:number} const p:P={x:3,y:7}; const {x:px,y}=p; console.log(px,y)` | `3 7`; rust contains `P { x: px, y }` |
| DS8 | all-renamed `const {x:a,y:b}=p` | pinned; rust `P { x: a, y: b }` |
| DS9 | mixed shorthand+renamed `const {x, y:yy}=p` | pinned; rust `P { x, y: yy }` |
| **C. array rest** | | |
| DS10 | `const [head, ...tail] = arr` (arr `[1,2,3]`) → `console.log(head, tail.length)` | `1 2` (head Some, tail `[2,3]`) |
| DS11 | rest reaches empty: `const [a, ...rest] = one` (len 1) → `rest.length` | `0` (`unwrap_or_default` → `[]`) |
| DS12 | tail is a real Vec — sum it: `const [_, ...t] = arr; let s=0; for (const n of t) s+=n;` | pinned sum |
| **D. object rest** | | |
| DS13 | `interface P3{a:number;b:number;c:number} … const {a, ...rest}=o; console.log(a, rest.b, rest.c)` | pinned; rust synth `__anonymous_struct_` + `let (a, rest) =` |
| DS14 | two structurally-identical object-rests dedupe to one synth struct | rust contains exactly one `struct __anonymous_struct_` for that shape |
| DS15 | object-rest with a **renamed** kept field `const {a:aa, ...rest}=o` | pinned |
| DS16 | rest struct field carries a non-scalar (String) field | pinned |
| **fail-loud residuals** | | |
| DS-FL1 | default value `const {x = 1} = p` | `toThrow(/default|AssignmentPattern|destructuring/i)` |
| DS-FL2 | array default `const [a = 0] = arr` | `toThrow(/default|AssignmentPattern|destructuring/i)` |
| DS-FL3 | nested pattern `const {p: {x}} = obj` | `toThrow(/nested|destructuring/i)` |
| DS-FL4 | object-rest over a non-named-struct source | `toThrow(/non-named-struct|destructuring/i)` |
| DS-FL5 | array-destructure over an unknown element-type source | `toThrow(/element type|destructuring/i)` |

Notes:
- DS1/DS2 pin the Option-typed semantics (in-bounds `Some`, OOB `None`→`undefined`);
  DS3/DS4 confirm the shipped 066 consumption paths (`??`, narrowing) work on the
  new bindings.
- DS7–DS9 keep the existing 067 all-shorthand emission (`P { x, y }`) intact while
  adding the renamed spelling.
- DS13/DS14 pin the anonymous-struct synthesis + dedup (FNV-1a canonical name).
- DS-FL1..5 pin the kept residual boundaries.
- BD1–BD13 (series 067 `binding-destructure.test.ts`) must stay green; **BD10**
  (Vec-source fail-loud) is now graduated — that test flips to `.not.toThrow()` and
  moves its intent into DS1.
