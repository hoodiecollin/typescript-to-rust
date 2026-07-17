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
 *
 * Series 100 (epic #52) adds the **I/O** surface — sync fs / env / process /
 * stdin (→ `std::fs`/`std::io`/`std::env`/`std::process`), async fs (→
 * `tokio::fs`), and HTTP (→ `tslib::http` over reqwest). The TS bodies below run
 * real `node:fs`/`process`/`fetch` under Bun so the differential oracle observes
 * the identical effect the emitted Rust targets produce.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir as mkdirAsyncFs,
  readdir as readdirAsyncFs,
  readFile as readFileAsyncFs,
  rm as rmAsyncFs,
  writeFile as writeFileAsyncFs,
} from "node:fs/promises";

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

// ───────────────────────────── I/O (series 100) ─────────────────────────────
//
// Sync filesystem (→ `std::fs`). Each is a thin wrapper over `node:fs` so the
// Bun run hits the same real filesystem the emitted Rust does; specs write into
// a per-spec temp dir and print round-tripped content (design §6a). All but
// `exists` are fallible: the wrapper `throw`s on error, mirroring the Rust `Err`
// / `?` short-circuit (the 049 throw↔Result duality with an I/O error source).

/** `readFile(path)` → `std::fs::read_to_string(path)?`. UTF-8 text; throws on a
 * missing/unreadable path. */
export function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

/** `writeFile(path, data)` → `std::fs::write(path, data)?`. Truncates + writes. */
export function writeFile(path: string, data: string): void {
  writeFileSync(path, data);
}

/** `appendFile(path, data)` → `tslib::io::append_file(path, data)?`
 * (create-or-append). */
export function appendFile(path: string, data: string): void {
  appendFileSync(path, data);
}

/** `exists(path)` → `std::path::Path::new(path).exists()`. **Infallible** —
 * `false` on any error (matches `existsSync`). */
export function exists(path: string): boolean {
  return existsSync(path);
}

/** `removeFile(path)` → `std::fs::remove_file(path)?`. */
export function removeFile(path: string): void {
  rmSync(path);
}

/** `readDir(path)` → `tslib::io::read_dir(path)?` → **sorted** entry names. The
 * sort makes the printed list byte-stable across filesystems (design §3a). */
export function readDir(path: string): string[] {
  return readdirSync(path).sort();
}

/** `mkdir(path)` → `std::fs::create_dir_all(path)?`. Recursive. */
export function mkdir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** `removeDir(path)` → `std::fs::remove_dir_all(path)?`. Recursive. */
export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

// Process env / args / control (→ `std::env` / `std::process`).

/** `env(name)` → `std::env::var(name).ok()` → `Option<String>`. `null` when
 * unset. **Infallible** (absence is `None`, not an error); the 066 Option model
 * applies (`?? default` / narrowing). */
export function env(name: string): string | null {
  const v = process.env[name];
  return v === undefined ? null : v;
}

/** `args()` → `std::env::args().skip(1).collect()` — the program args after the
 * binary name (matches `process.argv.slice(2)`; the argv-parity note, design §7). */
export function args(): string[] {
  return process.argv.slice(2);
}

/** `exit(code)` → `std::process::exit(code as i32)`. Returns `never`. */
export function exit(code: number): never {
  return process.exit(code) as never;
}

// Standard streams (→ `std::io`). `readStdin`/`readLine` read a lazily-loaded
// snapshot of fd 0 (the harness feeds the program's stdin — the source itself is
// run from a temp file so stdin is free). `readLine` strips the trailing newline.

let _stdinBuf: string | null = null;
let _stdinPos = 0;
function loadStdin(): string {
  if (_stdinBuf === null) {
    try {
      _stdinBuf = readFileSync(0, "utf8");
    } catch {
      _stdinBuf = "";
    }
  }
  return _stdinBuf ?? "";
}

/** `readStdin()` → `tslib::io::read_stdin()?`. Reads **all** remaining stdin to
 * EOF. */
export function readStdin(): string {
  const buf = loadStdin();
  const rest = buf.slice(_stdinPos);
  _stdinPos = buf.length;
  return rest;
}

/** `readLine()` → `tslib::io::read_line()?` → `Option<String>`. One line, the
 * trailing newline stripped; `null` at EOF. */
