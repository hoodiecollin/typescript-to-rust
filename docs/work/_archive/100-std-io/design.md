# 100 — I/O via `@ttr/std` (sync + async: fs, env, process, stdin, HTTP) — design

## Decisions (DECIDED 2026-07-16)

The two §8 sub-decisions are now **DECIDED**. One promotes the recommended default;
one **overrides** the draft's recommendation — see the network-strategy note.

- **HTTP crate (§8a): DECIDED = `reqwest`** (async, rustls TLS backend to avoid a
  system-OpenSSL dependency). Promoted from recommended default. Added to
  `packages/compiler/rust-oracle/Cargo.toml` **and** `crates/tslib/Cargo.toml`; the
  wrapper stays a thin `tslib::http` module. Honor the cargo-dep-thundering-herd
  first-run flake (re-run to confirm green).
- **Network-differential strategy (§8b): DECIDED = (b) local loopback test server —
  this OVERRIDES the draft's recommended (c) compile-only.** The harness starts a
  `127.0.0.1:<PORT>` loopback HTTP server that **both** the Bun run and the Rust run
  hit, giving **real differential stdout coverage** of `http.get` / `http.post`.
  Network HTTP is now a **tier-1 differential** surface, not a compile-only residual.
  See the loopback-server machinery described in §6c and §8b below (describe-only, not
  implemented here).
- **Sync fs / args / env / stdin: DECIDED = differential** via the per-spec temp dir +
  the `IoInput{stdin,args,env}` harness plumbing (§7) — unchanged from the draft.

### Cross-cutting invariant (with 050 modules)

100's I/O must **not** break the "only the entry module runs top-level statements"
invariant that 050 relies on. Import-time I/O (a non-entry module running I/O at load
time / top level) stays **fail-loud** — I/O earns no exception to that invariant. A
module that only *defines* fns calling shim intrinsics is fine.

Epic **#52** (the `@ttr/std` std-shim lane). Builds directly on series **084**
(shim recognition + routing infrastructure), **089** (the stateful-handle +
member-routing precedent), the async campaign **051** (the tokio runtime + the
awaited-fallible `.await?` model), and the error model **049** (`throw` →
`Result<T, String>` / `AppError` + `?`). This series adds the **I/O surface** to
`@ttr/std`.

