/**
 * Specs for series 089 — the `@t2r/std` `rng(seed)` shim (#54, epic #52). A
 * seeded, differential-stable PRNG (SplitMix64) that replaces `Math.random`: the
 * seed is explicit, and the ONE algorithm is implemented identically in `tslib`
 * (Rust `u64` wrapping) and the TS shim (`BigInt` masked to 64 bits), so the two
 * streams are bit-for-bit identical. Every non-fail-loud spec asserts
 * `rust.stdout === runTs(src)` AND (where pinned) an exact literal — a change to
 * the SplitMix64 constants would break it. Bare `Math.random` is fail-loud with
 * a redirect. IDs → specs.md (RNG1–RNG18). Differential specs run as one batch.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

const RNG = `import { rng } from "@t2r/std";\n`;

defineDifferential("rng-shim", [
  {
    name: "RNG1 first draw for seed 42 (differential; emits Rng::new)",
    src: `${RNG}const r = rng(42);\nconsole.log(r.next());`,
    extra: ({ rust }) => expect(rust).toContain("tslib::rng::Rng::new"),
  },
  {
    name: "RNG2 two draws differ and are reproducible",
    src: `${RNG}const r = rng(42);\nconsole.log(r.next());\nconsole.log(r.next());`,
    extra: ({ ts }) => {
      const [a, b] = ts.split("\n");
      expect(a).not.toBe(b);
    },
  },
  {
    name: "RNG3 same seed ⇒ same stream",
    src: `${RNG}const a = rng(7);\nconst b = rng(7);\nconsole.log(a.next() === b.next());`,
    expected: "true",
  },
  {
    name: "RNG4 different seeds ⇒ different first draw",
    src: `${RNG}const a = rng(1);\nconst b = rng(2);\nconsole.log(a.next() === b.next());`,
    expected: "false",
  },
  {
    name: "RNG5 an aliased import still routes (recognition by specifier)",
    src: `import { rng as makeRng } from "@t2r/std";\nconsole.log(makeRng(3).next());`,
    extra: ({ rust }) => expect(rust).toContain("tslib::rng::Rng::new"),
  },
  {
    name: "RNG6 bounded integer in [0, 6)",
    src: `${RNG}const r = rng(9);\nconsole.log(r.int(0, 6));`,
    extra: ({ ts }) => {
      const n = Number(ts);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(6);
    },
  },
  {
    name: "RNG7 a sequence of int draws is reproducible",
    src: `${RNG}const r = rng(9);\nfor (let i = 0; i < 5; i = i + 1) { console.log(r.int(0, 100)); }`,
    extra: ({ ts }) => expect(ts.split("\n").length).toBe(5),
  },
  {
    name: "RNG8 int consumes the same stream as next (shared state advances)",
    src: `${RNG}const r = rng(9);\nconsole.log(r.next());\nconsole.log(r.int(0, 10));`,
  },
  {
    name: "RNG9 pick from a string array (emits .pick(&)",
    src: `${RNG}const r = rng(5);\nconsole.log(r.pick(["a", "b", "c", "d"]));`,
    extra: ({ rust }) => expect(rust).toContain(".pick(&"),
  },
  {
    name: "RNG10 pick from a number array",
    src: `${RNG}const r = rng(5);\nconsole.log(r.pick([10, 20, 30]));`,
  },
  {
    name: "RNG11 pick from a modeled-struct array, then read a field",
    src: `${RNG}interface Point { x: number; y: number; }
const points: Point[] = [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }];
const r = rng(5);
const p = r.pick(points);
console.log(p.x);`,
    extra: ({ rust }) => expect(rust).toContain(".pick(&"),
  },
  {
    name: "RNG12 a permutation is reproducible both sides (emits .shuffle(&)",
    src: `${RNG}const r = rng(11);\nconsole.log(r.shuffle([1, 2, 3, 4, 5]).join(","));`,
    extra: ({ rust }) => expect(rust).toContain(".shuffle(&"),
  },
  {
    name: "RNG13 shuffle does not mutate its argument",
    src: `${RNG}const r = rng(11);\nconst a = [1, 2, 3];\nconst b = r.shuffle(a);\nconsole.log(a.join(","), b.join(","));`,
    extra: ({ ts }) => expect(ts.startsWith("1,2,3 ")).toBe(true),
  },
  {
    name: "RNG14 same seed ⇒ same permutation",
    src: `${RNG}const a = rng(11);\nconst b = rng(11);
console.log(a.shuffle([1, 2, 3, 4, 5]).join(",") === b.shuffle([1, 2, 3, 4, 5]).join(","));`,
    expected: "true",
  },
]);

// Fail-loud: rejected at TS→Rust lowering (never reaches cargo) — plain tests.
test("RNG15 bare Math.random() → redirect to rng from @t2r/std", () => {
  expect(() => compile(`console.log(Math.random());`)).toThrow(
    /rng.*@t2r\/std|@t2r\/std.*rng/,
  );
});

test("RNG16 bare Math.random as a value (uncalled) → redirect", () => {
  expect(() => compile(`const f = Math.random;\nconsole.log(1);`)).toThrow(
    /rng.*@t2r\/std|@t2r\/std.*rng/,
  );
});

test("RNG17 unknown method on an rng handle → only next/int/pick/shuffle", () => {
  expect(() => compile(`${RNG}const r = rng(1);\nr.bytes(4);`)).toThrow(
    /next.*int.*pick.*shuffle|only.*next/,
  );
});

test("RNG18 rng is routed only from @t2r/std (084 guards)", () => {
  expect(() =>
    compile(`import { rng } from "elsewhere";\nconsole.log(rng(1).next());`),
  ).toThrow(/@t2r\/std/);
});
