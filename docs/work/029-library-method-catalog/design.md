# 029 — Library-method catalog + rankings (plan)

> **Status: PLAN / living catalog.** The comprehensive inventory of JS
> built-in/library surfaces we might translate, each scored by **popularity**
> (how often real TS uses it) and **complexity** (effort + how cleanly it maps to
> Rust), with the routing decision (native idiomatic vs `tslib` — see 027) and
> the gating dependency. This is the master list 027 draws sub-series from.
>
> Legend — Pop/Cx: ★1 (low) … ★5 (high). Route: **N** = emit idiomatic native
> Rust, **T** = route through `tslib` (JS-quirk fidelity), **N/T** = native when
> args are clean, `tslib` when quirky. Dep: **cl** = needs value-position
> closures; **serde** = needs serde; **—** = ready once its container lands.

## Tier 1 — do first (high popularity, tractable)

### Array — iteration (Dep: cl)
| Method | Pop | Cx | Route | Notes |
|---|---|---|---|---|
| `map` | ★5 | ★2 | N/T | native `.iter().map().collect()`; **T** if index/array arg used |
| `filter` | ★5 | ★2 | N/T | `.iter().filter().cloned().collect()` |
| `forEach` | ★4 | ★1 | N | `for x in &xs { … }` |
| `reduce` | ★4 | ★3 | N/T | `.iter().fold(init, …)`; **T** if index used |
| `find` | ★4 | ★2 | N | `.iter().find().cloned()` → `Option` |
| `some` / `every` | ★3 | ★1 | N | `.iter().any()` / `.all()` |
| `flatMap` / `flat` | ★2 | ★3 | N/T | `.flat_map()`; deep `flat(n)` → **T** |
| `sort` | ★4 | ★4 | **T** | default = lexicographic **string** compare, in place, returns self |
| `map` w/ index | ★3 | ★3 | **T** | `.enumerate()` under the hood |

### Array — access/mutation (Dep: —, some cl)
| Method | Pop | Cx | Route | Notes |
|---|---|---|---|---|
| `push` / `pop` | ★5 | ★1 | N | direct |
| `length` | ★5 | ★1 | N | `.len()` |
| `includes` / `indexOf` | ★4 | ★1 | N | `.contains()` / `.position()` |
| `slice` | ★4 | ★3 | **T** | negative + out-of-range indices clamp (JS quirk) |
| `at` | ★3 | ★2 | **T** | negative index |
| `splice` | ★3 | ★4 | **T** | remove+insert, returns removed; no direct Rust analog |
| `join` | ★4 | ★1 | N | `.join(sep)` (after `to_string` map) |
| `concat` / spread | ★3 | ★2 | N | `.extend()` / chained |
| `reverse` | ★2 | ★1 | N | `.reverse()` |

### String (Dep: —)
| Method | Pop | Cx | Route | Notes |
|---|---|---|---|---|
| `split` | ★5 | ★2 | N/T | `.split().collect()`; empty-sep + limit → **T** |
| `trim` / `trimStart/End` | ★4 | ★1 | N | `.trim()` etc. |
| `toUpperCase`/`toLowerCase` | ★4 | ★1 | N | (Unicode-casing caveat noted) |
| `includes`/`startsWith`/`endsWith` | ★4 | ★1 | N | direct |
| `replace` / `replaceAll` | ★4 | ★2 | **T** | `replace` = **first** only (quirk) vs `replaceAll` |
| `padStart` / `padEnd` | ★3 | ★2 | **T** | not in std |
| `slice` / `substring` | ★3 | ★3 | **T** | negative/swapped indices, char vs byte |
| `charAt` / `[i]` | ★3 | ★3 | **T** | UTF-16 code unit vs Rust `char`/byte |
| `repeat` | ★2 | ★1 | N | `.repeat(n)` |

