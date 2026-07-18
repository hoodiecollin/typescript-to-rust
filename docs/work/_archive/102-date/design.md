# 102 — `Date` / time onto a Rust crate — design

## Decisions (DECIDED 2026-07-16)

The sub-decisions (previously "recommended defaults") are now **DECIDED** — the owner
accepted every recommended default. The starred § sections below are retained as
rationale.

- **Crate (A): DECIDED = `chrono`** with `default-features = false, features = ["std"]`
  (no `clock`, no system-timezone database). Promoted from recommended default; picked
  for the one-call `to_rfc3339_opts(Millis, true)` exact `toISOString()` byte-parity.
- **Non-determinism (★B): DECIDED = (a) shim-injected clock**, mirroring `rng(seed)`.
  Bare `Date.now()` and no-arg `new Date()` are **fail-loud**, redirected to a seeded
  `@ttr/std` **`clock(epochMs)` → `Clock`** handle with `now()/date()/tick(ms)` (the
  direct structural twin of `rng(seed)`). The seed is an explicit call-site argument
  (a hidden harness seed is the ambient-global antipattern we're removing — rejected).
- **Timezone fidelity (★D): DECIDED = (a) UTC-normalize the short local accessors** —
  `getHours ≡ getUTCHours`, `getTimezoneOffset ≡ 0` — plus **pin `TZ=UTC`** in the
  harness, and document the divergence in `dialect.md`. The fail-loud-the-local-
  accessors alternative (b) is rejected (ergonomically hostile). This keeps everyday
  `d.getHours()` working and differential-stable.
- **Bare `Date` comparison (C): DECIDED = no** — require the explicit
  `d1.getTime() < d2.getTime()` form; a bare `date < date` reaching the emitter is
  fail-loud (no implicit `valueOf`→ms coercion surprise).

Issue **#56** (the Tier-3 umbrella: `RegExp` / `Date` / `Proxy` / `Reflect`), the
`Date` line item — "chrono/time crate; timezone + formatting fidelity". Graduates
the current fail-loud residual (`Date` is an *Unknown/undeclared type name* in the
`docs/dialect.md` Types table → generic `Unsupported <node>`) into a real,
differential-stable accepted surface.

This is a `needs-user-input` shape (it touches the accepted dialect surface and
the determinism/memory contract). Per the CLAUDE.md process rule, the
sub-decisions below are presented as **options + a recommended default**; the two
starred calls (non-determinism strategy, timezone fidelity) want Collin's sign-off
before impl.

## What this is

JS `Date` is two things wired together:

1. A **deterministic instant algebra** — construct from ms / ISO string / y-m-d
   fields, read fields back, do arithmetic and comparison on the epoch-ms integer,
   format to ISO. This part is a pure function of its inputs and is **fully
   differential-stable**. It is the bulk of the design and maps cleanly onto a
   Rust date/time crate.
2. A **wall-clock reader** — `Date.now()` and `new Date()` (no args) read the host
   clock. This is **non-deterministic**, exactly the `Math.random` problem, and
   cannot be compared by the differential oracle (the Bun run and the Rust run
   observe different instants). It gets the **`Math.random` → `rng(seed)`
   treatment**: fail-loud, redirect to an explicit `@ttr/std` clock intrinsic.

The dialect's answer, as everywhere: **move the policy to an explicit call-site
API**, keep the pure algebra native, and fail loud on the ambient/global read.

## Crate choice — `chrono` (recommended) vs `time`

| | `chrono` | `time` |
|---|---|---|
| Parsing/formatting breadth | RFC3339 + `strftime`-style + flexible | RFC3339 + `format_description!`; narrower |
| JS-`Date` field parity | full (`year/month/day/hour/min/sec/nano`, weekday, ordinal, ms-since-epoch) | full, but more manual |
| ISO-8601 ms output | `to_rfc3339_opts(SecondsFormat::Millis, true)` → `…Z` in one call | must build a format description |
| Baggage | historically carried an unmaintained-`localtime`/`time` advisory; **resolved** in modern `chrono` (0.4.2x uses `iana-time-zone`; the old `localtime_r` soundness issue is gone) | lighter, no tz-db baggage by default |
| Weight | heavier | lighter |

**Recommendation: `chrono`.** The design pins everything to **UTC** (see the
timezone decision), so we never touch a system-timezone database and none of
`time`'s "lighter, no-tz-baggage" advantage actually applies to us — both crates
are pure arithmetic in our usage. `chrono`'s one-call `to_rfc3339_opts(Millis,
true)` is an *exact* match for JS `toISOString()`'s `YYYY-MM-DDTHH:mm:ss.sssZ`
shape, which is the single hardest formatting-fidelity target in the whole
surface; reproducing that byte-for-byte in `time` means hand-writing a format
description and the millisecond-padding rules ourselves. `chrono` buys the
fidelity for free. We depend on `chrono` with **`default-features = false`,
`features = ["std"]`** (no `clock`, no `serde` unless needed) — this drops the
system-clock and tz-database code paths entirely, so the unmaintained-tz concern
is moot by construction.

- **Sub-decision A (Collin):** `chrono` (recommended, formatting parity) vs `time`
  (lighter). Default: **`chrono`, `default-features = false`**.

## ★ The crux — non-determinism (the key call)

`Date.now()` and no-arg `new Date()` read wall-clock time. Under the differential
oracle the Bun process and the `cargo run` process execute at different instants,
so any program that prints a now-derived value diverges. This is **identical in
kind** to `Math.random`'s hidden global PRNG (see
`docs/work/_archive/089-rng-shim/design.md`): "a hidden global … cannot be
differential-stable; an explicit seed makes the stream differential-stable."

### Options

- **(a) Shim-injected clock — fail-loud the ambient read, redirect to `@ttr/std`.**
  Mirrors `rng(seed)` exactly: bare `Date.now()` / no-arg `new Date()` are
  fail-loud with an `UnsupportedError` naming the shim; the developer imports an
  explicit clock whose "current time" is an explicit argument, so both runtimes
  read the *same* instant. Honest, differential-stable, consistent with the whole
  std-shim lane.
- **(b) Allow them, exclude from differential specs (compile-only / tier-1).** The
  ambient reads emit real `chrono::Utc::now()` but are marked non-differential;
  specs only assert they *compile*. Weaker: it lets a nondeterministic value flow
  into an otherwise-differential program with no wall protecting the oracle, and
  it breaks the "every accepted construct is differential-stable" invariant the
  project holds everywhere else.

### Recommendation — **(a)**, mirroring `rng`.

Add one export to `@ttr/std`, shaped like `rng(seed)`: a **seeded clock handle**.

```ts
// packages/std/index.ts  (reference body — run under Bun, never compiled)
export class Clock {
  private epochMs: number;
  constructor(epochMs: number) { this.epochMs = epochMs; }
  now(): number { return this.epochMs; }          // ms since epoch, like Date.now()
  date(): Date  { return new Date(this.epochMs); } // a Date at the fixed instant
  tick(ms: number): void { this.epochMs += ms; }   // advance deterministically
}
export function clock(epochMs: number): Clock { return new Clock(epochMs); }
```

```ts
import { clock } from "@ttr/std";
const c = clock(1_700_000_000_000); // an explicit, differential-stable "now"
console.log(c.now());               // 1700000000000  (identical both sides)
console.log(c.date().toISOString());// 2023-11-14T22:13:20.000Z
c.tick(1000);
console.log(c.now());               // 1700000001000
```

Why a **stateful handle** (not a bare `now(): number` free function): it reuses
the 084/089 binding-recording + member-routing machinery (`const c = clock(ms);
c.now()` records `c`'s type and routes methods to the handle surface, emitted `let
mut`), and `tick` lets a program model the *passage* of time deterministically
(the honest analog of "call `Date.now()` twice and subtract") without ever reading
a real clock. It is the direct structural twin of `rng(seed)` → `Rng`.

- **Rust target:** `tslib::date::Clock` — a newtype over an `i64` epoch-ms.
  `clock(epochMs)` → `tslib::date::Clock::new(epochMs)`; `.now()` → `f64` ms;
  `.date()` → `tslib::date::Date` (the deterministic type below); `.tick(ms)` →
  `&mut self`.
- **Fail-loud pairing:** bare `Date.now()` and no-arg `new Date()` are rejected
  with a redirect to `clock` (see the residual list), exactly as bare
  `Math.random` redirects to `rng`.

- **★ Sub-decision B (Collin):** shim clock shape. Default: **stateful `clock(epochMs)
  → Clock` with `now()/date()/tick(ms)`** (recommended, `rng`-parallel). Alternative
  considered: a bare `now(): number` free function seeded by a harness env var — but
  a hidden harness seed *is* the ambient-global antipattern we're removing, so it's
  rejected. The seed must be an explicit call-site argument.

## The deterministic surface (the bulk)

A `tslib::date::Date` newtype wrapping `chrono::DateTime<Utc>` (all instants are
UTC internally — see the timezone decision). The compiler recognizes `Date` (a
reserved type name, promoted out of the fail-loud "unknown type" row) and routes
its constructors, accessors, and methods to `tslib::date`.

### Construction

| TS | Rust target |
|---|---|
| `new Date(ms)` (one `number`) | `tslib::date::Date::from_epoch_ms(ms)` — `DateTime::from_timestamp_millis(ms as i64)` |
| `new Date(isoString)` (one `string`) | `tslib::date::Date::parse_iso(s)` — `DateTime::parse_from_rfc3339` then `.with_timezone(&Utc)`; **strict ISO-8601 only** |
| `new Date(y, m, d, h?, min?, s?, ms?)` | `tslib::date::Date::from_parts(y, m, d, …)` — `Utc.with_ymd_and_hms(...)` + ms; **`m` is 0-based** (JS month), the constructor adds 1 for chrono |
| `new Date()` (no args) | **fail-loud** → redirect to `clock(...)` |

`new Date(isoString)` accepts only the strict RFC3339/ISO-8601 forms
`YYYY-MM-DDTHH:mm:ss.sssZ` and `YYYY-MM-DD` (the `toISOString` round-trip target).
Loose JS `Date.parse` formats (`"Nov 14 2023"`, locale strings, missing `Z`,
2-digit years) are **fail-loud** (residual list) — JS's parser is famously
implementation-defined and would not match `chrono` byte-for-byte.

### Accessors (all UTC-normalized — see timezone decision)

| TS accessor | Rust |
|---|---|
| `getTime()` | `.timestamp_millis()` as `f64` |
| `getFullYear()` / `getUTCFullYear()` | `.year()` |
| `getMonth()` / `getUTCMonth()` | `.month0()` (JS month is **0-based**) |
| `getDate()` / `getUTCDate()` | `.day()` |
| `getDay()` / `getUTCDay()` | `.weekday().num_days_from_sunday()` (JS: Sun=0) |
| `getHours()` / `getUTCHours()` | `.hour()` |
| `getMinutes()` / `getUTCMinutes()` | `.minute()` |
| `getSeconds()` / `getUTCSeconds()` | `.second()` |
| `getMilliseconds()` / `getUTCMilliseconds()` | `.timestamp_subsec_millis()` |
| `getTimezoneOffset()` | `0` (UTC-pinned — see below) |

All accessors return `f64` (the dialect's `number`).

### Arithmetic & comparison

Date arithmetic in idiomatic JS goes through epoch-ms integers:
`d.getTime() + n`, `new Date(d.getTime() + 86_400_000)`, `a.getTime() <
b.getTime()`. Because these are already `number` operations on the value
`getTime()` returns, **they need no new machinery** — they lower through the
existing numeric path. Direct `Date` `<`/`>`/`===` comparison is **not** in this
increment (JS `Date` relational compares coerce via `valueOf` → ms, and `===` is
reference identity — a footgun); require the explicit `.getTime()` form, fail-loud
a bare `date < date` if it reaches the emitter without an accessor.

- **Sub-decision C (Collin):** support bare `d1 < d2` (lower via implicit
  `valueOf`→ms)? Default: **no — require `d1.getTime() < d2.getTime()`** (explicit,
  no coercion surprise). Cheap to add later if wanted.

### Formatting

| TS | Rust | note |
|---|---|---|
| `toISOString()` | `.to_rfc3339_opts(SecondsFormat::Millis, true)` | **exact** JS shape `YYYY-MM-DDTHH:mm:ss.sssZ` — `chrono`'s `use_z=true` prints `Z` (not `+00:00`), `Millis` forces 3-digit ms. This is why we chose `chrono`. |
| `toJSON()` | same as `toISOString()` | JS `Date.prototype.toJSON` === `toISOString` |
| `toDateString()` | custom `tslib::date` formatter → `"Www Mmm DD YYYY"` (e.g. `"Tue Nov 14 2023"`) | JS's fixed English form; hand-written in `tslib` so it's byte-exact (chrono's `%a %b %d %Y` matches, but we own the string to avoid locale drift) |

- **Formatting-fidelity notes / known exact-string traps:**
  - JS `toISOString()` always emits **3** fractional digits and a literal `Z`.
    `chrono`'s plain `to_rfc3339()` emits `+00:00` and variable sub-second digits —
    **wrong**; we must use `to_rfc3339_opts(SecondsFormat::Millis, true)`.
  - Years outside `0..=9999`: JS uses an *expanded* `±YYYYYY` form. **Out of scope /
    residual** — `from_parts`/`from_epoch_ms` inputs are constrained to the 4-digit
    year range in fixtures.
  - `toDateString()` weekday/month names are **English, fixed** in JS (not
    locale-sensitive); the `tslib` formatter hard-codes the English tables so it
    never consults a locale.

## ★ Timezone fidelity (a real divergence call)

JS `Date` stores UTC internally but its **local accessors** (`getHours`,
`getDate`, …, and `getTimezoneOffset`) render in the **host machine's local
timezone**. The differential oracle runs Bun and `cargo run` in whatever TZ the
CI/dev box has — so `getHours()` is **non-portable across the two runtimes** unless
the timezone is pinned, and even pinned it depends on an ambient environment.

### Options

- **(a) UTC-normalize everything (recommended).** Model `getHours()` ≡
  `getUTCHours()`, `getTimezoneOffset()` ≡ `0`. Both `Date` accessors and the
  emitted Rust operate on `DateTime<Utc>`. **Documented divergence:** on a machine
  whose TZ ≠ UTC, our `getHours()` returns the UTC hour where stock JS would return
  the local hour. This is a *value* divergence from stock JS but it is
  **internally consistent and differential-stable** (Bun and Rust agree), and it's
  the honest choice: local-TZ output is not a pure function of the program, so it
  was never legitimately differential anyway.
  - To make the *differential harness itself* airtight, additionally **pin
    `TZ=UTC`** in the environment the harness gives the Bun run (and the Rust run,
    though UTC-only chrono ignores it). Then even if we later relaxed to local
    accessors, the two runtimes would agree. Cheap belt-and-suspenders:
    `env: { ...process.env, TZ: "UTC" }` on the `Bun.spawn`/`spawnSync` sites.
- **(b) Fail-loud the local accessors, accept only the `getUTC*` family.** Reject
  `getHours`/`getDate`/… (the non-`UTC` names) with a redirect to their `getUTC*`
  twins; only UTC accessors are in the surface. Maximally honest (no silent value
  divergence) but ergonomically hostile — real JS code overwhelmingly uses the
  short names.

### Recommendation — **(a) + pin `TZ=UTC` in the harness.**

Accept the short local accessors but define them as **UTC-normalized**, document
the divergence in `dialect.md`, and pin `TZ=UTC` so the oracle can never observe a
mismatch. This keeps everyday code (`d.getHours()`) working, stays
differential-stable, and confines the whole timezone question to a single
documented line. Local-TZ *fidelity* (real per-zone offsets) is a future
graduation if ever wanted — it would need an explicit `@ttr/std` zone argument, the
same explicit-input pattern.

- **★ Sub-decision D (Collin):** (a) UTC-normalize the short accessors + document the
  divergence + pin `TZ=UTC` **(recommended)**, vs (b) fail-loud the local
  accessors and force `getUTC*`. Default: **(a)**.

## `tslib::date` shape + Cargo dep

New module `crates/tslib/src/date.rs`, registered `pub mod date;` in
`crates/tslib/src/lib.rs`. Two public types:

```rust
//! JS `Date` fidelity — deterministic instant algebra over chrono::DateTime<Utc>
//! (series 102, #56). All instants are UTC; local accessors are UTC-normalized
//! (documented divergence). The seeded `Clock` is the differential-stable
//! replacement for ambient Date.now()/new Date() — the Date analog of rng(seed).
use chrono::{DateTime, Utc, Datelike, Timelike, TimeZone, SecondsFormat};