export function readLine(): string | null {
  const buf = loadStdin();
  if (_stdinPos >= buf.length) return null;
  const nl = buf.indexOf("\n", _stdinPos);
  if (nl === -1) {
    const line = buf.slice(_stdinPos);
    _stdinPos = buf.length;
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  }
  const line = buf.slice(_stdinPos, nl);
  _stdinPos = nl + 1;
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * A stdout/stderr `Writer` handle — the byte-precise counterpart to
 * `console.log`'s line-buffered `println!`. `write` emits **no** trailing
 * newline, so a fixture controls the exact stream the differential diffs. Mirrors
 * the Rust `tslib::io::Writer` (a stateful handle, series 089 machinery). All
 * three methods are fallible (`?` in Rust).
 */
export class Writer {
  constructor(private stream: { write(chunk: string): unknown }) {}
  /** `.write(s)` — no trailing newline. */
  write(s: string): void {
    this.stream.write(s);
  }
  /** `.writeLine(s)` — one trailing `\n`. */
  writeLine(s: string): void {
    this.stream.write(`${s}\n`);
  }
  /** `.flush()` — force the buffer out (a no-op here; `process.std*` is
   * unbuffered under Bun, mirroring the Rust `flush()?`). */
  flush(): void {}
}

/** `stdout()` → a `tslib::io::Writer` over `std::io::stdout()`. */
export function stdout(): Writer {
  return new Writer(process.stdout);
}

/** `stderr()` → a `tslib::io::Writer` over `std::io::stderr()`. */
export function stderr(): Writer {
  return new Writer(process.stderr);
}

// Async filesystem (→ `tokio::fs`). Only valid inside an `async function` and
// **must be awaited** (an un-awaited I/O future is fail-loud — the 051 rule).
// Namespaced under `fsAsync` to avoid colliding with the flat sync exports.

/** The async-fs namespace — twins of the sync fs surface over `tokio::fs`
 * (`.await?`). */
export const fsAsync = {
  /** `fsAsync.readFile(p)` → `tokio::fs::read_to_string(p).await?`. */
  readFile(path: string): Promise<string> {
    return readFileAsyncFs(path, "utf8");
  },
  /** `fsAsync.writeFile(p, data)` → `tokio::fs::write(p, data).await?`. */
  writeFile(path: string, data: string): Promise<void> {
    return writeFileAsyncFs(path, data);
  },
  /** `fsAsync.readDir(p)` → `tslib::io::read_dir_async(p).await?` → sorted. */
  async readDir(path: string): Promise<string[]> {
    return (await readdirAsyncFs(path)).sort();
  },
  /** `fsAsync.removeFile(p)` → `tokio::fs::remove_file(p).await?`. */
  removeFile(path: string): Promise<void> {
    return rmAsyncFs(path);
  },
  /** `fsAsync.mkdir(p)` → `tokio::fs::create_dir_all(p).await?`. */
  async mkdir(path: string): Promise<void> {
    await mkdirAsyncFs(path, { recursive: true });
  },
};

/**
 * An HTTP response — a purpose-built std-shim type (the 084 `ParseResult`
 * precedent). `status`/`ok` are read as fields; `body` mirrors the Rust
 * `self`-consuming `body()` accessor. Mirrors `tslib::http::HttpResponse` so the
 * differential oracle observes identical `.status`/`.ok`/`.body`.
 */
export class HttpResponse {
  constructor(
    public readonly status: number,
    public readonly ok: boolean,
    public readonly body: string,
  ) {}
}

/** The HTTP namespace — GET/POST of **text bodies only** over the async surface
 * (`.await?`); both are fallible + must be awaited. */
export const http = {
  /** `http.get(url)` → `tslib::http::get(url).await?`. */
  async get(url: string): Promise<HttpResponse> {
    const r = await fetch(url);
    const body = await r.text();
    return new HttpResponse(r.status, r.ok, body);
  },
  /** `http.post(url, body)` → `tslib::http::post(url, body).await?`. */
  async post(url: string, body: string): Promise<HttpResponse> {
    const r = await fetch(url, { method: "POST", body });
    const text = await r.text();
    return new HttpResponse(r.status, r.ok, text);
  },
};
