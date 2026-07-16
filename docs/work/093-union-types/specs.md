# 093 — Union types → Rust `enum` — specs

Specs live in `packages/compiler/tests/union-types.test.ts` (new file). Each row
is a **differential** (emitted Rust runs; its stdout === the TS-via-Bun run)
unless marked *fail-loud pin* (a `test()` asserting `compile()` throws). Fixtures
prefer integer arithmetic to dodge float-format edge cases — the union machinery,
not number fidelity, is under test. IDs group by impl stage (design §10).

## 1a — literal unions (A/B): `TSTypeAliasDeclaration`, fieldless enum, Display

| ID | Source (essentials) | stdout | Exercises |
|----|--------------------|--------|-----------|
| **UN-LIT1** | `type Dir = "north"\|"south"\|"east"\|"west"; const d: Dir = "north"; console.log(d);` | `north` | alias→enum, construct, Display round-trip |
| **UN-LIT2** | `switch(d){case "north": return "south"; …}` (all 4 arms) | `south` | `switch` → exhaustive variant `match` |
| **UN-LIT3** | `console.log(d === "north", d === "south");` | `true false` | `===` on a literal union (derive PartialEq; JS = identity here) |
| **UN-LIT4** | `type Bit = 0\|1; const b: Bit = 1; console.log(b);` | `1` | numeric-literal union, Display prints the number |
| **UN-LIT5** | `type Lvl = 1\|2\|3; switch(l){case 2: return "mid"; …}` | `mid` | numeric-literal `switch` → match by value |
| **UN-LIT6** | `type K = "has-dash"\|"with space"\|"123"; const k: K="has-dash"; console.log(k);` | `has-dash` | sanitize variant ident, exact-literal Display |
| **UN-LIT7** | `const xs: Dir[] = ["north","south"]; console.log(xs.length, xs[0]);` | `2 north` | `Vec<enum>` (sized, no Box) |
| **UN-LIT8** | `interface Cmd { dir: Dir } const c: Cmd = {dir:"east"}; console.log(c.dir);` | `east` | literal union as a struct field |
| **UN-LIT9** | `function f(d: "a"\|"b"): string { return d; } console.log(f("a"));` | `a` | **anonymous** inline literal union → `__anonymous_union_<hash>` |
| **UN-LIT10** | `function g(x: "a"\|"b"): "b"\|"a" { return x; } console.log(g("a"));` | `a` | **order-independent dedup**: param & return unify to one enum |

## 1b — discriminated inline-object unions (C): struct variants + match

| ID | Source (essentials) | stdout | Exercises |
|----|--------------------|--------|-----------|
| **UN-DISC1** | `type Shape = {kind:"circle",r:number}\|{kind:"square",s:number}; area(sh){switch(sh.kind){case "circle": return sh.r*sh.r; case "square": return sh.s*sh.s;}}` → `area({kind:"circle",r:2})` | `4` | struct-variant enum; `kind` consumed; `switch(x.kind)` → variant match binding `r` |
| **UN-DISC2** | `area({kind:"square",s:3})` | `9` | the other arm; construction coercion drops `kind` |
| **UN-DISC3** | `if (sh.kind === "circle") return sh.r*sh.r; else return sh.s*sh.s;` | `4` | `if`-ladder narrowing → `if let`/match (reuses 049 ladder machinery) |
| **UN-DISC4** | `const shapes: Shape[] = [{kind:"circle",r:1},{kind:"square",s:2}]; for (const sh of shapes) total += area(sh);` | `5` | `Vec<Shape>` heterogeneous, iterate + match |
| **UN-DISC5** | `type Msg = {kind:"reset"}\|{kind:"set",value:number};` → `apply({kind:"reset"})`, `apply({kind:"set",value:5})` | `0 5` | **unit variant** (discriminant-only member) beside a struct variant |
| **UN-DISC6** | `type Ev = {kind:"move",x:number,y:number}\|{kind:"stop"};` | `…` | multi-field variant |
| **UN-DISC7** | `type T = {type:"a",n:number}\|{type:"b",n:number};` (discriminant named `type`) | `…` | **Fork-N2 precedence** — `type` recognized as discriminant |
| **UN-DISC8** | `type R = {kind:"ok",msg:string}\|{kind:"err",code:number}; console.log(r.kind==="ok"?…);` | `…` | `String`-bearing variant → derive `PartialEq` not `Copy` |
| **UN-DISC9** | variant field is itself a declared struct (`{kind:"at",p:Point}`) | `…` | nested struct-in-variant, ownership composes |

## 1c — anonymous synthesis + non-ident-safe literal hardening

