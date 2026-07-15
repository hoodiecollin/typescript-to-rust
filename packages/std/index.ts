/**
 * `@t2r/std` — the blessed TS-side standard-shim surface (series 084, epic #52).
 *
 * These functions are **intrinsics**: the compiler recognizes them *by the
 * reserved import specifier* `"@t2r/std"` and lowers each to a known Rust
 * target. The TS bodies here exist so the differential oracle (which runs the
 * input TS under Bun) executes real, faithful behavior that matches the Rust the
 * compiler emits. A user's own `parseJson`/`stringifyJson` imported from
 * anywhere else is *not* hijacked — recognition keys off this specifier only.
 *
 * Tier A (thin typed wrappers → direct serde / std lowering). Tier B (schema
 * validation) is a later, separate graduation — do not couple to this file.
 */

/**
 * The result of a {@link parseJson} call — a tagged union carrying either the
 * deserialized value or the error string. Mirrors the Rust `tslib::json::ParseResult<T>`
 * the compiler lowers to (a generic enum with `.ok`, `.value`, `.error`).
 *
 * On the TS side this is a discriminated union so `if (r.ok) { r.value }` narrows
 * exactly as the Rust `match`/accessor pair does.
 */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * `parseJson<T>(s)` — a **typed** replacement for `JSON.parse`. The type moves to
 * the call site (`parseJson<Point>(s)`), giving the emitter a concrete
 * `serde_json::from_str::<Point>` target — no `any`. `T` must be a modeled
 * struct/enum (or a primitive/array/record of them); an unconstrained `T` stays
 * fail-loud in the compiler.
 *
 * Returns a {@link ParseResult}: `{ ok: true, value }` on success, `{ ok: false,
 * error }` on a parse/shape error (serde's structural deserialize *is* the
 * validation). Never throws — the error is in-band, matching the Rust
 * `Result`-mapped lowering.
 */
export function parseJson<T>(s: string): ParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(s) as T };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * `stringifyJson(v)` — a replacement for `JSON.stringify`. Lowers to the
 * serde_json-backed writer (the series-045 fidelity machinery, moved behind the
 * shim): integrals print without a trailing `.0`, fractions use the
 * shortest-round-trip form, `Infinity`/`NaN` → `null`.
 *
 * **Accepted JS divergence:** a `None`/optional field renders `null` where JS
 * omits the key (the 066 `null ≡ undefined` collapse). Documented, not fixed
 * here (provenance-carrying faithful omission is a future config knob, epic #52).
 */
export function stringifyJson<T>(v: T): string {
  return JSON.stringify(v);
}

/**
 * `rng(seed)` — a seeded, differential-stable PRNG (series 089, #54), the
 * explicit-determinism replacement for `Math.random`. The compiler lowers a
 * `rng(seed)` call to `tslib::rng::Rng::new(seed)` and its methods to the Rust
 * `Rng` surface; this TS body exists only so the differential oracle (which runs
 * the input TS under Bun) executes the **identical** SplitMix64 stream the
 * emitted Rust produces — bit-for-bit, from the same seed.
 *
 * State is a single `u64` (here a `bigint` masked to 64 bits). All arithmetic is
 * modulo 2^64. The Rust side uses `u64` `wrapping_*`; the masks below reproduce
 * that exactly. `next()` yields a float in `[0, 1)` via `(x >> 11) / 2^53`, an
 * exact f64 op on both sides. Seeds are non-negative safe integers `[0, 2^53)`.
 */
const RNG_MASK = (1n << 64n) - 1n;

export class Rng {
  private state: bigint;
  constructor(seed: number) {
    this.state = BigInt(Math.trunc(seed)) & RNG_MASK;
  }
  next(): number {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & RNG_MASK;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & RNG_MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & RNG_MASK;
    z = (z ^ (z >> 31n)) & RNG_MASK;
    return Number(z >> 11n) / 9007199254740992;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min));
  }
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)] as T;
  }
  shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = a[i] as T;
      a[i] = a[j] as T;
      a[j] = tmp;
    }
    return a;
  }
}

export function rng(seed: number): Rng {
  return new Rng(seed);
}

