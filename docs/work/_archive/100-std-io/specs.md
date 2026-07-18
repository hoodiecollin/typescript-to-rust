# 100 — I/O via `@ttr/std` — specs

Spec prefix **IO**. Two spec kinds:
- **Differential** (TS-via-Bun vs Rust-run stdout, identical bytes) — the
  behavioral oracle. Requires the harness `IoInput` (stdin/args/env) + `T2R_TMP`
  temp-dir plumbing (design §7); for **network HTTP** it additionally requires the
  **local loopback test server** (design §6c, §8b DECIDED (b)) that both runs hit
  via a harness-supplied `127.0.0.1:<PORT>` base URL.
- **Fail-loud** — throws the redirect/deferral message (design §9).

All programs `import { … } from "@ttr/std"`; the harness resolves the workspace
package under Bun so the TS reference bodies execute the same effect the emitted
`std::fs`/`tslib::io`/`tokio::fs`/`tslib::http` targets produce. Test file:
`packages/compiler/tests/std-io.test.ts`.

**Faithfulness discipline (design §6):** file-I/O specs write **into a per-spec
temp dir** and print only **program-produced round-tripped content** (never
absolute paths, timestamps, or unsorted dir order); fallible specs catch and
print a **program-controlled** string (never raw `String(e)` / Display, which is
platform-variant).

---

## Sync filesystem — write→read round-trip (`std::fs`)

- **IO1** — temp-file round-trip: `writeFile(p, "hello")` then
  `console.log(readFile(p))` (p a `T2R_TMP` path) → prints `hello`, identical
  under Bun and Rust (differential; emits `std::fs::write` + `read_to_string`).
- **IO2** — overwrite semantics: write `"a"`, then `writeFile(p,"b")`, read →
  prints `b` (differential; `write` truncates).
- **IO3** — `appendFile`: write `"x"`, `appendFile(p,"y")`, read → `xy`
  (differential; emits `tslib::io::append_file`).
- **IO4** — `exists` (infallible): after `writeFile(p,"1")`,
  `console.log(exists(p), exists(p + ".nope"))` → `true false` (differential;
  emits `Path::new(...).exists()`, no `?`).
- **IO5** — `removeFile` then `exists`: write, remove, `console.log(exists(p))`
  → `false` (differential).
- **IO6** — `mkdir` + `readDir` **sorted**: mkdir a temp subdir, write files
  `b.txt`,`a.txt`,`c.txt` into it, `console.log(readDir(dir).join(","))` →
  `a.txt,b.txt,c.txt` (differential; the **sorted** order is identical both
  sides regardless of native FS enumeration — pins design §3a sorting rule).

## Sync fallible — missing path → throw / `Err`

- **IO7** — `readFile` of a missing path throws (TS) / `Err` (Rust), caught and a
  program-controlled string printed:
  `try { const s = readFile(missing); console.log(s); } catch { console.log("missing"); }`
  → prints `missing`, identical both sides (differential; the `readFile` call
  threads `?` and the containing fn is `Result`-returning — design §5). Confirms
  the 049 throw↔`Err` duality with an I/O error source.
- **IO8** — the fallible call propagates when **not** caught: a `main`-level
  `const s = readFile(missing);` makes the emitted `main` return
  `Result<(), String>` and the program exits non-zero (Rust) / throws (TS). Shape
  assertion: emitted Rust contains `-> Result<` and the call threads `?`.

## Process args / env / stdin — echo (harness-fed inputs)

- **IO9** — `args` echo: program prints `args().join(",")`; the harness feeds
  argv `["x","y","z"]` to **both** runs → prints `x,y,z`, identical
  (differential; emits `std::env::args().skip(1)`; pins the argv-parity note,
  design §7).
- **IO10** — `env` present: harness sets env `GREETING=hi` for both runs;
  `console.log(env("GREETING") ?? "none")` → `hi` (differential; emits
  `std::env::var(...).ok()`, Option model / `??` from 066).
- **IO11** — `env` absent → `null`: `console.log(env("NOPE") ?? "none")` →
  `none` (differential; `Option::None` ↔ TS `null`).
- **IO12** — `readStdin` echo: harness feeds stdin `"line one\nline two\n"` to
  both runs; `console.log(readStdin())` prints it back verbatim (differential;
  emits `tslib::io::read_stdin`, fallible `?`).
- **IO13** — `readLine` loop to EOF: harness feeds `"a\nb\nc\n"`; a
  `while ((l = readLine()) !== null) console.log(l);` prints `a` `b` `c` on
  separate lines (differential; `Option<String>` at EOF → `null`; trailing
  newline stripped both sides).

## Standard-stream `Writer` handle — byte-precise stdout

- **IO14** — `stdout().write` (no newline): `const w = stdout(); w.write("ab");
  w.write("cd");` → stdout is exactly `abcd` (no trailing newline), identical
  both sides (differential; the handle is `let mut`, emits `write!` — pins the
  byte-precision use-case, design §3d). Confirms the 089 handle binding-record +
  method-routing reuse.
- **IO15** — `writeLine`: `stderr().writeLine("e")` writes to **stderr**, so
  program **stdout** stays empty; the differential compares stdout (empty both
  sides). Shape: emitted Rust uses `std::io::stderr()` + `writeln!`.

