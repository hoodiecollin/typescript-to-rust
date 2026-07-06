# 027 — `tslib` runtime crate as a translation target (plan)

> **Status: PLAN — BLOCKED on value-position closures.** The recommendation is
> the **hybrid** model below, but the *first method sub-series* cannot start
> until the blocker clears.
>
> ⛔ **Hard prerequisite: value-position closures.** Arrows today only normalize
> at top level (`const f = (…) => …` → a free `fn`); an arrow passed as an
> *argument* (`xs.map(x => x*2)`) is not yet lowered — see the arrow deferrals in
> plan.md. Every Tier-1 iteration method (`map`/`filter`/`reduce`/`forEach`/…)
> needs a real closure to translate the callback. So: **land a closures series
> first**, then 027's iteration methods. The no-closure subset (array
> access/mutation, string, Map/Set — see 029) *can* proceed ahead of the blocker.
> The 029 catalog itself is always ready to write/refine.

## Problem

To translate JS native-prototype methods (`Array`/`Object`/`String`/`Map`/…),
the emitter would otherwise special-case each method's semantics inline. That
puts JS-quirk fidelity (e.g. `.sort()` default *string* compare, `.map`'s index
arg, negative-index `.at()`, `.splice` return value) into codegen, where it is
hard to test in isolation and easy to get subtly wrong.

## Proposal — a small runtime crate, `tslib`

A hand-written, tested Rust crate that owns JS-semantics fidelity, so the emitter
picks a *target symbol* instead of reimplementing behavior. Mirrors the existing
`ts-primitives`/`TsAny` precedent. E.g.:

```
someArr.sort()            →  tslib::array::sort_default(&mut arr)      // string-compare quirk lives here
str.padStart(4, "0")      →  tslib::string::pad_start(&s, 4, "0")
obj.hasOwnProperty("k")   →  tslib::object::has_own(&map, "k")
```

The crate is a fixed dependency of the generated `.scratch` crate (like tokio),
version-pinned; its tests are ordinary `cargo test` and can assert JS parity
directly.

## The tension: idiomatic vs. faithful

A blanket `tslib::` target produces *non-idiomatic* Rust — `tslib::array::map(&a, f)`
where a Rust programmer expects `a.iter().map(f).collect()`. Since the whole
point of targeting Rust (Option A memory model) is idiomatic output, routing
everything through `tslib` undercuts the project's thesis.

## Recommendation — **hybrid** (emit native where clean, `tslib` where quirky)

Split methods into two buckets:

- **Clean-mapping → emit idiomatic native Rust** (no `tslib`):
  - `.map` / `.filter` / `.forEach` / `.reduce` → `.iter().map(...)` /
    `.filter(...)` / `for` / `.fold(...)` (when the JS index arg is unused).
  - `.length` → `.len()`; `arr[i]` → indexing; `.push` → `.push`.
  - `.includes` → `.contains`; `Object.keys` → `.keys()`.
- **Quirk-heavy → route through `tslib`** (fidelity > idiom):
  - `.sort()` (default lexicographic-string comparison, in place, returns self),
    `.splice`, `.at(-1)` (negative index), `.map` *when the index/array args are
    used*, loose-equality helpers, `parseInt`/`parseFloat` edge cases,
    `JSON.stringify` formatting.

Decision rule the emitter applies per call site: *is there a faithful idiomatic
Rust form for this method with the args actually used?* Yes → native. No →
`tslib`. This keeps output idiomatic in the common case and correct in the
quirky case, and confines the ugly-but-faithful code to one audited crate.

## Ranking of library surfaces to build (complexity × popularity)

Sequence, highest payoff first (see also 029 for the full catalog):
1. **Array iteration** (`map`/`filter`/`reduce`/`forEach`/`find`/`some`/`every`)
   — very high popularity, medium complexity. **Blocked on value-position
   closures.** First once closures land.
2. **Array mutation/access** (`push`/`pop`/`slice`/`includes`/`indexOf`/`at`)
   — high popularity, low–medium complexity. Some quirks (`at` negative, `slice`
   bounds) → `tslib`.
3. **Object/JSON** (`Object.keys`/`values`/`entries`, `JSON.parse`/`stringify`)
   — high popularity, medium complexity (serde interplay for JSON).
4. **String** (`split`/`trim`/`padStart`/`replace`/`toUpperCase`) — high
   popularity, low complexity; a few `tslib` quirks (`replace` first-vs-all).
5. **Map/Set** — medium popularity, low complexity (direct to `HashMap`/`HashSet`).
6. **JS iterators / `Symbol.iterator`** — medium/medium (composes with 025's
   generator→`Iterator`).
7. **Event emitters** — low popularity in pure-logic TS, high complexity
   (channels/callbacks). **Out of scope.**

## Crate layout (when built)

```
tslib/
  src/
    array.rs    // sort_default, splice, at, map_indexed, ...
    string.rs   // pad_start, replace_first, ...
    object.rs   // has_own, entries, ...
    json.rs     // stringify (JS formatting), parse
    lib.rs
  tests/        // JS-parity assertions per fn
```
Pinned in the generated crate's manifest alongside tokio.

## Specs sketch (per method sub-series)

- Native path: `[1,2,3].map(x => x*2)` → `.iter().map(...).collect()`;
  differential prints the result. (Requires closures.)
- `tslib` path: `[10,1,2].sort()` → `tslib::array::sort_default`; differential
  observes the **string** sort order `[1,10,2]` (JS quirk), proving fidelity.

## Open questions

- Where is the native/`tslib` decision made — a table in the emitter, or does
  `tslib` also provide *idiomatic* thin wrappers so the emitter always targets
  `tslib` but some are `#[inline]` pass-throughs? (Leaning: table in emitter;
  keep native output truly native.)
- Do closures need to land as their own series (prerequisite) before *any* of
  this? **Yes** — call it out as the gating dependency.