**Scope (Collin's decision, settled):** sync I/O **and** async I/O.
- **Sync** → `std::fs` / `std::io` / `std::env` / `std::process`.
- **Async** → `tokio::fs` for file I/O (composes with the 051 tokio runtime) and
  an HTTP client crate for network.

Two sub-decisions are left open for sign-off (both flagged `needs-user-input`):
the **HTTP crate choice** and the **network-differential strategy**. Options +
recommended defaults are in [§8](#8-open-sub-decisions-for-collins-sign-off).

---

## 1. What this is / why the shim lane

I/O is a footgun for a fail-loud differential transpiler for one reason above
all: **the observable effect of I/O lives outside the program.** Bare
`fs.readFileSync`, `fetch`, `process.stdin` are Node/Bun globals with no modeled
type, no ownership story, and — for network — no differential-stable behavior at
all. The std-shim lane dissolves this exactly as 084 (JSON) and 089 (RNG) did:
it **moves the policy to an explicit, blessed call-site API** recognized only by
the reserved specifier `"@ttr/std"`, never a name heuristic. A user's own
`readFile` imported from anywhere else is not hijacked.

The shim is **real, Bun-resolvable TS** (`packages/std/index.ts`) so the
differential oracle — which runs the input TS under Bun — executes faithful
behavior matching the emitted Rust. For file I/O that faithfulness is real and
achievable (both sides hit the same real filesystem); for network it is the
central tension this doc confronts head-on ([§6](#6-differential-faithfulness-the-crux)).

`@ttr/std` remains the **only** modeled import. This series extends its export
table; it does **not** open general module resolution (050 stays unshipped).

---

## 2. Approach

Mirror the 084/089 machinery exactly:

1. **Recognition** — `STD_SHIM_EXPORTS` gains the new I/O names; the validator's
   `checkStdShimImport` accepts them and rejects unknown names / foreign
   specifiers unchanged (`import from '<x>' — only "@ttr/std" is a recognized
   module`).
2. **Routing** — `collectStdShimBindings` already binds any `@ttr/std` local
   alias → intrinsic name; the new names participate automatically.
   `lowerStdShimCall` gains a `case` per intrinsic, emitting new HIR nodes that
   the emitter lowers to the Rust targets in [§3](#3-the-export-surface) /
   [§4](#4-async-surface).
3. **Fallibility** — fs/network ops are fallible. Their lowering feeds the
   **existing** fallibility fixpoint in `analysis.ts` (the same one 049/084 use):
   a fallible-call site marks its containing fn as `Result`-returning and threads
   `?` (sync) or `.await?` (async). No new fallibility machinery — I/O intrinsics
   are just new fallible leaf calls. See [§5](#5-fallibility--result-integration).
4. **Handles** — `stdout`/`stderr` writers and the HTTP client are **stateful
   handles** reusing the 089 `rngBindings` binding-record + member-routing
   pattern (record the binding's intrinsic type; route `.write(...)` /
   `.get(...)` to the handle surface before any array/string/generator catalog
   can claim the method name).

No new dialect *capability* is introduced (no generics, no new control flow) —
this is surface + routing + a fallibility tie-in, in the shim-lane groove.

---

## 3. The export surface — SYNC (`std::fs` / `std::io` / `std::env` / `std::process`)

Each export is a thin typed TS wrapper (real body, run under Bun via
`node:fs`/`process`) mapped to a concrete Rust target. **`f64` in, `f64`/`string`
out** convention (the translator's `number`/`string`), matching 089.

### 3a. Filesystem — `std::fs` (all fallible)

| `@ttr/std` export | Signature | Rust target | Notes |
|---|---|---|---|
| `readFile` | `(path: string): string` | `std::fs::read_to_string(path)?` | UTF-8 text. Fallible: missing/permission → `Err`/throw. |
| `writeFile` | `(path: string, data: string): void` | `std::fs::write(path, data)?` | Truncates + writes. |
| `appendFile` | `(path: string, data: string): void` | `std::fs::OpenOptions::new().create(true).append(true).open(path)?.write_all(data.as_bytes())?` | tslib helper `tslib::io::append_file(path, data)` wraps this (fn-first, per the helper-boundary note). |
| `exists` | `(path: string): boolean` | `std::path::Path::new(path).exists()` | **Infallible** (returns `false` on any error, matching `existsSync`). |
| `removeFile` | `(path: string): void` | `std::fs::remove_file(path)?` | Fallible. |
| `readDir` | `(path: string): string[]` | `tslib::io::read_dir(path)?` → `Vec<String>` of entry file-names, **sorted** | Fallible. **Sorted** on both sides for differential stability (dir order is not stable across filesystems). |
| `mkdir` | `(path: string): void` | `std::fs::create_dir_all(path)?` | Recursive (matches `mkdir(p,{recursive:true})`). Fallible. |
| `removeDir` | `(path: string): void` | `std::fs::remove_dir_all(path)?` | Recursive. Fallible. |

`readDir` **sorting** is a deliberate faithfulness rule: the TS wrapper does
`readdirSync(path).sort()`, the Rust `read_dir` collects then `sort()`s. Both
observe the identical byte-ordered list regardless of the underlying FS's native
enumeration order. Documented as an accepted, faithful-by-construction ordering.

### 3b. Process env / args — `std::env`

| `@ttr/std` export | Signature | Rust target | Notes |
|---|---|---|---|
| `env` | `(name: string): string \| null` | `std::env::var(name).ok()` → `Option<String>` | `null` when unset. Lowers to the shipped Option model (066) — a `string \| null` binding, `?? default` / narrowing all apply. **Infallible** (absence is `None`, not an error). |
| `args` | `(): string[]` | `std::env::args().skip(1).collect::<Vec<String>>()` | Program args **after** the binary name (matches `process.argv.slice(2)` — see [§7](#7-harness-changes-stdinargsenv-plumbing) for the arg-numbering parity note). |

### 3c. Process control — `std::process`

| `@ttr/std` export | Signature | Rust target | Notes |
|---|---|---|---|
| `exit` | `(code: number): never` | `std::process::exit(code as i32)` | Returns `never`; flushes are the caller's job (mirrors `process.exit`). |

### 3d. Standard streams — `std::io`

| `@ttr/std` export | Signature | Rust target | Notes |
|---|---|---|---|
| `readStdin` | `(): string` | `{ let mut s = String::new(); std::io::Read::read_to_string(&mut std::io::stdin(), &mut s)?; s }` (tslib `tslib::io::read_stdin()?`) | Reads **all** of stdin to EOF. Fallible. |
| `readLine` | `(): string \| null` | `tslib::io::read_line()?` → `Option<String>` | One line, **trailing newline stripped**; `null` at EOF. Fallible on a read error (distinct from EOF-`None`). |
| `stdout` | `(): Writer` | a `tslib::io::Writer` handle over `std::io::stdout()` | See handle below. |
| `stderr` | `(): Writer` | a `tslib::io::Writer` handle over `std::io::stderr()` | See handle below. |

**`Writer` handle** (stateful, reuses the 089 handle machinery):

| method | Signature | Rust |
|---|---|---|
| `write` | `(s: string): void` | `write!(w, "{}", s)` (no newline) — fallible `?` |
| `writeLine` | `(s: string): void` | `writeln!(w, "{}", s)` — fallible `?` |
| `flush` | `(): void` | `std::io::Write::flush(&mut w)?` |

> **stdout differential note.** `console.log` already maps to `println!` in the
> baseline; `stdout().write` exists for **newline-precise / non-line-buffered**
> output. Since the oracle diffs stdout bytes, `write` (no trailing `\n`) and
> `writeLine` give the fixture author exact control so the Bun-run TS and the
> Rust emit **byte-identical** streams.

---

## 4. Async surface

Async I/O requires the tokio runtime the 051 campaign already wires (the emitted
`main` becomes `#[tokio::main]` when any await is present). These intrinsics are
**only** valid inside an `async` function and **must be awaited** — the same rule
051 enforces for every future. An un-awaited I/O future is fail-loud
([§9](#9-fail-loud-residual-what-stays-rejected)).

### 4a. Async filesystem — `tokio::fs`

The async twins of the sync fs surface, on a nested `@ttr/std/async` **no** — we
keep one specifier. Async fs lives under an exported `fs` async namespace object
to avoid name collisions with the sync exports:

```ts
import { fsAsync } from "@ttr/std";
const text = await fsAsync.readFile(path);
await fsAsync.writeFile(path, text);
```

| `@ttr/std` export (method) | Signature | Rust target |
|---|---|---|
| `fsAsync.readFile` | `(path: string): Promise<string>` | `tokio::fs::read_to_string(path).await?` |
| `fsAsync.writeFile` | `(path: string, data: string): Promise<void>` | `tokio::fs::write(path, data).await?` |
| `fsAsync.readDir` | `(path: string): Promise<string[]>` | `tslib::io::read_dir_async(path).await?` → sorted `Vec<String>` |
| `fsAsync.removeFile` | `(path: string): Promise<void>` | `tokio::fs::remove_file(path).await?` |
| `fsAsync.mkdir` | `(path: string): Promise<void>` | `tokio::fs::create_dir_all(path).await?` |

`fsAsync` recognition: the imported local alias is recorded as an **async-fs
namespace binding**; `fsAsync.<m>(...)` under `await` routes to the tokio target
(`.await?`), consuming the `await` per the 051 model (a fallible awaited call →
`.await?`, threaded through the fallibility fixpoint). Calling one **without
`await`** hits the 051 un-polled-future rejection.

### 4b. Network — HTTP client (crate TBD, [§8](#8-open-sub-decisions-for-collins-sign-off))

A minimal, typed HTTP surface — **GET/POST of text bodies only** this increment
(no header maps, no streaming, no multipart):

```ts
import { http } from "@ttr/std";
const res = await http.get(url);          // Promise<HttpResponse>
const res2 = await http.post(url, body);  // Promise<HttpResponse>
console.log(res.status, res.body);
```

`HttpResponse` is a **purpose-built tslib type** (the 084 `ParseResult`
precedent — the dialect has no generic/payload enum to model a rich response):

| member | TS | Rust (`tslib::http::HttpResponse`) |
|---|---|---|
| `.status` | `number` | `pub status: f64` (public field) |
| `.body` | `string` | `body()` accessor (`self`-consuming, used once) |
| `.ok` | `boolean` | `pub ok: bool` (`200..=299`) |

| `@ttr/std` export (method) | Signature | Rust target (with recommended crate `reqwest`) |
|---|---|---|
| `http.get` | `(url: string): Promise<HttpResponse>` | `tslib::http::get(url).await?` → wraps `reqwest::get(url).await?` |
| `http.post` | `(url: string, body: string): Promise<HttpResponse>` | `tslib::http::post(url, body).await?` |

The TS `http` reference body uses Bun's global `fetch` so the oracle can hit a
real endpoint faithfully **when a differential network test is enabled**
([§6c](#6c-network-io-not-differential-stable)). Network calls are fallible
(connection/DNS → `Err`/throw) and awaited (`.await?`).

---

## 5. Fallibility / `Result` integration

Every fs op, stdin read, and network op is **fallible** and integrates with the
existing error model **without new machinery**:

- **Sync fallible** — a `readFile(path)` reaches the 049/084 fallibility
  fixpoint as a fallible leaf call. Its containing function's return type becomes
  `Result<T, String>` (or `Result<T, AppError>` once any custom error class is
  declared — the `From<String>`/`?` composition already handles the `io::Error`
  → `String` conversion via a tslib `map_err(|e| e.to_string())` at the leaf).
  The call site threads `?`. On the TS side the wrapper **throws** on error
  (`readFileSync` throws), so `try { readFile(p) } catch (e) { … }` on the TS
  side mirrors the Rust `Err` short-circuit + catch — the exact 049 `throw`/`?`
  duality, now with I/O as the error source.
- **Async fallible** — identical, but the awaited form: `await fsAsync.readFile`
  / `await http.get` lower to `.await?`, and the containing `async fn` returns
  `Result`. This is exactly the 051 "awaited fallible async fn → `.await?`" rule.
- **Infallible carve-outs** — `exists` (bool), `env` (`Option`), `args`
  (`Vec`), `stdout`/`stderr` handle *acquisition* are **not** fallible (only the
  writer's `write`/`flush` are). These don't touch the fixpoint.
- **tslib leaf normalization.** Each fallible tslib helper returns
  `Result<T, String>` (it does the `io::Error`/`reqwest::Error` → `String`
  conversion internally), so the emitter never has to model a Rust error *type* —
  it only ever sees `Result<_, String>`, keeping the 049 `String`-error spine
  intact. `map_err(|e| e.to_string())` lives once, in tslib, not in codegen.

This is the crux of "a failing `readFile` throws in TS / returns `Err` in Rust":
it is **not a special case** — it is the 049 error model with an I/O-shaped leaf.

---

## 6. Differential faithfulness — THE CRUX

The oracle runs both the TS (Bun) and the Rust and diffs stdout. For pure
computation this is exact. For I/O, faithfulness varies **by category**, and the
spec strategy must differ per category.

### 6a. File I/O — differential-stable (feasible)

Both sides operate on the **same real filesystem**. The spec discipline:

- **Use a temp dir.** Each spec allocates a unique temp path (e.g. under the
  harness-provided `T2R_TMP` dir — [§7](#7-harness-changes-stdinargsenv-plumbing)),
  writes, reads it back, prints the **round-tripped content** (not raw paths or
  mtimes), then cleans up. The stdout is content the program itself produced —
  identical on both sides because both hit the same file.
- **Never print non-stable metadata** (absolute paths, timestamps, inode order).
  `readDir` is **sorted** ([§3a](#3a-filesystem--stdfs-all-fallible)) so its
  printed output is stable.
- **Fallible round-trip.** A `readFile` of a *missing* path throws (TS) / `Err`
  (Rust); the spec catches and prints a **fixed** message (the caught error's
  `.message`/Display is *not* byte-stable across platforms, so the fixture prints
  a program-controlled string like `"missing"`, not `String(e)`), so the
  observable stdout matches. This is the same discipline 084 used for
  `ParseResult.error` (which it *doesn't* print raw for the same reason).

**Verdict: fully feasible.** File I/O specs are tier-1 differential.

### 6b. stdin / args / env — differential-stable IF the harness feeds both runs

`readStdin`/`readLine`/`args`/`env` are stable **only if the oracle feeds
identical stdin, argv, and env to the Bun run and the Rust run.** The harness
`spawn()` already accepts a `stdin` string and passes `env`, but `run()` /
`cargoRun()` / `runBatch()` don't thread them through — that's the harness
extension in [§7](#7-harness-changes-stdinargsenv-plumbing). With that,
echo-style specs (read stdin → print it, print `args`, print `env("X")`) are
tier-1 differential.

### 6c. Network I/O — made differential-stable via a local loopback server (DECIDED)

Live *public* endpoints vary and CI is often offline, so a public URL can't be
diffed. **DECISION (2026-07-16): the harness supplies a deterministic local endpoint
so network I/O becomes tier-1 differential** — chosen over the draft's earlier
compile-only recommendation. Options considered:

- **(a) compile-only.** Network intrinsics **compile** (`cargo check`) but are not
  differentially run. Simplest, robust, zero flakiness — but no behavioral coverage.
  *(Not chosen.)*
- **(b) local loopback test server — DECIDED.** The harness spins up a fixed local
  HTTP server on `127.0.0.1:<PORT>` serving a deterministic canned response; **both**
  the Bun run and the Rust run are handed the same base URL, hit it, get the identical
  body, and their stdout is diffed. Real end-to-end differential coverage.
- **(c) compile-only + documented residual** — (a) plus a ledger entry. *(Not
  chosen.)*

### The loopback-server machinery (DESCRIBE only — not implemented here)

The differential oracle helper, for any network spec, provides a **loopback test
server** shared by both runs:

- **Start / teardown.** Before the two runs, the harness starts a tiny local HTTP
  server (a `Bun.serve`-style listener) bound to `127.0.0.1` on an **allocated port**
  (bind to port `0` and read back the OS-assigned port, or scan a small range, to
  avoid collisions across parallel specs). It is torn down in a `finally` after both
  runs complete (and on error), so no socket leaks between specs.
- **A fixed tiny response.** The server answers every request (or a fixed set of
  paths) with a **deterministic** canned payload — a fixed status, a fixed short
  text body (and for POST, echoes or acknowledges the posted body deterministically)
  — so the observable `res.status` / `res.body` / `res.ok` are byte-identical
  regardless of which runtime called.
- **Feeding the same base URL to both runs.** The allocated `http://127.0.0.1:<PORT>`
  base URL is passed to **both** the Bun run and the Rust run through the existing
  `IoInput` plumbing (§7) — as an env var (e.g. `T2R_BASE_URL`) or the program's arg —
  so the fixture builds its request URL from the harness-supplied base and both
  runtimes hit the *same* live local endpoint.
- **Runtime concerns.** The Rust `reqwest` call runs on the 051 tokio runtime; the
  server lifecycle lives in the harness (the test process), not in the emitted crate.
  A live socket sits in the test path — acceptable given the determinism the canned
  response guarantees.

**Verdict: network HTTP is tier-1 DIFFERENTIAL** (via the loopback server), alongside
file / async-fs / stdin / args / env. There is no network non-differential residual.

---

## 7. Harness changes (stdin / args / env plumbing)

Ground truth (`packages/compiler/src/harness/cargo.ts` + `index.ts`):

- `spawn(cmd, cwd, stdin?)` **already** accepts an optional `stdin` string and
  **already** sets `env: { ...process.env }`.
- But `cargoRun()` execs the built binary as `spawn([bin], cwd)` — **no stdin,
  no extra argv, no per-run env override**. `runBatch()`/`cargoBuildExamples()`
  likewise exec `spawn([exe], cwd)` with nothing threaded.
- `RustProject.run()` / the `runRust()` convenience take only `source`.

**Proposed extension (describe only — not implemented here):**

1. Add an optional `IoInput` to the run path:
   ```ts
   interface IoInput { stdin?: string; args?: string[]; env?: Record<string,string>; }
   ```
2. `cargoRun(cwd, io?)` execs `spawn([bin, ...(io?.args ?? [])], cwd, io?.stdin,
   { ...process.env, ...io?.env })` — i.e. thread argv onto the exec, stdin into
   the existing param, and merge env. `spawn` gains an optional `env` override
   arg (today it hardcodes `process.env`).
3. `RustProject.run(source, io?)` and `runRust(source, io?)` forward `io`.
   `runBatch` gains per-program `io` (each `{ id, src, io? }`).
4. **The oracle test helper** (the differential wrapper the specs call) feeds the
   **same** `IoInput` to both the Bun run (`Bun.spawn(["bun","run","-"], { stdin,
   args, env })`) and the Rust run, so both observe identical inputs.
5. **`T2R_TMP`** — the oracle helper allocates a unique temp dir per spec and
   exposes its path to the program via an env var (or as the program's first
   arg), so file-I/O fixtures write somewhere isolated + auto-cleaned. Both runs
   get the **same** temp dir so a write-then-read round-trip is coherent.

**argv parity note.** Bun's `process.argv` is `[bunExe, scriptPath, ...userArgs]`
so `process.argv.slice(2)` = user args; Rust's `std::env::args()` is
`[binPath, ...userArgs]` so `.skip(1)` = user args. `args()` maps to `.skip(1)`
and the TS wrapper to `process.argv.slice(2)` — both yield exactly the user args
the harness passed, so they match.

---

## 8. Open sub-decisions (for Collin's sign-off)

### 8a. HTTP crate choice

| Option | Pros | Cons |
|---|---|---|
| **`reqwest`** (async, recommended) | The de-facto ergonomic async HTTP client; `reqwest::get(url).await?` and `.text().await?` map 1:1 to the shim surface; composes natively with the 051 tokio runtime; simplest tslib wrapper. | Heavy dep tree (pulls `hyper`, `h2`, TLS backend). One-time cold-cache build cost + the **cargo dep thundering herd** first-run flake (see below). |
| `ureq` (sync) | Tiny, blocking, no async runtime needed — would let network I/O be part of the **sync** surface. | **Contradicts the scope decision** (network is the async surface); a blocking call inside `#[tokio::main]` is a footgun; sync HTTP inside an async program is the wrong shape. |
| `hyper` (low-level) | Minimal, no reqwest sugar. | Far more boilerplate in the tslib wrapper (manual client, URI parsing, body collection) for no benefit at this surface. |

**DECIDED (2026-07-16): `reqwest`** (with a rustls TLS backend to avoid a
system-OpenSSL dependency), added to
`packages/compiler/rust-oracle/Cargo.toml` **and** `crates/tslib/Cargo.toml`
(the wrapper lives in tslib). Justification: it is the only candidate that maps
cleanly onto the async awaited-`?` surface and the existing tokio runtime, and
the wrapper stays a two-line `tslib::http` module.

> **Cargo dep thundering-herd note (memory: `cargo-dep-thundering-herd`).**
> Adding `reqwest` to the oracle `Cargo.toml` triggers a one-time burst of
> transient differential failures on the **first** run (cold-cache dep fetch +
> build); **re-run to confirm green.** Pin the version so the offline cache stays
> warm thereafter (the same discipline `tokio`/`thiserror` use in the oracle
> toml comments). Present-but-unused, it costs nothing at check time for
> network-free output.

### 8b. Network-differential strategy

Options (a)/(b)/(c) are in [§6c](#6c-network-io--made-differential-stable-via-a-local-loopback-server-decided).
**DECIDED (2026-07-16): (b) the local loopback test server** — network HTTP is
**tier-1 DIFFERENTIAL** (both runs hit the same `127.0.0.1:<PORT>` canned endpoint
and their stdout is diffed). This **overrides** the draft's earlier recommended (c)
compile-only + non-differential residual; the loopback machinery is described in §6c.

---

## 9. Fail-loud residual (what stays rejected)

Consistent with 084/089 (`forbid + redirect`), the following stay fail-loud so
the never-miscompile contract holds:

**Redirect the bare footgun APIs to the shim:**

| Trigger | Kind | Message |
|---|---|---|
| Bare `fs.*` / `node:fs` import or member (`readFileSync`, `writeFileSync`, …) | Not yet | `` `fs.<name>` is not accepted — import `readFile`/`writeFile`/… from "@ttr/std" `` |
| Bare `fetch(...)` (Bun/Node global) | Not yet | `` `fetch` is not accepted — import `http` from "@ttr/std" and call `http.get(url)` `` |
| Bare `process.argv` / `process.env` / `process.exit` | Not yet | `` `process.<name>` is not accepted — import `args`/`env`/`exit` from "@ttr/std" `` |
| Bare `process.stdin` / `console.log`-as-stream | Not yet | `` reading stdin is not accepted — import `readStdin`/`readLine` from "@ttr/std" `` |

**Out-of-surface I/O (no shim entry yet — deferred, distinct from a redirect):**

| Trigger | Kind | Message |
|---|---|---|
| Streaming reads/writes (chunked/`Readable`/`Writable`, byte streams) | Not yet | `streaming I/O is not supported (only whole-file read/write)` |
| `fs.watch` / filesystem watching | Not yet | `filesystem watching is not supported` |
| Raw sockets (`net`/`dgram`/TCP/UDP) | Not yet | `raw sockets are not supported` |
| **Sync** network (blocking HTTP outside the async surface) | Not yet | `synchronous network I/O is not supported — use `await http.get(url)` in an async function` |
| HTTP with header maps / non-text bodies / streaming responses / methods beyond GET/POST | Not yet | `only `http.get`/`http.post` of text bodies are supported (headers/streaming/other methods deferred)` |
| An `fsAsync.*` / `http.*` call **not** directly awaited (un-polled future) | Not yet | (the 051 message) `call to an async method not directly awaited (an un-polled future never runs)` |
| Binary (non-UTF-8) file contents | Not yet | `only UTF-8 text file I/O is supported (binary/`Buffer` deferred)` |
| Unknown method on a `Writer` / `fsAsync` / `http` handle | Not yet | `` `.<m>` on a <handle> — only <surface> is available `` (the 089 handle-method pattern) |

**Network HTTP is differential (no residual).** Per the 8b DECISION, `http.get` /
`http.post` are covered by full stdout-diff differential specs against the harness's
local loopback test server (§6c) — there is **no** network non-differential residual.
(The prior draft's compile-only residual is removed.)

---

## 10. Package + resolution

`packages/std/index.ts` gains the new exports as **real TS wrappers** over
`node:fs` / `process` / global `fetch` (Bun-resolvable), matching the file's
existing structure (JSDoc intrinsic-note header per export, like `rng`/`parseJson`).
The `Writer`, `fsAsync`, `http`, `HttpResponse` shapes are exported classes/objects
mirroring their tslib Rust targets so `if (res.ok) res.body` narrows in TS exactly
as the Rust field/accessor pair does (the 084 `ParseResult` narration pattern).

Rust side: a new `crates/tslib/src/io.rs` (`pub mod io;` in `lib.rs`) for the
`append_file`/`read_dir`/`read_stdin`/`read_line`/`Writer` helpers, and a new
`crates/tslib/src/http.rs` (`pub mod http;`) for `HttpResponse`/`get`/`post`.
`reqwest` (DECIDED, with a **rustls** TLS backend — no system-OpenSSL dependency) is
added to both `crates/tslib/Cargo.toml` and the oracle `Cargo.toml`; `tokio::fs`
needs the tokio `fs` feature added to the oracle toml's existing `tokio` feature list.

---

## 11. Tradeoffs summary

- **One specifier, namespaced async.** Sync fs exports are flat
  (`readFile`, …); async fs and http are **namespace objects** (`fsAsync.*`,
  `http.*`) to avoid sync/async name collisions without a second specifier. Keeps
  recognition uniform (still one `"@ttr/std"` gate) at the cost of a `.` member
  step the router must handle for namespace bindings (a small extension of the
  089 handle-binding pattern).
- **`String`-only error spine.** tslib normalizes every I/O error to `String` at
  the leaf, so the emitter never models a Rust error *type* — preserving 049's
  simplicity — at the cost of losing the structured `io::ErrorKind` (acceptable;
  the dialect's error surface is message-based).
- **Network loopback-differential** (DECIDED) buys real end-to-end differential
  coverage — both runs hit the same `127.0.0.1:<PORT>` canned endpoint — at the cost
  of a harness server lifecycle + port allocation + a live socket in the test path.
- **Sorted `readDir` / temp-dir discipline** buys differential stability at the
  cost of a documented ordering rule and a harness temp-dir capability.