pub struct Date(DateTime<Utc>);

impl Date {
    pub fn from_epoch_ms(ms: f64) -> Date { /* from_timestamp_millis(ms as i64) */ }
    pub fn parse_iso(s: &str) -> Date     { /* parse_from_rfc3339 → with_timezone(Utc) */ }
    pub fn from_parts(y: f64, m0: f64, d: f64, h: f64, min: f64, s: f64, ms: f64) -> Date { /* m0+1 */ }

    pub fn get_time(&self) -> f64        { self.0.timestamp_millis() as f64 }
    pub fn get_full_year(&self) -> f64   { self.0.year() as f64 }
    pub fn get_month(&self) -> f64       { self.0.month0() as f64 }   // 0-based
    pub fn get_date(&self) -> f64        { self.0.day() as f64 }
    pub fn get_day(&self) -> f64         { self.0.weekday().num_days_from_sunday() as f64 }
    pub fn get_hours(&self) -> f64       { self.0.hour() as f64 }
    pub fn get_minutes(&self) -> f64     { self.0.minute() as f64 }
    pub fn get_seconds(&self) -> f64     { self.0.second() as f64 }
    pub fn get_milliseconds(&self) -> f64{ self.0.timestamp_subsec_millis() as f64 }
    pub fn get_timezone_offset(&self) -> f64 { 0.0 }                  // UTC-pinned

