# 098 — String methods (the everyday-stuff campaign, final item)

## Status

Design. Last item of the "everyday scripting" campaign
(unions 093 → ternary 094 → template literals 095 → `++`/`--` 096 →
destructuring 097 → **string methods 098**).

## Not greenfield — a deferral-graduation

Series **083** (`docs/work/_archive/083-library-methods-oracle/`) already shipped
**21** string methods over the unified `receiverTypeOf` gate: `toString`,
`toUpperCase`/`toLowerCase`, `trim`/`trimStart`/`trimEnd`, `includes`/
`startsWith`/`endsWith`, `repeat`, `replace`/`replaceAll`, `split`(1-arg +
empty-sep quirk), `slice`/`substring`/`charAt`, `padStart`/`padEnd` (2-arg), and
`.length`. All char-indexed, with the UTF-16-vs-`char` divergence **resolved and
documented** in 029 (char-indexed; UTF-16 emulation lands only on demand).

So — like 097 — this series **graduates the fail-loud residuals**, it does not
build the surface from scratch. Two classes of residual today are *cargo*-loud
(the emitter falls through to a native `s.someMethod(...)` call that rustc then
rejects with E0599) rather than a clean *transpiler* fail-loud, and a handful of
common methods aren't modeled at all.

## Collin's decisions (2026-07-16)

1. **Scope = the broader tail.** Graduate the common char-indexed methods
   *plus* the rarer forms: `indexOf`/`lastIndexOf`, `at`, `padStart`/`padEnd`
   1-arg (default-space), `concat`, `split(sep, limit)`, `substr`.
