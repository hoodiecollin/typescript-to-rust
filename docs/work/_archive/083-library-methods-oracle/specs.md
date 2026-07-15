# 083 — Specs (RED → GREEN, oracle-driven differential)

> Every spec differential-matches (compile → `cargo run` → TS-via-Bun) unless it is
> a reject-spec (asserts a fail-loud `UnsupportedError`). IDs are the stable
> anchors. Spec files (no barrel, focused):
> `receiver-oracle.test.ts`, `library-methods-string.test.ts`,
> `library-methods-number.test.ts`, `library-methods-array.test.ts`,
> `library-methods-key.test.ts`.

## Scope reconciliation (discovered during code-mapping)

The codebase is **ahead** of the 083 design's "Out of scope" list and the task's
"pure-impl catalog" list. Already shipped in prior series (verified by probe —
they compile / lower without `UnsupportedError`, and update the 029 catalog only):

- `find` → `iterFind` (`Option<T>`), lands via 048/066 — **shipped**.
- `Object.entries` → `objectEntries` (series 043) — **shipped**.
- `Object.assign` (homogeneous merge → `mapBuild`) — **shipped** (heterogeneous
  still fail-loud, confirmed by reject-spec ASSIGN-FL).
- `JSON.stringify` → `jsonStringify` + `tslib::json::stringify` (series 045) —
  **shipped**; number-format fidelity already handled (see NOTE-JSON below), so
  083 only *adds* the Infinity/NaN → `null` + undefined-omission differential
  coverage if a gap is found.
- `JSON.parse` (typed + `Value` fallback) — shipped; bare `JSON.parse` stays
  fail-loud only in the sense of the std-shim series (out of 083 scope).

Genuinely missing (the 083 work):

- **Slices 1–8**: the whole primitive-method dispatch backbone + String / Number /
  Math / Array-tail catalog rows. `this.count.toString()`, `s.toUpperCase()`,
  `getName().toUpperCase()`, `Math.floor(x)`, `m.get(k)` with `k: string` param —
  all currently emit invalid Rust (`.toString()`, `Math.floor(..)`, `&&str`) with
  **no** `UnsupportedError`: a silent emitter-side compile-fail. These are the RED
  cases.
- **`flatMap` / deep `flat(n)`** — arrow callback rejected today (RED).
- **variadic `Math.min`/`Math.max`** — emit `Math.min(..)` today (RED); route to a
  `min!`/`max!` macro (Tm).

## Slice 1 — backbone + `.toString()`

- **RT1** `this.count.toString()` (an `f64` field) → `self.count.to_string()`;
  differential-matches (was invalid `.toString()`).
- **RT2** `getName().toUpperCase()` — un-annotated-return receiver resolved via the
  oracle tier → `.to_uppercase()`; differential-matches.
- **RT3** a `local.field` string method (`p.name.toUpperCase()` where `p: Person`)
  → `.to_uppercase()`; differential-matches.
- **RT4** an identifier string method (`s.toUpperCase()`, `s: string`) →
  `.to_uppercase()`; differential-matches.
- **RT-REG1** (regression) an identifier `Map` receiver still lowers byte-for-byte
  (`.contains_key(..)` etc. unchanged) — pins `collectionOf` rewrite is behavior-
  preserving.
- **RT-REG2** (regression) an identifier string `.length` / array `.length` still
  `.len()`; a `getName()` with **no** oracle source threaded still fails-loud (the
  no-source path returns null → generic fallthrough).
- **RT-FL1** (fail-loud) a method on an **unmodeled** receiver (a `boolean`
  receiver method we don't model, e.g. `b.valueOf()`) stays fail-loud (generic
  method → invalid Rust, no primitive route claimed).

## Slice 2 — `&str`-key borrow fix

- **KEY1** `m.get(k)` with `k: string` param over `Map<string, number>` →
  `m.get(k)` (bare, no outer `&`); differential-matches (was `&&str` E0277).
- **KEY2** `m.has(k)` / `m.delete(k)` with `k: string` param → `contains_key(k)` /
  `shift_remove(k)` (bare).
- **KEY3** `s.has(k)` with `k: string` param over `Set<string>` →
  `s.contains(k)`.
- **KEY-REG1** (regression) a **literal** key `m.get("a")` keeps `m.get(&"a"...)`
  path exactly (owned/literal keys unchanged). An `OrderedFloat` numeric key and a
  `structKey` key keep their `&`-wrapped path.

## Slice 3 — inferred / method-return receiver resolution (lift noLib for receivers)