/**
 * `JsonValue` — the opt-in dynamic JSON value (series 090, epic #59). Reached
 * only via {@link parseJsonValue} / {@link fromJsonValue} / {@link toJsonValue};
 * it does NOT reopen `any`. Wraps the raw parsed tree with an explicit,
 * dynamically-checked accessor surface that mirrors the Rust
 * `tslib::json::JsonValue` newtype exactly — a `serde(transparent)` newtype there
 * means the Bun-run wrapper and the Rust value observe the identical tree, so the
 * differential oracle matches.
 *
 * Absent object keys / out-of-bounds indices yield a `Null` value (matching JS
 * `undefined`, so `.isNull()` distinguishes and chaining stays safe); navigating
 * into a non-container, or coercing a mismatched scalar, `throw`s — the mirror of
 * the Rust `panic!`. Panic/throw messages carry the accessor name so the
 * differential observes matching failures.
 */
export class JsonValue {
  constructor(private raw: unknown) {}

  /** Object member (`Null` if absent); throws on a non-object. */
  get(key: string): JsonValue {
    if (this.raw === null || typeof this.raw !== "object" || Array.isArray(this.raw)) {
      throw new Error("get: JsonValue is not an object");
    }
    const obj = this.raw as Record<string, unknown>;
    return new JsonValue(key in obj ? obj[key] : null);
  }

  /** Array element (`Null` if out of bounds); throws on a non-array. */
  at(i: number): JsonValue {
    if (!Array.isArray(this.raw)) throw new Error("at: JsonValue is not an array");
    const idx = Math.trunc(i);
    return new JsonValue(idx >= 0 && idx < this.raw.length ? this.raw[idx] : null);
  }

  /** Number → `number`; throws otherwise. */
  asNumber(): number {
    if (typeof this.raw !== "number") throw new Error("asNumber: JsonValue is not a number");
    return this.raw;
  }

  /** String → `string`; throws otherwise. */
  asString(): string {
    if (typeof this.raw !== "string") throw new Error("asString: JsonValue is not a string");
    return this.raw;
  }

  /** Bool → `boolean`; throws otherwise. */
  asBool(): boolean {
    if (typeof this.raw !== "boolean") throw new Error("asBool: JsonValue is not a bool");
    return this.raw;
  }

  isNull(): boolean {
    return this.raw === null;
  }
  isNumber(): boolean {
    return typeof this.raw === "number";
  }
  isString(): boolean {
    return typeof this.raw === "string";
  }
  isBool(): boolean {
    return typeof this.raw === "boolean";
  }
  isArray(): boolean {
    return Array.isArray(this.raw);
  }
  isObject(): boolean {
    return this.raw !== null && typeof this.raw === "object" && !Array.isArray(this.raw);
  }

  /** Array element count; throws on a non-array. A **property** here (a `get`
   * accessor) — the compiler lowers `v.length` to the Rust `.length()` method. */
  get length(): number {
    if (!Array.isArray(this.raw)) throw new Error("length: JsonValue is not an array");
    return this.raw.length;
  }

  /** So `stringifyJson(v)` (`JSON.stringify`) serializes the raw tree, matching
   * the `serde(transparent)` Rust newtype. */
  toJSON(): unknown {
    return this.raw;
  }
}

/**
 * `parseJsonValue(s)` (series 090) — dynamic parse. Returns the same
 * {@link ParseResult} shape 084 uses, carrying a {@link JsonValue} on success.
 * The compiler lowers it to `tslib::json::ParseResult::<tslib::json::JsonValue>::parse`.
 */
export function parseJsonValue(s: string): ParseResult<JsonValue> {
  try {
    return { ok: true, value: new JsonValue(JSON.parse(s)) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * `fromJsonValue<T>(v)` (series 090) — dynamic → static. Deserialize a
 * {@link JsonValue} into a modeled `T`. Under Bun the runtime is untyped, so this
 * reference simply hands back the raw tree as `T` (the well-shaped differential
 * inputs match); the emitted Rust is `ParseResult::<T>::from_value`, whose serde
 * deserialize is the real validation.
 */
export function fromJsonValue<T>(v: JsonValue): ParseResult<T> {
  return { ok: true, value: v.toJSON() as T };
}

/**
 * `toJsonValue<T>(x)` (series 090) — static → dynamic. Wrap a modeled value as a
 * {@link JsonValue}. Emits `tslib::json::JsonValue(serde_json::to_value(&x))`.
 */
export function toJsonValue<T>(x: T): JsonValue {
  return new JsonValue(x);
}