| ID | Source (essentials) | stdout | Exercises |
|----|--------------------|--------|-----------|
| **UN-ANON1** | `function f(sh: {kind:"c",r:number}\|{kind:"s",side:number}): number {…}` | `…` | **anonymous discriminated** union synth name + variants |
| **UN-ANON2** | `type K = "has-dash"\|"has_dash"; const a:K="has-dash"; const b:K="has_dash"; console.log(a,b);` | `has-dash has_dash` | sanitize **collision** → ordinal disambiguation; both round-trip exactly |
| **UN-ANON3** | `type K = ""\|"x"; const e:K=""; console.log(e==="", e);` | `true ` (trailing empty) | empty-string literal → `Empty` variant, exact round-trip |
| **UN-ANON4** | value of anonymous `{kind:"a"}\|{kind:"b"}` returned as `{kind:"b"}\|{kind:"a"}` | `…` | order-independent hash dedup for object unions |

## 1d — named-interface members (D) + primitive/mixed (F/G)

| ID | Source (essentials) | stdout | Exercises |
|----|--------------------|--------|-----------|
| **UN-IFACE1** | `interface Circle {kind:"circle";r:number} interface Square {kind:"square";s:number} type Shape = Circle\|Square;` | `4` | **newtype variants** `Circle(Circle)`; narrow via shared discriminant |
| **UN-PRIM1** | `function fmt(x: string\|number): string { if (typeof x === "string") return x; else return "num"; } console.log(fmt("hi"), fmt(5));` | `hi num` | **primitive union** synth newtype enum, `typeof` → match |
| **UN-PRIM2** | `string\|number`, take the number branch and use it | `…` | `Num(f64)` variant binding |
| **UN-PRIM3** | `type SP = string\|Point;` (primitive + named struct) | `…` | mixed primitive + nominal newtype variants |
| **UN-MIXED1** | `type State = "loading"\|{kind:"done",data:number}; show(s){ if (typeof s==="string") return s; else return "done"; }` → `show("loading")`, `show({kind:"done",data:1})` | `loading done` | **mixed literal + object** (G): fieldless `Loading` + struct `Done{data}` |

## 1e — non-discriminated object unions (E) via `in`

| ID | Source (essentials) | stdout | Exercises |
|----|--------------------|--------|-----------|
| **UN-NOND1** | `type X = {a:number}\|{b:string}; get(x){ if ("a" in x) return "A"; else return x.b; } console.log(get({a:1}), get({b:"hi"}));` | `A hi` | field-set-named variants (`A`/`B`), `"a" in x` → match |
| **UN-NOND2** | multi-field members `{name:string,age:number}\|{id:number}` | `…` | sorted field-set variant name (`AgeName`/`Id`) |

## null / undefined composition (any stage — reuses 042/091)

| ID | Source (essentials) | stdout | Exercises |
|----|--------------------|--------|-----------|
| **UN-NULL1** | `function f(m: Shape\|undefined): number { if (m === undefined) return -1; return area(m); }` → `f(undefined)`, `f({kind:"square",s:2})` | `-1 4` | `Shape\|undefined` → `Option<Shape>`, narrow then match |
| **UN-NULL2** | `type MDir = Dir\|undefined; const m: MDir = undefined; console.log(m);` | `undefined` | `Option<enum>`, None prints `undefined` (042-C) |

## Fail-loud pins (residual boundary — design §9)

| ID | Source | Why loud |
|----|--------|----------|
| **UN-FL1** | `type Tree = {kind:"leaf",v:number}\|{kind:"node",kids:Tree[]}` | recursive union — needs `Box` insertion → follow-up |
| **UN-FL2** | `type Wrap<T> = {some:T}\|{none:true}` | generic union — generics × unions → follow-up |
| **UN-FL3** | fielded union used as a `Record`/Map key or Set element | no `Hash`/`Eq` on fielded variants (fieldless literal unions **are** allowed) |
| **UN-FL4** | discriminated union narrowed on a **non-discriminant** field | "narrow on the discriminant `<field>`" |
| **UN-FL5** | `type Pair = [number, number]` (non-union, non-trivial alias) | tuple alias — trivial synonyms only this series |

## Rationale

A TS union is a structural sum type; Rust's `enum` is a nominal one. The mapping
is faithful because (1) the discriminant literal *is* the tag, consumed into the
variant name; (2) construction coerces a value to its variant exactly as `Option`
`Some`-wraps; (3) every narrowing form (`switch`, `if`-`===`-ladder, `typeof`,
`in`) is a `match`; (4) a `Shape[]` is a sized `Vec<Shape>` needing no `Box<dyn>`,
which is *more* idiomatic than the interface/class trait-object path for a **closed**
set. Anonymous unions dedup by an order-independent structural hash so two
spellings of the same union are one Rust type. `null`/`undefined` members strip to
the existing `Option<T>` path, leaving unions and nullability orthogonal.
