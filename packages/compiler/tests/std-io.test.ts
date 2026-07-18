/**
 * Specs for series 100 — I/O via the `@ttr/std` shim lane (issue #65, epic #52).
 *
 * Sync fs / env / process / stdin (→ `std::fs`/`std::io`/`std::env`/`std::process`
 * + `tslib::io`), async fs (→ `tokio::fs`), and HTTP (→ `tslib::http` over
 * reqwest). Differential specs feed **identical** stdin/argv/env + a shared temp
 * dir (`T2R_TMP`) — and, for network, a loopback base URL (`T2R_BASE_URL`) — to
 * both the Bun run and the Rust run, so file round-trips / arg-env echoes /
 * stdin reads / HTTP calls are byte-diffed. Fail-loud specs assert the redirect /
 * deferral throws.
 *
 * Faithfulness discipline (design §6): file specs write **into the per-spec temp
 * dir** and print only program-produced round-tripped content; fallible specs
 * catch and print a **program-controlled** string (never platform-variant
 * `String(e)`). IDs map to docs/work/100-std-io/specs.md.
 *
 * First run may flake while the oracle fetches/builds `reqwest` cold (the cargo
 * dep thundering herd, design §8a) — re-run to confirm green.
 */

import { describe, expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";
import { UnsupportedError } from "../src/lower";

defineDifferential("std-io", [
  // ── Sync filesystem round-trips (T2R_TMP) ─────────────────────────────────
  {
    name: "IO1 temp-file write→read round-trip",
    src: `import { env, writeFile, readFile } from "@ttr/std";
const p: string = (env("T2R_TMP") ?? "") + "/io1.txt";
writeFile(p, "hello");
console.log(readFile(p));`,
    expected: "hello",
    tmp: true,
    extra: ({ rust }) => {
      expect(rust).toContain("tslib::io::write_file");
      expect(rust).toContain("tslib::io::read_file");
    },
  },
  {
    name: "IO2 writeFile truncates (overwrite)",
    src: `import { env, writeFile, readFile } from "@ttr/std";
const p: string = (env("T2R_TMP") ?? "") + "/io2.txt";
writeFile(p, "a");
writeFile(p, "b");
console.log(readFile(p));`,
    expected: "b",
    tmp: true,
  },
  {
    name: "IO3 appendFile",
    src: `import { env, writeFile, appendFile, readFile } from "@ttr/std";
const p: string = (env("T2R_TMP") ?? "") + "/io3.txt";
writeFile(p, "x");
appendFile(p, "y");
console.log(readFile(p));`,
    expected: "xy",
    tmp: true,
    extra: ({ rust }) => expect(rust).toContain("tslib::io::append_file"),
  },
  {
    name: "IO4 exists (infallible) — present + absent",
    src: `import { env, writeFile, exists } from "@ttr/std";
const p: string = (env("T2R_TMP") ?? "") + "/io4.txt";
writeFile(p, "1");
console.log(exists(p), exists(p + ".nope"));`,
    expected: "true false",
    tmp: true,
    extra: ({ rust }) => expect(rust).toContain("tslib::io::exists"),
  },
  {
    name: "IO5 removeFile then exists → false",
    src: `import { env, writeFile, removeFile, exists } from "@ttr/std";
const p: string = (env("T2R_TMP") ?? "") + "/io5.txt";
writeFile(p, "1");
removeFile(p);
console.log(exists(p));`,
    expected: "false",
    tmp: true,
  },
  {
    name: "IO6 mkdir + readDir sorted",
    src: `import { env, mkdir, writeFile, readDir } from "@ttr/std";
const dir: string = (env("T2R_TMP") ?? "") + "/io6";
mkdir(dir);
writeFile(dir + "/b.txt", "");
writeFile(dir + "/a.txt", "");
writeFile(dir + "/c.txt", "");
console.log(readDir(dir).join(","));`,
    expected: "a.txt,b.txt,c.txt",
    tmp: true,
    extra: ({ rust }) => expect(rust).toContain("tslib::io::read_dir"),
  },

  // ── Sync fallible — missing path → throw / Err ────────────────────────────
  {
    name: "IO7 readFile of a missing path throws → caught, program string",
    src: `import { env, readFile } from "@ttr/std";
const missing: string = (env("T2R_TMP") ?? "") + "/nope.txt";
try {
  const s: string = readFile(missing);
  console.log(s);
} catch {
  console.log("missing");
}`,
    expected: "missing",
    tmp: true,
  },
  {
    name: "IO8 uncaught fallible propagates → main is Result, non-zero",
    src: `import { env, readFile } from "@ttr/std";
const missing: string = (env("T2R_TMP") ?? "") + "/nope8.txt";
const s: string = readFile(missing);
console.log(s);`,
    expectFail: true,
    tmp: true,
    extra: ({ rust }) => {
      expect(rust).toContain("-> Result<");
      expect(rust).toContain("tslib::io::read_file");
      expect(rust).toContain("?");
    },
  },

  // ── args / env / stdin echo (harness-fed inputs) ──────────────────────────
  {
    name: "IO9 args echo",
    src: `import { args } from "@ttr/std";
console.log(args().join(","));`,
    expected: "x,y,z",
    io: { args: ["x", "y", "z"] },
    extra: ({ rust }) => expect(rust).toContain("tslib::io::args"),
  },
  {
    name: "IO10 env present",
    src: `import { env } from "@ttr/std";
console.log(env("T2R_GREETING") ?? "none");`,
    expected: "hi",
    io: { env: { T2R_GREETING: "hi" } },
    extra: ({ rust }) => expect(rust).toContain("tslib::io::env"),
  },
  {
    name: "IO11 env absent → null → fallback",
    src: `import { env } from "@ttr/std";
console.log(env("T2R_NOPE_UNSET") ?? "none");`,
    expected: "none",
  },
  {
    name: "IO12 readStdin echo",
    src: `import { readStdin } from "@ttr/std";
console.log(readStdin());`,
    io: { stdin: "line one\nline two\n" },
    expected: "line one\nline two",
    extra: ({ rust }) => expect(rust).toContain("tslib::io::read_stdin"),
  },
  {
    name: "IO13 readLine loop to EOF",
    src: `import { readLine } from "@ttr/std";
let l = readLine();
while (l !== null) {
  console.log(l);
  l = readLine();
}`,
    io: { stdin: "a\nb\nc\n" },
    expected: "a\nb\nc",
    extra: ({ rust }) => expect(rust).toContain("tslib::io::read_line"),
  },

  // ── Standard-stream Writer handle — byte-precise stdout ────────────────────
  {
    name: "IO14 stdout().write — no trailing newline",
    src: `import { stdout } from "@ttr/std";
const w = stdout();
w.write("ab");
w.write("cd");`,
    expected: "abcd",
    extra: ({ rust }) => {
      expect(rust).toContain("tslib::io::stdout()");
      expect(rust).toContain(".write(");
    },
  },
  {
    name: "IO15 stderr().writeLine → stdout stays empty",
    src: `import { stderr } from "@ttr/std";
stderr().writeLine("e");`,
    expected: "",
    extra: ({ rust }) => {
      expect(rust).toContain("tslib::io::stderr()");
      expect(rust).toContain("write_line");
    },
  },

  // ── Async filesystem — tokio::fs ──────────────────────────────────────────
  {
    name: "IO16 async fs round-trip",
    src: `import { env, fsAsync } from "@ttr/std";
const p: string = (env("T2R_TMP") ?? "") + "/io16.txt";
await fsAsync.writeFile(p, "hi");
const s = await fsAsync.readFile(p);
console.log(s);`,
    expected: "hi",
    tmp: true,
    extra: ({ rust }) => {
      expect(rust).toContain("#[tokio::main]");
      expect(rust).toContain("tslib::io::write_file_async");
      expect(rust).toContain(".await?");
    },
  },
  {
    name: "IO17 async readDir sorted",
    src: `import { env, fsAsync } from "@ttr/std";
const dir: string = (env("T2R_TMP") ?? "") + "/io17";
await fsAsync.mkdir(dir);
await fsAsync.writeFile(dir + "/b", "");
await fsAsync.writeFile(dir + "/a", "");
const xs = await fsAsync.readDir(dir);
console.log(xs.join(","));`,
    expected: "a,b",
    tmp: true,
    extra: ({ rust }) => expect(rust).toContain("tslib::io::read_dir_async"),
  },
  // IO18 (catching an async I/O error inside try/catch) is a deferred residual —
  // recovery lowers to a sync `Result` IIFE that cannot host `.await`. It is
  // fail-loud (see the "out-of-surface" describe below); the *uncaught* async
  // fallible path (IO16/IO17/IO19/IO21) propagates via `.await?` and is covered.

  // ── Network HTTP — differential via the loopback server ───────────────────
  {
    name: "IO19 http.get differential",
    src: `import { env, http } from "@ttr/std";
const base: string = env("T2R_BASE_URL") ?? "";
const res = await http.get(base + "/");
console.log(res.status, res.ok);`,
    expected: "200 true",
    net: true,
    extra: ({ rust }) => {
      expect(rust).toContain("tslib::http::get");
      expect(rust).toContain(".await?");
    },
  },
  {
    name: "IO20 http.post differential (echo body)",
    src: `import { env, http } from "@ttr/std";
const base: string = env("T2R_BASE_URL") ?? "";
const res = await http.post(base + "/", "hi");
console.log(res.body);`,
    expected: "echo:hi",
    net: true,
    extra: ({ rust }) => expect(rust).toContain("tslib::http::post"),
  },
  {
    name: "IO21 network fallible + awaited → main Result",
    src: `import { env, http } from "@ttr/std";
const base: string = env("T2R_BASE_URL") ?? "";
const res = await http.get(base + "/");
console.log(res.status);`,
    expected: "200",
    net: true,
    extra: ({ rust }) => {
      expect(rust).toContain("-> Result<");
      expect(rust).toContain(".await?");
    },
  },

  // ── Recognition — routes by specifier, not name ───────────────────────────
  {
    name: "IO22 aliased import still routes",
    src: `import { env, readFile as rf, writeFile as wf } from "@ttr/std";
const p: string = (env("T2R_TMP") ?? "") + "/io22.txt";
wf(p, "z");
console.log(rf(p));`,
    expected: "z",
    tmp: true,
  },
  {
    name: "IO23 a user's own readFile is not hijacked",
    src: `function readFile(): string {
  return "user";
}
console.log(readFile());`,
    expected: "user",
    extra: ({ rust }) => expect(rust).toContain("fn readFile("),
  },
]);

// ── Fail-loud — bare footgun redirects (design §9) ───────────────────────────

describe("100 fail-loud — bare footgun redirects", () => {
  test("IO-FL1 bare node:fs import → redirect", () => {
    expect(() =>
      compile(`import { readFileSync } from "node:fs";
const s: string = readFileSync("x", "utf8");`),
    ).toThrow();
  });
  test("IO-FL2 bare fetch → redirect to http", () => {
    expect(() => compile(`const p = fetch("http://x/");`)).toThrow(
      /fetch.*http.*@ttr\/std/,
    );
  });
  test("IO-FL3 bare process.argv → redirect to args", () => {
    expect(() => compile(`const a = process.argv;`)).toThrow(/process\.argv/);
  });
  test("IO-FL4 bare process.env → redirect to env", () => {
    expect(() => compile(`const x = process.env.HOME;`)).toThrow(/process\.env/);
  });
  test("IO-FL5 bare process.exit → redirect to exit", () => {
    expect(() => compile(`process.exit(0);`)).toThrow(/process\.exit/);
  });
  test("IO-FL6 bare process.stdin → redirect to readStdin/readLine", () => {
    expect(() => compile(`const s = process.stdin;`)).toThrow(/process\.stdin/);
  });
});

// ── Fail-loud — out-of-surface I/O (deferred, not a redirect) ────────────────

describe("100 fail-loud — out-of-surface I/O", () => {
  test("IO-FL7 an un-awaited async-I/O future is fail-loud", () => {
    expect(() =>
      compile(`import { http } from "@ttr/std";
const r = http.get("http://x/");`),
    ).toThrow(/not directly awaited|un-polled/);
  });
  test("IO-FL8 a bare (non-awaited) http call is fail-loud", () => {
    expect(() =>
      compile(`import { http } from "@ttr/std";
http.get("http://x/");`),
    ).toThrow(UnsupportedError);
  });
  test("IO18 catching an async I/O error (await in try/catch) is deferred", () => {
    expect(() =>
      compile(`import { env, fsAsync } from "@ttr/std";
const missing: string = (env("T2R_TMP") ?? "") + "/nope.txt";
try {
  const s = await fsAsync.readFile(missing);
  console.log(s);
} catch {
  console.log("missing");
}`),
    ).toThrow(/await inside a try\/catch/);
  });
  test("IO-FL12 an unknown http method (non-GET/POST) is fail-loud", () => {
    expect(() =>
      compile(`import { http } from "@ttr/std";
const res = await http.put("http://x/");`),
    ).toThrow(/only get\/post|http/);
  });
  test("IO-FL13 an unknown Writer method is fail-loud", () => {
    expect(() =>
      compile(`import { stdout } from "@ttr/std";
const w = stdout();
w.frob("x");`),
    ).toThrow(/Writer|write.*writeLine.*flush/);
  });
  test("IO-FL14 an unknown @ttr/std import name is fail-loud", () => {
    expect(() =>
      compile(`import { readSocket } from "@ttr/std";`),
    ).toThrow(/not exported/);
  });
  test("IO-FL9/10/11 streaming/watch/socket names are not exported", () => {
    for (const name of ["createReadStream", "watch", "connect"]) {
      expect(() =>
        compile(`import { ${name} } from "@ttr/std";`),
      ).toThrow(/not exported/);
    }
  });
});
