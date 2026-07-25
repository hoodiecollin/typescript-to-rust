# 118 — Union-type residuals (#82) — specs

Specs live in `packages/compiler/tests/union-residuals.test.ts` (new file). Each
row is a **differential** (emitted Rust compiles + runs under cargo; its stdout ===
the TS-via-Bun run) unless marked *fail-loud pin* (a `test()` asserting `compile()`
throws, message-matched where a message is promised). Fixtures prefer integer
arithmetic and `String`/`bool` fields so the union machinery — not float format or
Hash/Eq-of-f64 — is under test. IDs group by residual (design order).

Fixture conventions (matching the shipped tests): union narrowing uses the explicit
`else` form (like 093's E); a `Map.get` `Option` is printed via `?? default`; a
fielded (object) union key uses the **same** key value for `set` + `get` (JS keys
objects by reference, Rust structurally — equal only when it's the same value).

This series also **flips three obsolete 093 pins** in
`packages/compiler/tests/union-types.test.ts`:

- **UN-FL6** (mixed literal+object) → graduates: the `toThrow(/mixes literal and
  object members/)` pin becomes `.not.toThrow()` (covered as differentials here).
- **UN-FL1** (recursive) → stays loud but upgrades from bare `toThrow()` to
  `toThrow(/recursive.*#59/)`.
- **UN-FL4 / UN-FL3** had no code pins; they are now covered below (a differential
  for the eligible key case, a message-matched pin for the loud cases).

---

## (e) Non-discriminant narrow → transpiler-loud (fail-loud pin)

| ID | Source (essentials) | Why loud |
|----|--------------------|----------|
| **UNR-NDN-FL1** | `type Shape = {kind:"circle";r:number}\|{kind:"square";s:number}; function f(sh:Shape){ if (sh.r === 2) return 1; return 0; }` | `toThrow(/narrow on the discriminant 'kind'/)` — narrowing on `r`, not the discriminant |

## (a) recursive + (b) generic → retained loud, tailored to #59 (fail-loud pins)

| ID | Source (essentials) | Why loud |
|----|--------------------|----------|
| **UNR-REC-FL1** | `type Tree = {kind:"leaf";v:number}\|{kind:"node";kids:Tree[]}` used in a fn | `toThrow(/recursive.*#59/)` — self-ref field needs #59's boxed model |
| **UNR-GEN-FL1** | `type Wrap<T> = {some:T}\|{none:true}` used at an instantiation | `toThrow(/generic union.*#59/)` — type-params × unions → #59 |

## (d) Fielded / literal union as a Map key / Set element

Eligibility = every variant payload is `Hash+Eq` (fieldless literal, or fields of
`String`/`bool`/integer/nested-Hash+Eq). An **f64** payload stays loud. On
eligibility the enum's `derives` gain `Hash`,`Eq` (emitter unchanged).

| ID | Source (essentials) | stdout | Exercises |
|----|--------------------|--------|-----------|
| **UNR-KEY1** | `type Dir="n"\|"s"; const m=new Map<Dir,number>(); m.set("n",1); m.set("s",2); console.log(m.get("n"), m.get("s"));` | `1 2` | **literal union as Map key** — Hash+Eq derives added |
| **UNR-KEY2** | `type Bit=0\|1; const s=new Set<Bit>(); s.add(1); console.log(s.has(1), s.has(0));` | `true false` | **numeric-literal union as Set element** (unit variants always Hash+Eq) |
| **UNR-KEY3** | `type K={kind:"a";name:string}\|{kind:"b";name:string}; const m=new Map<K,number>(); const k:K={kind:"a",name:"x"}; m.set(k,1); console.log(m.get(k) ?? -1);` | `1` | **fielded discriminated union as key**, `String` field → Hash+Eq; same-key set+get (JS ref = Rust structural); ownership clone-when-live |
| **UNR-KEY4** | `type Dir="n"\|"s"; const s=new Set<Dir>(); s.add("n"); s.add("n"); console.log(s.size);` | `1` | key dedup via `Eq`+`Hash` (SameValueZero-free — no f64) |
| **UNR-KEY-FL1** | `type P={kind:"a";n:number}\|{kind:"b";n:number}; const m=new Map<P,number>();` | *pin* | `toThrow(/Hash\+Eq\|f64/)` — f64 variant payload not hashable |

## (f) Two named structs, no shared discriminant → `in`-narrowed newtype enum

| ID | Source (essentials) | stdout | Exercises |
|----|--------------------|--------|-----------|
| **UNR-NND1** | `interface Foo{a:number} interface Bar{b:string} type FB=Foo\|Bar; function f(x:FB):string{ if("a" in x) return ""+x.a; return x.b; } console.log(f({a:1}), f({b:"z"}));` | `1 z` | newtype variants `Foo(Foo)`/`Bar(Bar)`; **object-literal construction** by inner field-set; `"a" in x` → variant match binding the inner struct |
| **UNR-NND2** | `const foo:Foo={a:5}; const x:FB=foo; console.log(one(x));` (one uses `"a" in x`) | `5` | **construct from a named value** → `FB::Foo(foo)` (newtype-inner match) |
| **UNR-NND3** | `function g(x: Foo\|Bar):string{…}` (inline, no alias) + three-way is out; two-way trailing-else covers `Bar` | `1 z` | **anonymous** named-non-disc union → `__anonymous_union_<hash>`; trailing `else` = last variant |
| **UNR-NND-FL1** | `interface P{x:number} interface Q{x:number} type PQ=P\|Q;` used | *pin* | `toThrow()` — no distinguishing field → ambiguous `in`-narrow, unregistered |

## (c) Mixed literal + object union (G) → single-level mixed `match`

Literal members → unit variants; object members (sharing a `.kind` discriminant) →
struct variants; an equality if-ladder mixing `x === "lit"` and `x.kind === "k"`
rungs lowers to one flat `match`. `narrow:"mixed"`.

| ID | Source (essentials) | stdout | Exercises |
|----|--------------------|--------|-----------|
| **UNR-MIX1** | `type State = "loading" \| { kind:"done"; result:number }; function f(s:State):number{ if(s==="loading") return -1; return s.result; } console.log(f("loading"), f({kind:"done",result:7}));` | `-1 7` | unit variant + struct variant; `s==="loading"` → unit-variant arm; trailing else = object variant binds `result` |
| **UNR-MIX2** | `type S2="a"\|"b"\|{kind:"n";v:number}; f: if(s==="a")1 else if(s==="b")2 else s.v; console.log(f("a"),f("b"),f({kind:"n",v:5}));` | `1 2 5` | **multiple literal rungs** + object trailing else |
| **UNR-MIX3** | `type S3="idle"\|{kind:"run";pid:number}\|{kind:"stop";code:number}; if(s==="idle")0 else if(s.kind==="run")s.pid else s.code; console.log(f("idle"),f({kind:"run",pid:4}),f({kind:"stop",code:9}));` | `0 4 9` | **mixed rung shapes** — value-eq `s==="idle"` beside field-eq `s.kind==="run"` → one flat match over unit + two struct variants |
| **UNR-MIX4** | `function h(s: "on" \| {kind:"dim";level:number}):number{ if(s==="on") return 100; return s.level; } console.log(h("on"), h({kind:"dim",level:3}));` | `100 3` | **anonymous inline** mixed union (previously silently skipped) → `__anonymous_union_<hash>` |
| **UNR-MIX5** | `type State=…; const arr:State[]=["loading",{kind:"done",result:2}]; for(const s of arr) …` | `…` | `Vec<mixed-union>` heterogeneous storage + construction of both variant shapes |
| **UNR-MIX-FL1** | `type Bad = "x" \| { a:number };` used | *pin* | `toThrow(/object part has no shared discriminant/)` — single object, no `.kind` |

## null / undefined composition (reuses 042)

| ID | Source (essentials) | stdout | Exercises |
|----|--------------------|--------|-----------|
| **UNR-NULL1** | `type State="loading"\|{kind:"done";result:number}; function label(st:State):number{ if(st==="loading") return -1; else return st.result; } function f(opt:State\|undefined):number{ if(opt===undefined) return -2; else return label(opt); } const l:State="loading"; const d:State={kind:"done",result:4}; console.log(f(undefined),f(l),f(d));` | `-2 -1 4` | `mixed-union \| undefined` → `Option<enum>`, narrow-None then delegate to the mixed match (distinct param names; typed-var construction — see design's construction-coercion residual) |
