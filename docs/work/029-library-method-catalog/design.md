# 029 — Library-method catalog + rankings (plan)

> **Status: PLAN / living catalog.** The comprehensive inventory of JS
> built-in/library surfaces we might translate, each scored by **popularity**
> (how often real TS uses it) and **complexity** (effort + how cleanly it maps to
> Rust), with the routing decision (native idiomatic vs `tslib` — see 027) and
> the gating dependency. This is the master list 027 draws sub-series from.
>
> Legend — Pop/Cx: ★1 (low) … ★5 (high). Route: **N** = emit idiomatic native
> Rust; **Tf** = route through a `tslib` **function** (JS-quirk fidelity, the
> default helper form); **Tm** = a `tslib` **macro** (reserved for genuine
> variadics / literal-ergonomics / heterogeneous-without-a-trait — see the
> routing principle below); **N/Tf** = native when args are clean, `tslib::fn`
> when quirky. Dep: **cl** = needs value-position closures; **serde** = needs
> serde; **—** = ready once its container lands.

## Routing principle — native vs `tslib::fn` vs `tslib::macro`

Two orthogonal decisions, kept separate (this is the codegen-helper boundary that
governs 027):

1. **native vs `tslib`** is the *behavioral-fidelity* axis. Route to `tslib` only
   when the JS runtime semantics differ from the obvious Rust (`.sort()`'s
   lexicographic string compare, `.at(-1)`'s negative index, `String()`/
   `console.log` coercion, `replace`-first-only, `JSON.stringify` number rules,
   loose equality). If the mapping is clean, emit **native** idiomatic Rust — the
   emitter/inference passes decide *type & ownership*, which must stay native and
   fail-loud, never hidden behind a helper.
2. **`fn` vs `macro`** is an *ergonomics-only* axis, applied **only after** we've
   decided a surface routes to `tslib`. **Default to a (generic) `fn`.** Reach for
   `macro_rules!` in exactly three cases:
   - **genuine variadics** — `js_log!(a, b, c)` (console.log), `min!`/`max!`
     (`Math.min`/`max` over a variable arg count);
   - **literal ergonomics** — `map!{ "a" => 1 }` (record/`Map` literal
     construction), `set!{ … }`;
   - **heterogeneous-without-a-trait** — args of differing types with no shared
     trait to write one `fn` signature against.

   Everything else — `sort`, `slice`, `at`, `padStart`, `split`-with-limit,
   `replace`, `toFixed`, `parseInt` — is a **`tslib::fn`** (often an extension-trait
   method on `Vec`/`str`). A **coercion macro is an anti-pattern**: e.g. an
   `idx!(e)` emitting `e as usize` is non-idiomatic, silently lossy (f64→usize
   truncates, negatives saturate), and would *mask* a type bug — the opposite of
   fail-loud (this is the exact hazard series 030/031 gap A surfaced). Type/
   ownership coercions belong in the inference passes, never a helper.

## Tier 1 — do first (high popularity, tractable)

