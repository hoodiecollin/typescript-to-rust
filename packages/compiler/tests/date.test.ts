/**
 * Specs for series 102 — `Date` / time via the `chrono` crate (issue #56, Tier-3).
 *
 * JS `Date` is a deterministic instant algebra (construct from ms / ISO / fields,
 * read fields, format) wired to a non-deterministic wall-clock reader
 * (`Date.now()` / no-arg `new Date()`). The algebra maps onto `tslib::date::Date`
 * over `chrono::DateTime<Utc>` and is a pure function of its inputs, so
 * `rust.stdout === runTs(src)` byte-for-byte. The wall-clock reader gets the
 * `Math.random → rng(seed)` treatment: bare reads are fail-loud, redirected to an
 * explicit seeded `clock(epochMs)` from `@t2r/std` (the `Clock` handle), so both
 * runtimes observe the *same* instant.
 *
 * All instants are UTC internally; the short local accessors are UTC-normalized
 * (`getHours ≡ getUTCHours`, `getTimezoneOffset ≡ 0`) — a documented divergence,
 * made airtight by pinning `TZ=UTC` on the Bun run in the harness. IDs map to
 * docs/work/102-date/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("date", [
  // ── Construction ──────────────────────────────────────────────────────────
  {
    name: "DT1 epoch construction + ISO out",
    src: `console.log(new Date(0).toISOString());`,
    expected: "1970-01-01T00:00:00.000Z",
    extra: ({ rust }) => {
      expect(rust).toContain("tslib::date::Date::from_epoch_ms");
      expect(rust).toContain(".to_iso_string()");
    },
  },
  {
    name: "DT2 arbitrary ms + ISO out (Z + 3-digit ms fidelity)",
    src: `console.log(new Date(1700000000000).toISOString());`,
    expected: "2023-11-14T22:13:20.000Z",
  },
  {
    name: "DT3 ISO string parse round-trips",
    src: `console.log(new Date("2023-11-14T22:13:20.000Z").toISOString());`,
    expected: "2023-11-14T22:13:20.000Z",
    extra: ({ rust }) => expect(rust).toContain("tslib::date::Date::parse_iso"),
  },
  {
    name: "DT4 ms round-trips through parse",
    src: `console.log(new Date("2023-11-14T22:13:20.000Z").getTime());`,
    expected: "1700000000000",
  },
  {
    name: "DT5 field constructor, 0-based month",
    src: `console.log(new Date(2023, 10, 14, 22, 13, 20, 0).toISOString());`,
    expected: "2023-11-14T22:13:20.000Z",
    extra: ({ rust }) => expect(rust).toContain("tslib::date::Date::from_parts"),
  },
  // ── Accessors (UTC-normalized) ────────────────────────────────────────────
  {
    name: "DT6 getUTCFullYear",
    src: `console.log(new Date(1700000000000).getUTCFullYear());`,
    expected: "2023",
  },
  {
    name: "DT7 getUTCMonth is 0-based",
    src: `console.log(new Date(1700000000000).getUTCMonth());`,
    expected: "10",
  },
  {
    name: "DT8 getUTCDate",
    src: `console.log(new Date(1700000000000).getUTCDate());`,
    expected: "14",
  },
  {
    name: "DT9 getUTCDay weekday, Sun=0",
    src: `console.log(new Date(1700000000000).getUTCDay());`,
    expected: "2",
  },
  {
    name: "DT10 getUTCHours/Minutes/Seconds",
    src: `const d = new Date(1700000000000);
console.log(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());`,
    expected: "22 13 20",
  },
  {
    name: "DT11 getUTCMilliseconds",
    src: `console.log(new Date(1700000000123).getUTCMilliseconds());`,
    expected: "123",
  },
  {
    name: "DT12 short accessor ≡ UTC accessor (UTC-normalized)",
    src: `const d = new Date(1700000000000);
console.log(d.getHours() === d.getUTCHours());`,
    expected: "true",
  },
  {
    name: "DT13 getTimezoneOffset() === 0 (UTC-pinned)",
    src: `console.log(new Date(0).getTimezoneOffset());`,
    expected: "0",
  },
  // ── Arithmetic & comparison (through epoch-ms) ────────────────────────────
  {
    name: "DT14 add a day via ms",
    src: `console.log(new Date(new Date(0).getTime() + 86400000).toISOString());`,
    expected: "1970-01-02T00:00:00.000Z",
  },
  {
    name: "DT15 difference in ms",
    src: `const a = new Date("2023-11-14T00:00:00.000Z");
const b = new Date("2023-11-15T00:00:00.000Z");
console.log(b.getTime() - a.getTime());`,
    expected: "86400000",
  },
  {
    name: "DT16 ordering via getTime()",
    src: `const a = new Date("2023-11-14T00:00:00.000Z");
const b = new Date("2023-11-15T00:00:00.000Z");
console.log(a.getTime() < b.getTime());`,
    expected: "true",
  },
  // ── Formatting ────────────────────────────────────────────────────────────
  {
    name: "DT17 toDateString fixed English form",
    src: `console.log(new Date(1700000000000).toDateString());`,
    expected: "Tue Nov 14 2023",
    extra: ({ rust }) => expect(rust).toContain("to_date_string"),
  },
  {
    name: "DT18 toJSON === toISOString",
    src: `console.log(new Date(0).toJSON());`,
    expected: "1970-01-01T00:00:00.000Z",
  },
  // ── Shim clock (differential-stable "now") ────────────────────────────────
  {
    name: "DT19 clock(epochMs).now()",
    src: `import { clock } from "@t2r/std";
console.log(clock(1700000000000).now());`,
    expected: "1700000000000",
    extra: ({ rust }) => expect(rust).toContain("tslib::date::Clock::new"),
  },
  {
    name: "DT20 clock(...).date() bridges to a Date",
    src: `import { clock } from "@t2r/std";
const c = clock(1700000000000);
console.log(c.date().toISOString());`,
    expected: "2023-11-14T22:13:20.000Z",
  },
  {
    name: "DT21 tick advances deterministically",
    src: `import { clock } from "@t2r/std";
const c = clock(1000);
c.tick(500);
console.log(c.now());`,
    expected: "1500",
    extra: ({ rust }) => expect(rust).toContain("let mut c"),
  },
  {
    name: "DT22 aliased import still routes (by specifier)",
    src: `import { clock as mkClock } from "@t2r/std";
console.log(mkClock(0).now());`,
    expected: "0",
    extra: ({ rust }) => expect(rust).toContain("tslib::date::Clock::new"),
  },
]);

// ── Fail-loud — forbid ambient reads + unsupported surface ────────────────────

describe("102 fail-loud — ambient Date reads + unsupported surface", () => {
  test("DT23 bare Date.now()", () => {
    expect(() => compile(`console.log(Date.now());`)).toThrow(/clock/);
  });
  test("DT24 no-arg new Date()", () => {
    expect(() => compile(`const d = new Date();`)).toThrow(/clock/);
  });
  test("DT25 loose-format parse", () => {
    expect(() => compile(`const d = new Date("Nov 14 2023");`)).toThrow(
      /ISO|strict|RFC3339|format/,
    );
  });
  test("DT26 a setter", () => {
    expect(() =>
      compile(`const d = new Date(0);
d.setFullYear(2000);`),
    ).toThrow(/setter/);
  });
  test("DT27 locale formatting", () => {
    expect(() => compile(`new Date(0).toLocaleDateString();`)).toThrow(
      /locale/i,
    );
  });
  test("DT28 unknown method on a Date handle", () => {
    expect(() => compile(`new Date(0).getWeekOfYear();`)).toThrow(
      /Date|available/,
    );
  });
});
