# 102 — `Date` / time — specs

Spec prefix **DT**. Differential (TS-via-Bun vs Rust-run stdout) + shape
(emitted-Rust substring) + fail-loud (throws with the redirect message). Every
deterministic program is a **pure function of its inputs** — no ambient clock — so
`rust.stdout === runTs(src)` byte-for-byte. Programs that need a "now" import
`{ clock } from "@ttr/std"` and pass an **explicit** epoch-ms, so both runtimes
observe the same instant. Test file:
`packages/compiler/tests/date.test.ts`.

The harness pins **`TZ=UTC`** on the Bun run (belt-and-suspenders for the
UTC-normalized accessor decision); the emitted Rust is UTC-only regardless. Every
non-fail-loud spec asserts `rust.stdout === runTs(src)` **and** pins an `expected`
literal so the mapping (0-based month, weekday numbering, ISO ms-format) is nailed
down.

## Construction

- **DT1** — epoch construction + ISO out: `console.log(new Date(0).toISOString());`
  → `1970-01-01T00:00:00.000Z` (differential; emits `tslib::date::Date::from_epoch_ms`
  and `to_rfc3339_opts(...Millis..., true)`).
- **DT2** — arbitrary ms + ISO out:
  `console.log(new Date(1700000000000).toISOString());` →
  `2023-11-14T22:13:20.000Z` (differential; the `Z` suffix + 3-digit ms are the
  fidelity target).
- **DT3** — ISO string parse round-trips:
  `console.log(new Date("2023-11-14T22:13:20.000Z").toISOString());` →
  `2023-11-14T22:13:20.000Z` (differential; `parse_iso` → `to_iso_string`).
- **DT4** — ms round-trips through parse:
  `console.log(new Date("2023-11-14T22:13:20.000Z").getTime());` → `1700000000000`
  (differential).
- **DT5** — field constructor, **0-based month**:
  `console.log(new Date(2023, 10, 14, 22, 13, 20, 0).toISOString());` → the
  November instant (differential; confirms the `m0 + 1` chrono adjustment — month
  `10` is November, not October).

## Accessors (UTC-normalized)

- **DT6** — `getUTCFullYear`: `console.log(new Date(1700000000000).getUTCFullYear());`
  → `2023` (differential).
- **DT7** — `getUTCMonth` is **0-based**:
  `console.log(new Date(1700000000000).getUTCMonth());` → `10` (differential;
  `month0`).
- **DT8** — `getUTCDate`: `console.log(new Date(1700000000000).getUTCDate());` →
  `14` (differential).
- **DT9** — `getUTCDay` weekday, **Sun=0**:
  `console.log(new Date(1700000000000).getUTCDay());` → `2` (Tuesday)
  (differential; `num_days_from_sunday`).
- **DT10** — `getUTCHours/Minutes/Seconds`:
  `const d = new Date(1700000000000); console.log(d.getUTCHours(), d.getUTCMinutes(),
  d.getUTCSeconds());` → `22 13 20` (differential).
- **DT11** — `getUTCMilliseconds`:
  `console.log(new Date(1700000000123).getUTCMilliseconds());` → `123`
  (differential; `timestamp_subsec_millis`).
- **DT12** — short accessor **≡ UTC accessor** (the documented normalization):
  `const d = new Date(1700000000000); console.log(d.getHours() === d.getUTCHours());`
  → `true` (differential; pins the UTC-normalized decision — short names are UTC).
- **DT13** — `getTimezoneOffset() === 0` (UTC-pinned):
  `console.log(new Date(0).getTimezoneOffset());` → `0` (differential).

## Arithmetic & comparison (through epoch-ms)

- **DT14** — add a day via ms:
  `console.log(new Date(new Date(0).getTime() + 86400000).toISOString());` →
  `1970-01-02T00:00:00.000Z` (differential; pure numeric path, no new machinery).
- **DT15** — difference in ms:
  `const a = new Date("2023-11-14T00:00:00.000Z"); const b = new
  Date("2023-11-15T00:00:00.000Z"); console.log(b.getTime() - a.getTime());` →
  `86400000` (differential).
- **DT16** — ordering via `getTime()`:
  `console.log(a.getTime() < b.getTime());` → `true` (differential; explicit
  accessor comparison is the accepted form).

## Formatting

- **DT17** — `toDateString` fixed English form:
  `console.log(new Date(1700000000000).toDateString());` → `Tue Nov 14 2023`
  (differential; hand-written `tslib` formatter, no locale).
- **DT18** — `toJSON` === `toISOString`:
  `console.log(new Date(0).toJSON());` → `1970-01-01T00:00:00.000Z` (differential).

## Shim clock (differential-stable "now")

- **DT19** — `clock(epochMs).now()`:
  `import { clock } from "@ttr/std"; console.log(clock(1700000000000).now());` →
  `1700000000000` (differential — the seed is explicit, so both runtimes agree;
  emits `tslib::date::Clock::new`).
- **DT20** — `clock(...).date()` bridges to a `Date`:
  `const c = clock(1700000000000); console.log(c.date().toISOString());` →
  `2023-11-14T22:13:20.000Z` (differential).
- **DT21** — `tick` advances deterministically:
  `const c = clock(1000); c.tick(500); console.log(c.now());` → `1500`
  (differential; the honest analog of elapsed-time, emitted `let mut`).
- **DT22** — aliased import still routes (recognition by specifier, not name):
  `import { clock as mkClock } from "@ttr/std"; console.log(mkClock(0).now());` →
  `0` (differential; emits `tslib::date::Clock::new`).

## Fail-loud (forbid ambient reads + unsupported surface)

- **DT23** — bare `Date.now()` → throws `UnsupportedError` mentioning `clock` and
  `@ttr/std` (the `Math.random` → `rng` redirect, applied to time).
- **DT24** — no-arg `new Date()` → throws mentioning `clock` and `@ttr/std`.
- **DT25** — loose-format parse `new Date("Nov 14 2023")` → throws (only strict
  RFC3339 / `YYYY-MM-DD` accepted; `Date.parse` loose forms are not modeled).
- **DT26** — a setter `const d = new Date(0); d.setFullYear(2000);` → throws
  mentioning that setters are not accepted (construct a new Date from ms).
- **DT27** — locale formatting `new Date(0).toLocaleDateString()` → throws (locale
  output is non-portable; not in the surface).
- **DT28** — an unknown method on a `Date` handle
  (`new Date(0).getWeekOfYear();`) → throws naming only the accepted `Date`
  methods.
- **DT29** — **DROPPED (D(a) DECIDED 2026-07-16).** This spec existed only for the
  rejected option D(b) (short local accessors → fail-loud). Since D(a)
  (UTC-normalize the short accessors) is now decided, `new Date(0).getHours()` is
  **accepted** (UTC-normalized), not rejected; **DT12** (short ≡ UTC) stands in its
  place.