2. **`str.at(i)` → `Option<String>`** — JS-faithful (`at` returns `string |
   undefined`, unlike `charAt`'s `""`). Rides the shipped 066 Option model with
   no new machinery (`??` → `unwrap_or`, `if let Some` narrowing, `fmt_opt`
   printing, `!` → `unwrap` all free), exactly as 097's array-over-Vec elements.
3. **`.length` → char count.** String `.length` currently lowers to `.len()`
   (Rust **byte** length — diverges from JS for *any* non-ASCII and is
   inconsistent with the char-indexed `slice`/`charAt` model). Switch string
   receivers to `.chars().count()` so the string surface is internally
   consistent (correct for all ASCII + BMP; the non-BMP divergence is the same
   already-documented `char`-vs-UTF-16 one).
4. **Non-index-first, defer the UTF-16 fork.** The UTF-16-code-unit surface
   (`charCodeAt`, `codePointAt`, `String.fromCharCode`) is **not** graduated —
   but it moves from cargo-loud to a **clean transpiler fail-loud** with a
   message naming the deferral.

## What ships

### A. New string methods (graduated)

| TS | Rust target | Notes |
|---|---|---|
| `s.indexOf(x)` / `s.indexOf(x, from)` | `tslib::string::index_of(&s, x, from)` → `f64` | char-indexed first match at/after `from` (default 0); `-1` sentinel. `from<0`→0 (JS). |
| `s.lastIndexOf(x)` | `tslib::string::last_index_of(&s, x)` → `f64` | char-indexed last match; `-1` sentinel. 2-arg `fromIndex` → residual (fail-loud). |
| `s.at(i)` | `tslib::string::str_at(&s, i)` → `Option<String>` | negative-from-end; OOB → `None` → JS `undefined`. **Fixes a latent bug**: `at` previously mis-routed to the array-intended `tslib::array::at`. |
| `s.padStart(n)` / `s.padEnd(n)` | `tslib::string::pad_{start,end}(&s, n, " ")` | 1-arg default-space form (2-arg already shipped in 083). Both arities now handled in `stringMethod`. |
| `s.concat(a, b, …)` | the 080 `strConcat` node → `format!` | `a.concat(b, c)` ≡ `a + b + c`; parts render through the existing string-concat path. |
| `s.split(sep, limit)` | `tslib::string::split_limit(&s, sep, limit)` (or `split_chars_limit` for `""`) → `Vec<String>` | JS truncates to at most `limit` pieces (does **not** merge the remainder). |
| `s.substr(start)` / `s.substr(start, len)` | `tslib::string::substr_from` / `substr` → `String` | deprecated-but-common; `start<0` from end (clamped), `len` char count. char-indexed. |

`.at`'s `Option<String>` result is made visible to the light typer two ways so
the JS `undefined` renders correctly:
- **`optionExprType`** recognizes a `.at(…)` call on a `String` receiver →
  `option<String>` (so `console.log(s.at(i))` prints via `fmt_opt`).
- **`lowerVarDecl`** registers `const c = s.at(i)` as `bindingTypes[c] =
  option<String>` (so a later bare `console.log(c)` / narrowing resolve).
- `c ?? d` needs neither — `??` lowers to `.unwrap_or(d)` on the raw `Option`.

### B. `.length` → char count (string receivers only)

The `len` HIR node gains an optional `chars?: boolean`. `lowerMember`'s
`.length` case checks `receiverTypeOf`: a `String`/`str` receiver sets
`chars: true`; every other receiver (array/anything) keeps `len()`. Only the
**emitter** branches (`.chars().count()` vs `.len()`); `numeric.ts`/`rc.ts` key
on `kind === "len"` and are agnostic (both preserve the field — `numeric` only
reads `.object`, `rc` spreads `...e`). All the usize↔f64 numeric machinery is
untouched, so `s.length - 1`, `s.length` comparisons, and index math are
unchanged. A receiver the typer can't resolve as a string stays `.len()`.

### C. Clean fail-loud for the deferred surface (was cargo-loud)

`stringMethod` gains an explicit fail-loud set — for a **`String` receiver**
(so it never shadows an array/user method) these throw `UnsupportedError` with a
tailored message instead of falling through to a broken native emit:

- **UTF-16 fork:** `charCodeAt`, `codePointAt` → "uses UTF-16 code units
  (deferred); use `charAt`/`at` for a char, or `codePointAt` support is a later
  slice".
- **RegExp:** `match`, `matchAll`, `search` → "RegExp is deferred (Tier 3)".
- **Locale:** `localeCompare`, `normalize`, `toLocaleUpperCase`,
  `toLocaleLowerCase` → "locale-aware string ops are not modeled".

`String.fromCharCode` / `fromCodePoint` are **statics** (`String.fromCharCode(…)`,
a member call on the global `String`), handled in the static-call dispatch beside
`Math.*`/`Object.*` → the same UTF-16 fail-loud message.

Anything else a `String` receiver calls that isn't modeled keeps today's
fall-through (returns `null`) — the enumerated set is the deferral surface Collin
named; a blanket throw-on-unknown is a larger blast radius left out of scope.

## Residuals (stay fail-loud, documented)

- `lastIndexOf(x, fromIndex)` — the 2-arg backward-search form.
- `charCodeAt` / `codePointAt` / `String.fromCharCode` — the UTF-16 fork.
- `match` / `matchAll` / `search` / `replace(/re/)` — RegExp (Tier 3).
- `localeCompare` / `normalize` / `toLocale*Case` — locale.
- Non-string `concat` args ride the existing `strConcat` cargo boundary.
- `.length` on a receiver the typer can't resolve as a string stays byte-`len()`.

## Files touched

- `crates/tslib/src/string.rs` — `index_of`, `last_index_of`, `str_at`,
  `split_limit`, `split_chars_limit`, `substr`, `substr_from`.
- `packages/compiler/src/hir.ts` — `len` node gains `chars?: boolean`.
- `packages/compiler/src/emitter.ts` — `len` emits `.chars().count()` when `chars`.
- `packages/compiler/src/lower.ts` — `stringMethod` (new methods + fail-loud set),
  `.length` receiver check, `optionExprType` + `lowerVarDecl` `.at` Option
  registration, `String.fromCharCode` static fail-loud.
- `packages/compiler/tests/string-methods.test.ts` — the specs.
- `docs/dialect.md` — supported-method table + residuals.

## Test plan

Differentials (compile → cargo run → TS-via-Bun) for each new method incl. the
JS quirks (negative index, OOB, `-1` sentinel, limit truncation, non-ASCII char
count), plus fail-loud pins for every deferred method. IDs in `specs.md`.
