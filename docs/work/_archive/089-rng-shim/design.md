# 089 — `@t2r/std` `rng(seed)` shim — Math.random replacement with explicit determinism — design

Issue **#54**, epic **#52** (the `@t2r/std` std-shim lane). Builds directly on
series **084** (the shim recognition + routing infrastructure). Depends on nothing
else new: the RNG is **hand-rolled inside `tslib` with zero crate deps**.

## What this is

`Math.random` is deferred for one reason above all: a hidden global PRNG cannot be
made **differential-stable** against JS. The differential oracle runs the input TS
under Bun and compares its stdout to the emitted Rust's stdout; a nondeterministic
global RNG makes that comparison impossible.

`rng(seed)` dissolves the problem the way the whole std-shim lane dissolves its
problems — it **moves the policy to an explicit call-site API**. The seed is an
explicit argument (no hidden global state), and the RNG algorithm is **one small,
fully-specified PRNG implemented identically on both sides**, so the two streams
are **bit-for-bit identical** from the same seed. The shim is the dialect's
isolation boundary for this JS-divergent behavior (see the std-shim lane note).

```ts
import { rng } from "@t2r/std";
const r = rng(42);
console.log(r.next());          // deterministic float in [0, 1)
console.log(r.int(0, 6));       // deterministic integer in [0, 6)
console.log(r.pick(["a","b"])); // deterministic element
console.log(r.shuffle([1,2,3])); // deterministic permutation
```

## Decided parameters (settled 2026-07-15 — do not re-litigate)

- **Determinism strategy: hand-rolled PRNG, no crate.** ONE well-specified
  algorithm (**SplitMix64**) is implemented identically in `tslib` (Rust `u64`
  wrapping arithmetic) and in the TS shim (`BigInt` masked to 64 bits). No RNG
  crate is added. Rationale: there is **no conditional-dependency mechanism** —
  every dep lives permanently in `tslib/Cargo.toml`, and crate-internal stream
  stability is version-fragile. A hand-rolled algorithm we own is bit-exact,
  self-contained, and dep-free. `tslib` is already the sanctioned home for
  behavioral-fidelity quirks.
