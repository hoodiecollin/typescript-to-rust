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

## 1d — named-interface members (D) + primitive/mixed (F) via `typeof`

Case **D** maps each named interface to a **newtype variant** `Shape::Circle(Circle)`
preserving the nominal inner struct; the discriminant field stays inside it and the
match binds the whole struct (`Shape::Circle(sh) => sh.r`). Case **F** maps
`string`/`number`/`boolean` + a single named struct to newtype variants
`Str(String)`/`Num(f64)`/`Bool(bool)`/`Point(Point)`, narrowed by `typeof`
(`"string"`→`Str`, `"object"`→the struct). The narrowed binding is retyped in the
arm so `x + 1` / string methods resolve. **G** (mixed literal + object) is deferred —
see the fail-loud pins.

| ID | Source (essentials) | stdout | Exercises |
|----|--------------------|--------|-----------|
| **UN-NAMED1** | `interface Circle {kind:"circle";r:number} interface Square {kind:"square";s:number} type Shape = Circle\|Square;` `switch(sh.kind)` | `4 9` | **newtype variants** `Circle(Circle)`; discriminant inside struct; `switch(sh.kind)` → `Shape::Circle(sh)` |
| **UN-NAMED2** | `type R = Ok\|Err;` `switch(r.kind){case "ok": return r.msg;…}` | `hi e` | `String` field read out of a newtype variant (clone-to-owned prelude) |
| **UN-NAMED3** | `const c: Circle = {…}; const sh: Shape = c;` + `if (x.kind==="circle")` ladder | `25` | **construct from a named value** → `Shape::Circle(c)`; if-ladder |
| **UN-NAMED4** | `function nx(n: At\|Origin)` (inline, no alias) | `7 0` | **anonymous** named-interface union → `__anonymous_union_<hash>` |
| **UN-PRIM1** | `type SN = string\|number; if (typeof x==="string") return x; else return "n"+x;` | `hello n2` | primitive union → newtype enum, `typeof` if-ladder → match; retyped binding |
| **UN-PRIM2** | `switch (typeof x) { case "string": …; case "number": … }` | `STR NUM` | `switch(typeof x)` → variant match |
| **UN-PRIM3** | `type V = string\|number\|boolean;` three-way `typeof` ladder | `s n b` | three primitive variants, `Bool(bool)` |
| **UN-PRIM4** | `type SP = string\|Point;` `if (typeof v==="string") … else v.x` | `hi 7` | mixed primitive + nominal newtype; `"object"` arm binds the struct |
| **UN-PRIM5** | construct from identifiers into `SN[]`, consume | `hello 42` | value → variant by static type; `Vec<union>` |

## 1e — non-discriminated object unions (E) via `in`

Case **E** (all inline objects, no shared discriminant) maps to struct variants whose
names come from the **sorted field-name set** PascalCased (`{name,age}` → `AgeName`),
narrowed by `"field" in x` where the field is present in exactly one variant.
Construction matches an object literal's exact field-name set to a variant.

| ID | Source (essentials) | stdout | Exercises |
|----|--------------------|--------|-----------|
| **UN-NONDISC1** | `type AB = {a:number}\|{b:string}; if ("a" in x) return ""+x.a; else return x.b;` | `1 hi` | field-set-named variants (`A`/`B`), `"a" in x` → struct-variant match |
| **UN-NONDISC2** | `{name:string,age:number}\|{k:string,v:string}` | `9 kb` | sorted field-set variant name (`AgeName`/`KV`); multi-field bind |
| **UN-NONDISC3** | `{a}\|{b}\|{c}` three-way `in`-ladder | `1 2 3` | three-way `in` narrowing, trailing-else covers last variant |

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
| **UN-FL6** | `type S = "loading" \| { kind: "done"; data: number }` (mixed literal + object, G) | irregular two-level narrowing (equality for the literal, `.kind`/`typeof` for the object) → precise fail-loud, deferred to a follow-up |

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
