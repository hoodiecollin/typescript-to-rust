# 096 — `++` / `--` specs

Differential specs (compile TS→Rust, run it, assert stdout === Bun-run TS === pinned
literal) unless marked a plain fail-loud `test()`. Lives in
`packages/compiler/tests/update-expr.test.ts`.

| ID | Source shape | Expect |
| --- | --- | --- |
| UPD1 | statement `x++;` on a local then log | incremented |
| UPD2 | statement `x--;` | decremented |
| UPD3 | `for (let i = 0; i < 3; i++)` accumulate | loop runs 3× |
| UPD4 | `for` counting **down** with `i--` | loop runs correctly |
| UPD5 | field `this.n++` in a class method (statement) | field incremented |
| UPD6 | index `a[0]++` (statement) on a number array | element incremented |
| UPD7 | prefix statement `++x;` (same effect as postfix) | incremented |
| UPD8 | closure body `() => { x++; }` mutating a captured local | mutation observed |
| UPD9 | **postfix value** `const y = x++;` → y is old, x is new | pinned (old & new) |
| UPD10 | **prefix value** `const y = ++x;` → y is new | pinned (new & new) |
| UPD11 | **value in a loop test** `while (n-- > 0)` counts down | pinned |
| UPD12 | **value as return** `return x++` from a fn | old value returned |
| UPD13 | **value as array index** `arr[i++]` reads element then advances i | pinned (element + i) + rust asserts usize (no `1.0` on the index counter) |
| UPD14 | postfix in a call arg `f(i++)` | old value passed |
| UPD-FL1 | value-position on an **index target** `const y = a[0]++;` | `toThrow(/non-identifier target in a value position/)` |
| UPD-FL2 | value-position on a **field target** `const y = obj.n++;` | `toThrow(/non-identifier target in a value position/)` |

Notes:
- UPD3/UPD4/UPD13 exercise the numeric usize-counter path (`i += 1`, not `i += 1.0`);
  UPD13 pins the emitted Rust to confirm no `1.0` leaks onto an index counter.
- UPD9–UPD14 exercise the value-form block-temp (postfix old / prefix new).
- UPD-FL1/FL2 pin the value-position non-identifier-target fail-loud boundary;
  the same targets in **statement** position (UPD5/UPD6) succeed.