## Async filesystem — `tokio::fs` round-trip

- **IO16** — async round-trip: inside an `async function main()`,
  `await fsAsync.writeFile(p,"hi"); const s = await fsAsync.readFile(p);
  console.log(s);` → `hi`, identical both sides (differential; emits
  `tokio::fs::write(...).await?` + `read_to_string(...).await?`; `main` is
  `#[tokio::main]` and `Result`-returning — composes with 051). 
- **IO17** — async `readDir` sorted: `await fsAsync.mkdir(dir)` + writes, then
  `console.log((await fsAsync.readDir(dir)).join(","))` → sorted names,
  identical (differential; emits `tslib::io::read_dir_async(...).await?`).
- **IO18** — async fallible: `await fsAsync.readFile(missing)` inside a
  `try/catch` prints a program-controlled `"missing"` (differential; `.await?`
  propagation + the 051 awaited-fallible model). Un-awaited variant is IO-FL7.

## Network HTTP — DIFFERENTIAL via the loopback test server (design §6c/§8b DECIDED)

> **Note (design §6c/§8b, DECIDED 2026-07-16):** the harness starts a local
> `127.0.0.1:<PORT>` loopback server serving a **deterministic canned response** and
> feeds its base URL to **both** runs via `IoInput` (e.g. `T2R_BASE_URL`); both hit
> the same endpoint, so `res.status`/`res.body`/`res.ok` are byte-identical and their
> stdout is **diffed** (full differential — this replaces the earlier compile-only
> plan). First run may flake on the `reqwest` cold-cache fetch (cargo dep thundering
> herd, design §8a) — re-run to confirm.

- **IO19** — `http.get` differential: the fixture builds its URL from the
  harness-supplied base, `const res = await http.get(url); console.log(res.status,
  res.ok);` → prints the loopback server's canned status + `ok`, **identical** under
  Bun and Rust (differential; emits `tslib::http::get(...).await?`, `res.status` →
  the public `f64` field, `res.ok` → the public `bool` field).
- **IO20** — `http.post` differential: `const res = await http.post(url, body);
  console.log(res.body);` → prints the server's deterministic response body,
  **identical** both sides (differential; emits `tslib::http::post(...).await?`,
  `res.body` → the `body()` accessor).
- **IO21** — network is fallible + awaited: an un-caught `await http.get(url)` at
  `async main` scope makes `main` `Result`-returning; the successful loopback call
  prints its result **identically** both sides (differential; emitted Rust contains
  `.await?` and `-> Result<`).

## Recognition — aliasing routes by specifier, not name

- **IO22** — aliased import still routes: `import { readFile as rf } from
  "@ttr/std"; writeFile(p,"z"); console.log(rf(p));` → `z` (differential;
  recognition is by specifier — the 084/089 rule).
- **IO23** — a user's own `readFile` from elsewhere is **not** hijacked: a local
  `function readFile(){…}` (no `@ttr/std` import) lowers as an ordinary user fn,
  not the intrinsic (shape / behavioral — confirms no name heuristic).

## Fail-loud — bare footgun redirects (design §9)

- **IO-FL1** — bare `readFileSync(...)` / `fs.readFile` → fail-loud redirecting
  to `readFile` from `@ttr/std`.
- **IO-FL2** — bare `fetch(url)` → fail-loud redirecting to `http.get` from
  `@ttr/std`.
- **IO-FL3** — bare `process.argv` → fail-loud redirecting to `args`.
- **IO-FL4** — bare `process.env.X` → fail-loud redirecting to `env`.
- **IO-FL5** — bare `process.exit(0)` → fail-loud redirecting to `exit` from
  `@ttr/std`.
- **IO-FL6** — bare `process.stdin` read → fail-loud redirecting to
  `readStdin`/`readLine`.

## Fail-loud — out-of-surface I/O (deferred, not a redirect)

- **IO-FL7** — an `fsAsync.readFile(...)` / `http.get(...)` **not** directly
  awaited (un-polled future) → fail-loud with the 051 un-polled-future message.
- **IO-FL8** — synchronous network (a non-awaited/blocking HTTP outside an async
  fn) → fail-loud `synchronous network I/O is not supported — use `await
  http.get(url)`…`.
- **IO-FL9** — streaming read/write (chunked/`Readable`) → fail-loud
  `streaming I/O is not supported (only whole-file read/write)`.
- **IO-FL10** — `fs.watch` → fail-loud `filesystem watching is not supported`.
- **IO-FL11** — raw socket (`net`/`dgram`) → fail-loud `raw sockets are not
  supported`.
- **IO-FL12** — `http` with a header map / non-GET/POST method → fail-loud
  `only http.get/http.post of text bodies are supported…`.
- **IO-FL13** — unknown method on a `Writer` handle (`stdout().frob()`) →
  fail-loud `.frob on a Writer — only write/writeLine/flush are available` (the
  089 handle-method pattern).
- **IO-FL14** — unknown `@ttr/std` import name (`import { readSocket }`) →
  fail-loud `'readSocket' is not exported by "@ttr/std"` (unchanged 084 guard).