- **Handle shape: stateful handle.** `rng(seed)` returns a `tslib::rng::Rng`
  struct; `const r = rng(seed); r.next()`. Methods take `&mut self` and advance
  the internal state. This reuses the 084 `ParseResult` binding-recording +
  member-routing machinery (the binding's type is recorded; member/method access
  routes to the handle's surface). The binding is emitted `let mut`.
- **Method surface (this increment): `next` / `int` / `pick` / `shuffle`.**
  - `next(): number` — a float in **[0, 1)** (the direct `Math.random()` analog).
  - `int(min, max): number` — an integer in **[min, max)** (half-open, exclusive
    max), one draw.
  - `pick<T>(arr: T[]): T` — a uniformly chosen element, one draw.
  - `shuffle<T>(arr: T[]): T[]` — a **new** array, Fisher–Yates, `arr.length - 1`
    draws. Does **not** mutate its argument.
- **Bare `Math.random` is fail-loud** with an error that **redirects** to `rng`
  from `@t2r/std` — matching the bare-`JSON.parse`/`JSON.stringify` precedent.
- **Seed domain: non-negative safe integers** (`[0, 2^53)`). In this range
  `seed as u64` (Rust) and `BigInt(Math.trunc(seed)) & MASK` (TS) yield an
  identical initial state. Negative / non-integer / out-of-range seeds are outside
  the supported surface (fixtures use non-negative integers; hardening the
  runtime rejection is an impl detail, not a dialect question).

## The algorithm — SplitMix64 (the single source of truth)

State is a single `u64`. All arithmetic is modulo 2^64 (Rust `wrapping_*`; TS mask
`& ((1n << 64n) - 1n)`).

```
next_u64(state):
    state = state + 0x9E3779B97F4A7C15        # wrapping
    z = state
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9   # wrapping
    z = (z ^ (z >> 27)) * 0x94D049BB133111EB   # wrapping
    z = z ^ (z >> 31)
    return (z, state)
```

Float in **[0, 1)** — take the top 53 bits and divide by 2^53 (both sides do the
identical f64 op, so the result is bit-identical):

```
next() = (next_u64() >> 11) as f64 / 9007199254740992.0   # 2^53
```

`(x >> 11)` is a 53-bit integer, exactly representable as `f64`; division by a
power of two is exact — so Rust `(x >> 11) as f64 / 2f64.powi(53)` equals JS
`Number(x >> 11n) / 2**53` to the bit.

Derived draws (identical formula both sides → identical results, regardless of any
rounding at the extreme, because the extreme is reached identically on both sides):

```
int(min, max)  = min + floor(next() * (max - min))
pick(arr)      = arr[ floor(next() * arr.length) ]
shuffle(arr)   = a = copy(arr); for i in (len-1 .. 1): j = floor(next()*(i+1)); swap(a[i], a[j]); return a
```

## Rust side — `crates/tslib/src/rng.rs` (new module)

```rust
//! Seeded, differential-stable PRNG (SplitMix64) — the Rust target of the
//! `@t2r/std` `rng(seed)` shim (series 089, #54). Hand-rolled, zero crate deps;
//! the identical algorithm is mirrored in the TS shim so the two streams match
//! bit-for-bit. Numeric args arrive as `f64` (the translator's `number`).

pub struct Rng {
    state: u64,
}

impl Rng {
    pub fn new(seed: f64) -> Rng {
        Rng { state: seed as u64 }
    }

    pub fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^= z >> 31;
        (z >> 11) as f64 / 9007199254740992.0
    }

    pub fn int(&mut self, min: f64, max: f64) -> f64 {
        min + (self.next() * (max - min)).floor()
    }

    pub fn pick<T: Clone>(&mut self, arr: &[T]) -> T {
        let i = (self.next() * arr.len() as f64).floor() as usize;
        arr[i].clone()
    }

    pub fn shuffle<T: Clone>(&mut self, arr: &[T]) -> Vec<T> {
        let mut a = arr.to_vec();
        let mut i = a.len();
        while i > 1 {
            i -= 1;
            let j = (self.next() * (i as f64 + 1.0)).floor() as usize;
            a.swap(i, j);
        }
        a
    }
}
```

Registered via `pub mod rng;` in `crates/tslib/src/lib.rs`. `pick`/`shuffle` are
generic methods on a non-generic struct (`T: Clone`); Rust infers `T` from the
argument, so no explicit type args are ever emitted.

## TS side — `packages/std/index.ts` (reference-only, run under Bun)

The compiler **never compiles** this body (it emits `tslib::rng::…` directly); it
exists solely so the differential oracle executes faithful, identical behavior.

```ts
const MASK = (1n << 64n) - 1n;

export class Rng {
  private state: bigint;
  constructor(seed: number) {
    this.state = BigInt(Math.trunc(seed)) & MASK;
  }
  next(): number {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    z = (z ^ (z >> 31n)) & MASK;
    return Number(z >> 11n) / 9007199254740992;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min));
  }
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

export function rng(seed: number): Rng {
  return new Rng(seed);
}
```

## Recognition mechanism

Mirrors 084 exactly. In `packages/compiler/src/std-shim.ts`:

- `StdShimName` gains `"rng"`.
- `STD_SHIM_EXPORTS` gains `"rng"`.

`collectStdShimBindings` already binds any `@t2r/std` local alias → intrinsic
name; `rng` participates automatically. The validator's `checkStdShimImport`
accepts it (it's now in `STD_SHIM_EXPORTS`) and rejects unknown names / other
specifiers unchanged.

## Lowering & HIR

- **`rng(seed)` call** — in `lowerStdShimCall` (`lower.ts`), a new `case "rng"`
  emits HIR `{ kind: "rngNew", seed: lowerExpr(arg) }`. It takes exactly one
  argument (a `number`); no type argument.
- **Binding recording** — when a `const r = <rngNew>` binds a simple identifier,
  record `r` in a new `analysis.rngBindings: Set<string>` (parallel to
  `parseResultBindings`), so later `r.next()` / `r.int(...)` / `r.pick(...)` /
  `r.shuffle(...)` route to the handle surface **before** any array/string/
  generator method catalog can claim them (notably `.next()`, which the 052
  generator protocol also uses — the rng binding check takes precedence).
- **Method access on an rng binding** — `r.<m>(args)` where `r ∈ rngBindings` and
  `m ∈ {next, int, pick, shuffle}` lowers to `{ kind: "method", receiver, name: m,
  args: [...] }`. An unknown method on an rng handle is fail-loud
  (`.<m> on an rng handle — only next/int/pick/shuffle are available`).
- **Mutability** — an rng handle binding is emitted `let mut` unconditionally
  (the methods take `&mut self`; the handle is only useful mutably).

## Emitter

- `case "rngNew"` → `tslib::rng::Rng::new(<seed>)`.
- The four methods reuse the existing generic `case "method"` emit
  (`<receiver>.<name>(<args>)`), producing `r.next()`, `r.int(0f64, 6f64)`,
  `r.pick(&arr)`, `r.shuffle(&arr)`. `pick`/`shuffle` pass the array by reference
  (`&arr`), consistent with the borrow model; both return owned values (`T` /
  `Vec<T>` via `Clone`).

## Fail-loud (forbid + redirect)

- Bare **`Math.random`** (member expression `Math.random`, called or not) →
  `UnsupportedError` naming `rng` and `@t2r/std`. Lives alongside the existing
  `Math.*` handling; `Math.random` is carved out of the accepted `Math` surface
  the same way bare `JSON.parse` was carved out.
- Unknown method on an rng handle → fail-loud (above).
- Unknown `@t2r/std` import name / foreign specifier → unchanged 084 guards.

## Scope boundary (explicitly out)

- Negative / non-integer / ≥ 2^53 seeds (documented-unsupported; fixtures use
  non-negative integers).
- `int` with `min ≥ max`, `pick`/`shuffle` on an empty array — degenerate;
  fail-loud/panic parity is acceptable but not a differential fixture.
- Cryptographic quality, reseeding, `next(n)`-style bulk draws, distribution
  helpers (`float(min,max)`, `bool(p)`) — future increments if wanted.