### Array — iteration (Dep: cl)
| Method | Pop | Cx | Route | Notes |
|---|---|---|---|---|
| `map` | ★5 | ★2 | N/Tf | native `.iter().map().collect()`; **Tf** if index/array arg used |
| `filter` | ★5 | ★2 | N/Tf | `.iter().filter().cloned().collect()` |
| `forEach` | ★4 | ★1 | N | `for x in &xs { … }` |
| `reduce` | ★4 | ★3 | N/Tf | **✓ landed (039)** `.iter().fold(init, …)` (explicit init); no-init/index → later |
| `find` | ★4 | ★2 | N | `.iter().find().cloned()` → `Option` — **deferred** (needs `undefined` fidelity, #7) |
| `some` / `every` | ★3 | ★1 | N | **✓ landed (039)** `.iter().any()` / `.all()` |
| `flatMap` / `flat` | ★2 | ★3 | N/Tf | `.flat_map()`; deep `flat(n)` → **Tf** |
| `sort` | ★4 | ★4 | **Tf** | **✓ landed (040)** default lexicographic **string** compare + comparator → `sort_by` |
| `map` w/ index | ★3 | ★3 | **Tf** | `.enumerate()` under the hood |

### Array — access/mutation (Dep: —, some cl)
| Method | Pop | Cx | Route | Notes |
|---|---|---|---|---|
| `push` / `pop` | ★5 | ★1 | N | direct |
| `length` | ★5 | ★1 | N | `.len()` |
| `includes` / `indexOf` | ★4 | ★1 | N | `.contains()` / `.position()` |
| `slice` | ★4 | ★3 | **Tf** | **✓ landed (040)** negative + out-of-range clamp; `slice`/`slice_from` |
| `at` | ★3 | ★2 | **Tf** | **✓ landed (027)** negative index |
| `splice` | ★3 | ★4 | **Tf** | remove+insert, returns removed; no direct Rust analog |
| `join` | ★4 | ★1 | N | `.join(sep)` (after `to_string` map) |
| `concat` / spread | ★3 | ★2 | N | `.extend()` / chained |
| `reverse` | ★2 | ★1 | N | `.reverse()` |

### String (Dep: —)
| Method | Pop | Cx | Route | Notes |
|---|---|---|---|---|
| `split` | ★5 | ★2 | N/Tf | `.split().collect()`; empty-sep + limit → **Tf** |
| `trim` / `trimStart/End` | ★4 | ★1 | N | `.trim()` etc. |
| `toUpperCase`/`toLowerCase` | ★4 | ★1 | N | (Unicode-casing caveat noted) |
| `includes`/`startsWith`/`endsWith` | ★4 | ★1 | N | direct |
| `replace` / `replaceAll` | ★4 | ★2 | **Tf** | `replace` = **first** only (quirk) vs `replaceAll` |
| `padStart` / `padEnd` | ★3 | ★2 | **Tf** | not in std |
| `slice` / `substring` | ★3 | ★3 | **Tf** | negative/swapped indices, char vs byte |
| `charAt` / `[i]` | ★3 | ★3 | **Tf** | UTF-16 code unit vs Rust `char`/byte |
| `repeat` | ★2 | ★1 | N | `.repeat(n)` |

### Object / JSON (Dep: serde)
| Method | Pop | Cx | Route | Notes |
|---|---|---|---|---|
| `Object.keys`/`values` | ★4 | ★2 | N | **✓ landed (041)** over an `IndexMap` (insertion order); `.keys()`/`.values()` |
| `Object.entries` | ★3 | ★3 | N | **deferred** — needs pair-*array* access over a Rust tuple |
| `Object.assign` / spread | ★3 | ★3 | N/Tf | **deferred** — merge + variadic sources + returns-target |
| `hasOwnProperty` / `in` | ★3 | ★1 | N | `.contains_key()` |
| `JSON.stringify` | ★4 | ★4 | **Tf** | JS number/formatting rules; serde + custom |
| `JSON.parse` | ★4 | ★3 | Tf | serde_json → typed target |

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
| `Math.min/max` | ★3 | ★1 | N/Tm | binary → native `f64::min`; **variadic → `min!`/`max!` macro** (+ NaN handling) |
| `Math.random` | ★3 | ★2 | Tf | needs an RNG dep; determinism concerns |
| `Number.parseInt/parseFloat` | ★3 | ★3 | **Tf** | radix, trailing-garbage tolerance (quirk) |
| `.toFixed` / `.toString(radix)` | ★3 | ★3 | **Tf** | formatting quirks |

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
  the native-vs-`tslib` decision (and, within `tslib`, `fn` vs `macro`), the
  **Dep** column the prerequisite.
- Each method sub-series is spec-first: a native-path differential and, for
  **Tf**/**Tm** methods, a differential that observes the specific JS quirk
  (proving fidelity). When routed to `tslib`, default to a `tslib::fn`; only the
  variadic/literal-ergonomic cases (`js_log!`, `min!`/`max!`, `map!{…}`) earn a
  `tslib::macro` — never a type/ownership coercion macro (§ Routing principle).
- Keep this table **living**: as methods land, annotate them (mark the landed
  route `N`/`Tf`/`Tm`); as new surfaces are requested, slot them in with
  Pop/Cx/Route/Dep.

## Open questions

- ~~Insertion-order maps: adopt `IndexMap` … or accept `HashMap`'s unordered
  semantics?~~ **Resolved (2026-07-06, series 041): adopt `IndexMap` uniformly for
  `Record`/object types** — order is observable via `Object.keys`/`values`, so the
  backing type preserves insertion order to match JS everywhere.
- UTF-16 vs Rust `char`/byte indexing for strings: pick one model and document
  the divergence, or emulate UTF-16 in `tslib` for fidelity? (Leaning: document
  divergence; emulate only if a fixture demands it.)