- **INF1** `getName().toUpperCase()` (un-annotated `getX()` return, only knowable
  by inference) → resolved (this is RT2, re-pinned as the #48 driver).
- **INF2** chained-through-builtin receiver: `a.trim().toUpperCase()` — the inner
  `.trim()` returns `string`, resolved through the builtin signature →
  `.trim().to_uppercase()`.
- **INF3** (#48) string concat where **both operands are method calls**:
  `getA().toString() + getB().toString()` detected as string concat (`format!`).
- **INF-FL1** (fail-loud) an inferred receiver of an **unmodeled** type still →
  null → fail-loud (the classifier maps only to modeled types).

## Slice 4 — String methods, native rows

Each differential-matches. `s: string`.

- **STRN1** `s.toUpperCase()` / `s.toLowerCase()` → `.to_uppercase()` /
  `.to_lowercase()`.
- **STRN2** `s.trim()` / `s.trimStart()` / `s.trimEnd()` → `.trim()` /
  `.trim_start()` / `.trim_end()`.
- **STRN3** `s.includes(t)` / `s.startsWith(t)` / `s.endsWith(t)` → `.contains(..)`
  / `.starts_with(..)` / `.ends_with(..)`.
- **STRN4** `s.repeat(n)` → `.repeat(n as usize)` (n floored via numeric pass).

## Slice 5 — String methods, tslib rows (quirk differentials)

- **STRT1** `s.replace(a, b)` → `tslib::string::replace_first` — **first match
  only** (quirk-observing: a string with two matches replaces one).
- **STRT2** `s.replaceAll(a, b)` → `.replace(a, b)` (native, all matches).
- **STRT3** `s.split(sep)` (non-empty sep) → `.split(sep).map(str::to_string)
  .collect()`.
- **STRT4** `s.split("")` (empty sep) → `tslib::string::split_chars` (JS splits to
  code units; quirk differential over multi-byte input, documented divergence).
- **STRT5** `s.slice(a, b)` / `s.substring(a, b)` / `s.charAt(i)` →
  `tslib::string::str_slice` / `substring` / `char_at` (UTF-16-vs-char quirk
  differentials; documented divergence for non-BMP, char-based this slice).

## Slice 6 — Number/Math, native rows

- **NUMN1** `Math.floor(x)` / `Math.ceil(x)` / `Math.round(x)` / `Math.abs(x)` →
  `x.floor()` / `.ceil()` / `.round()` / `.abs()`. `round` quirk-note: JS
  round-half-up vs Rust round-half-away — a differential pins the agreed set;
  half-negative edge routed to tslib only if a fixture demands.
- **NUMN2** `Math.min(a, b)` / `Math.max(a, b)` (binary) → `a.min(b)` / `a.max(b)`.
- **NUMN3** `n.toString()` (no radix) where differential-equal → native
  `to_js_string` (see NUMT — plain `.to_string()` diverges on `-0`/magnitudes, so
  even the "plain" path routes through `tslib::number::to_js_string`).

## Slice 7 — Number/Math, tslib rows (quirk differentials)

- **NUMT1** `n.toFixed(d)` → `tslib::number::to_fixed` (formatting + rounding).
- **NUMT2** `n.toString(radix)` → `tslib::number::to_radix`.
- **NUMT3** `Number.parseInt(s)` / `parseInt(s, radix)` →
  `tslib::number::parse_int` (radix, trailing-garbage tolerance quirk).
- **NUMT4** `Number.parseFloat(s)` → `tslib::number::parse_float`.
- **NUMT5** `to_js_string` fidelity — `String(n)` / `n.toString()` differential
  over integers (`1` not `1.0`), fractions (`1.5`), and `-0`.

## Slice 8 — Array-access tail

`xs: Array<number>` / `Array<string>`.

- **ARR1** `xs.join(sep)` → `.iter().map(to_string).collect::<Vec<_>>()
  .join(sep)`; differential-matches.
- **ARR2** `xs.concat(ys)` → chained (native), returns a new `Vec`.
- **ARR3** `xs.reverse()` → `.reverse()` (in place) / a reversed copy per JS
  return semantics.
- **ARR4** `xs.splice(start, count, ...items)` → `tslib::array::splice` (remove +
  insert, returns removed).

## Slices 9+ — pure-impl catalog rows unblocked, still missing

- **FLAT1** `xs.flatMap(f)` → `.iter().flat_map(..).collect()` (lifted callback).
- **FLAT2** `xs.flat()` (depth 1) / `xs.flat(n)` deep → native/`tslib` per depth.
- **MINMAX1** variadic `Math.min(a, b, c)` / `Math.max(...)` → `min!`/`max!`
  **macro** (Tm route) — the sanctioned variadic macro (NaN-propagating like JS).

## Verified-still-shipped catalog rows (green regressions, catalog update only)

- **SHIP-FIND** `arr.find(p)` → `iterFind` → `Option<T>`, `undefined` miss.
- **SHIP-ENTRIES** `Object.entries(obj)` → `objectEntries`.
- **SHIP-ASSIGN** homogeneous `Object.assign(a, b)` → `mapBuild`.
- **ASSIGN-FL** heterogeneous / different-shape `Object.assign` stays fail-loud
  (reject-spec).
- **SHIP-JSON** `JSON.stringify(v)` → `jsonStringify` + `tslib::json::stringify`.

## NOTE-JSON — number-format fidelity (already partly landed, series 045)

`tslib::json::stringify` already renders `f64` integrals without `.0` and uses
Rust's shortest-round-trip `{}` for fractions (matches JS shortest-round-trip in
the common range). Gaps checked in 083: (a) JS renders `Infinity`/`NaN` as `null`
inside a value position — serde_json rejects non-finite `f64` at `to_value`, so a
non-finite must be pre-mapped to `null` in the writer; (b) JS **omits**
`undefined`/function-valued properties — under the Option model an `undefined`
field is `None`, which serde serializes as `null` (JS keeps the key as `null` only
for `null`, and *omits* it for `undefined`). Full `undefined`-omission fidelity
needs the writer to distinguish `None`-from-`undefined` vs explicit `null`, which
is a genuine dialect question (the 066 model collapses `null≡undefined`). **If a
differential exposes this, STOP and report rather than ship a silent divergence.**
</content>
</invoke>