    pub fn to_iso_string(&self) -> String { self.0.to_rfc3339_opts(SecondsFormat::Millis, true) }
    pub fn to_date_string(&self) -> String { /* hand-written English "Www Mmm DD YYYY" */ }
}

pub struct Clock { epoch_ms: i64 }
impl Clock {
    pub fn new(epoch_ms: f64) -> Clock { Clock { epoch_ms: epoch_ms as i64 } }
    pub fn now(&self) -> f64  { self.epoch_ms as f64 }
    pub fn date(&self) -> Date { Date::from_epoch_ms(self.epoch_ms as f64) }
    pub fn tick(&mut self, ms: f64) { self.epoch_ms += ms as i64; }
}
```

`Cargo.toml` gains:

```toml
# Date/time fidelity (series 102). UTC-only usage; default-features disabled to
# drop the system-clock + tz-database code (and the historical localtime advisory).
chrono = { version = "0.4", default-features = false, features = ["std"] }
```

- **Cargo dep thundering-herd note (per memory):** `chrono` is a *new* crate in
  `tslib`/oracle `Cargo.toml`. Per the "cargo dep thundering herd" memory, the
  **first** `bun run test` run after adding it will show a one-time burst of
  transient differential failures while the dep graph builds; **re-run to confirm
  green** — this is expected flake, not a real regression. Do not chase individual
  failures on that first run. Also honor "never & the cargo suite": no bare `&`
  backgrounding of the cargo suite.

## Recognition / lowering (mirrors 084 / 089)

- `Date` promoted out of the "unknown type name" fail-loud row to a **reserved
  recognized type**; `new Date(...)` constructor arms route by arg count/type to
  `from_epoch_ms` / `parse_iso` / `from_parts`; no-arg → fail-loud.
- A binding whose type is `Date` records into a `dateBindings` set (parallel to
  `parseResultBindings` / `rngBindings`); member access routes `.getTime()` etc. to
  the `tslib::date::Date` surface before any other catalog can claim the names.
  Unknown method on a `Date` handle → fail-loud (`.<m> on a Date — only <list> are
  available`).
- `clock` added to `StdShimName` / `STD_SHIM_EXPORTS`; `clock(epochMs)` lowers to a
  `clockNew` HIR → `tslib::date::Clock::new(...)`; its binding records into a
  `clockBindings` set; `.now()/.date()/.tick()` route to the handle; emitted `let
  mut` (for `.tick`). Direct structural reuse of the `rng` machinery.

## Tradeoffs (summary)

- **UTC-normalized short accessors** trade a documented value-divergence from
  stock-JS-on-a-non-UTC-box for differential stability and everyday-ergonomics.
  Accepted; it's the honest read.
- **Strict-ISO-only parsing** trades loose-`Date.parse` breadth for byte-exact
  parse parity. Loose parsing is fail-loud, not silently wrong.
- **`chrono` over `time`** trades a slightly heavier crate for a one-call exact
  `toISOString` match; with `default-features=false` the weight/tz concerns
  evaporate.
- **Shim clock** trades "call `Date.now()` and it just works" for an explicit
  seed — the same trade `rng` already made and the project already accepts.

## Fail-loud residual (kept out; forbid + redirect where a shim exists)

- **`Date.now()`** (bare) → redirect to `clock` from `@ttr/std` (mirrors
  `Math.random` → `rng`).
- **`new Date()`** (no args) → same redirect to `clock`.
- **`Date.parse(...)` / loose string parsing** (non-strict-ISO forms) → fail-loud;
  only strict RFC3339 / `YYYY-MM-DD` accepted via `new Date(isoString)`.
- **Local-TZ *fidelity*** (real per-zone offsets, `getTimezoneOffset() != 0`) — out;
  accessors are UTC-normalized (or, under sub-decision D(b), the short names are
  themselves fail-loud).
- **Setters / mutation** (`setFullYear`, `setHours`, `setTime`, …) — out this
  increment; `Date` is treated as immutable (construct a new one from ms).
  Fail-loud a setter call with "Date setters are not accepted — construct a new
  Date from ms".
- **Locale formatting** — `toLocaleDateString`, `toLocaleString`, `toLocaleTimeString`
  — out (locale-dependent, non-portable).
- **`Intl.*`** (`Intl.DateTimeFormat`, …) — out; permanent-ish, no static Rust model.
- **`toString()` / `toUTCString()` / `toTimeString()`** — out this increment
  (fixed English forms addable later like `toDateString`); only `toISOString` /
  `toJSON` / `toDateString` are in.
- **Expanded-year `±YYYYYY` ISO output** (years outside `0..=9999`) — out; fixtures
  stay in the 4-digit range.

Each residual is `UnsupportedError` (not yet), not `DialectError` (forbidden), so
they can graduate individually later — except `Intl`/locale, which are candidates
for permanent rejection like `Proxy`/`Reflect`.