### Object / JSON (Dep: serde)
| Method | Pop | Cx | Route | Notes |
|---|---|---|---|---|
| `Object.keys`/`values`/`entries` | ★4 | ★2 | N | over a `HashMap` |
| `Object.assign` / spread | ★3 | ★3 | N/T | merge semantics |
| `hasOwnProperty` / `in` | ★3 | ★1 | N | `.contains_key()` |
| `JSON.stringify` | ★4 | ★4 | **T** | JS number/formatting rules; serde + custom |
| `JSON.parse` | ★4 | ★3 | T | serde_json → typed target |

## Tier 2 — do next (medium)

### Map / Set (Dep: —)
| Method | Pop | Cx | Route | Notes |
|---|---|---|---|---|
| `Map` get/set/has/delete | ★3 | ★1 | N | `HashMap` direct |
| `Set` add/has/delete | ★3 | ★1 | N | `HashSet` direct |
| `Map`/`Set` iteration | ★2 | ★2 | N | insertion order? → `IndexMap` if needed |

### Number / Math (Dep: —)
| Method | Pop | Cx | Route | Notes |
|---|---|---|---|---|
| `Math.floor/ceil/round/abs` | ★4 | ★1 | N | `f64` methods (round: half-away vs half-even quirk → note) |
| `Math.min/max` | ★3 | ★1 | N/T | variadic + NaN handling |
| `Math.random` | ★3 | ★2 | T | needs an RNG dep; determinism concerns |
| `Number.parseInt/parseFloat` | ★3 | ★3 | **T** | radix, trailing-garbage tolerance (quirk) |
| `.toFixed` / `.toString(radix)` | ★3 | ★3 | **T** | formatting quirks |

### JS iterators / `Symbol.iterator` (Dep: 025 generators)
| Feature | Pop | Cx | Route | Notes |
|---|---|---|---|---|
| custom iterables | ★2 | ★3 | N | `impl Iterator`; composes with 025 |
| spread of iterables | ★3 | ★2 | N | `.collect()` / `.extend()` |

## Tier 3 — defer / out of scope

| Surface | Pop | Cx | Verdict |
|---|---|---|---|
| `Promise.all/race/allSettled` | ★3 | ★4 | defer — `join!`/`select!` (tokio); own series |
| Event emitters (`on`/`emit`) | ★2 | ★5 | out of scope — channels/callbacks, poor pure-logic fit |
| `RegExp` | ★3 | ★4 | defer — `regex` crate; syntax-compat caveats |
| `Date` | ★3 | ★4 | defer — `chrono`/`time`; TZ semantics |
| Proxy / Reflect / `with` | ★1 | ★5 | **never** — no static Rust target (stay `DialectError`) |
| `structuredClone` | ★1 | ★3 | defer — `Clone` derive interplay |

## Sequencing recommendation (feeds 027 sub-series)

1. **Closures land first** (gating dep for most of Tier 1 Array/iteration).
2. Array access/mutation (no-closure subset) — quick wins.
3. String (no dep) — quick wins.
4. Array iteration (needs closures).
5. Object/JSON (needs serde).
6. Map/Set, Number/Math.
7. Iterators (after 025 generators).
8. Tier 3 only on demand.

## How this catalog is used

- 027 (`tslib`) picks methods off Tier 1/2 as sub-series; the **Route** column is
  the native-vs-`tslib` decision, the **Dep** column the prerequisite.
- Each method sub-series is spec-first: a native-path differential and, for **T**
  methods, a differential that observes the specific JS quirk (proving fidelity).
- Keep this table **living**: as methods land, annotate them; as new surfaces are
  requested, slot them in with Pop/Cx/Route/Dep.

## Open questions

- Insertion-order maps: adopt `IndexMap` to match JS `Map`/object key order, or
  accept `HashMap`'s unordered semantics with a note? (Order is observable in JS;
  leaning `IndexMap` where iteration order is used.)
- UTF-16 vs Rust `char`/byte indexing for strings: pick one model and document
  the divergence, or emulate UTF-16 in `tslib` for fidelity? (Leaning: document
  divergence; emulate only if a fixture demands it.)
