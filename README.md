# typescript-to-rust <sub>·&nbsp;`ttr`</sub>

![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)
![Status: pre-release (v0.1.0)](https://img.shields.io/badge/status-pre--release-orange)

**Translate a strict subset of TypeScript into _idiomatic_ Rust — with real
ownership, not `Rc<RefCell>`-everything.**

`ttr` is a language-level translator. It reads an explicitly-enforced TypeScript
dialect and emits Rust that a human would be happy to have written: borrows where
TypeScript passes by reference, owned values where it hands ownership over, `&self`
vs `&mut self` methods, plain structs and enums. It is written in TypeScript on
Bun, and the generated Rust is judged by a **real `cargo` toolchain** (it must
compile and run) — never by string matching.

## Example

The dialect maps directly onto Rust's ownership model. A read-only method borrows
(`&self`); a mutating one takes `&mut self`, which forces the binding to be `mut`:

<table>
<tr><th>TypeScript in</th><th>Rust out</th></tr>
<tr valign="top"><td>

```ts
class Rect {
  w: number;
  h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
  }
  area(): number {
    return this.w * this.h;
  }
  scale(k: number): void {
    this.w = this.w * k;
    this.h = this.h * k;
  }
}

const r: Rect = new Rect(2, 3);
r.scale(2);
console.log(r.area());
```

</td><td>

```rust
struct Rect {
    w: f64,
    h: f64,
}

// (auto-derived JsEq/Debug/Clone impls elided)

impl Rect {
    fn new(w: f64, h: f64) -> Rect {
        return Rect { w: w, h: h };
    }
    fn area(&self) -> f64 {
        return self.w * self.h;
    }
    fn scale(&mut self, k: f64) {
        self.w = self.w * k;
        self.h = self.h * k;
    }
}

fn main() {
    let mut r: Rect = Rect::new(2.0, 3.0);
    r.scale(2.0);
    println!("{}", r.area());
}
```

</td></tr></table>

Pass a collection and it borrows — the caller keeps ownership:

```ts
function totalQty(items: Array<Item>): number { /* … */ }
//  ⇒  fn totalQty(items: &Vec<Item>) -> f64 { … }
//     call site:  totalQty(&vec![a, b])
```

## What this is (and isn't)

It is a translator for an **explicitly-enforced TypeScript dialect**. It is **not**
"compile any TypeScript" — TS is unsound and garbage-collected, so a total mapping
onto Rust's ownership model does not exist. Tractability comes from restricting the
input, and everything outside the dialect **fails loud** at translation time rather
than emitting subtly-wrong Rust. See [docs/dialect.md](./docs/dialect.md) for the
accepted subset.

## Install

> **Prerequisite: a Rust toolchain.** `ttr` shells out to `cargo` to format,
> type-check, and run the Rust it produces. Install Rust via
> [rustup](https://rustup.rs) before using `ttr`.

**From source (available today):**

```bash
git clone https://github.com/hoodiecollin/typescript-to-rust
cd typescript-to-rust
bun install
bun run ttr packages/compiler/sample.ts --run   # TS → Rust → compile → run
```

**Coming with the v0.1.0 release:**

| Channel | Command |
| --- | --- |
| npm (bunx / npx) | `bunx @ttr/cli path/to/file.ts` |
| Standalone binary | download from GitHub Releases |
| Homebrew | `brew install hoodiecollin/ttr/ttr` |
| crates.io | the `tslib` / `ts-primitives` runtime crates the emitted code depends on |

## Usage

```bash
bun run ttr <file.ts>          # print Rust to stdout
bun run ttr <file.ts> --fmt    # …run it through rustfmt first
bun run ttr <file.ts> --emit   # write a sibling <file>.rs (or -o <path>)
bun run ttr <file.ts> --check  # also `cargo check` the result
bun run ttr <file.ts> --run    # compile and run it
```

A lone entry emits one `.rs`; an entry that imports `./`-relative modules emits a
multi-file crate. Bare / package imports are refused fail-loud.

## How it works

The pipeline parses TS with [oxc](https://oxc.rs), validates it against the dialect,
lowers it to a HIR that resolves ownership (moves vs borrows, `&self` vs `&mut self`),
and pretty-prints Rust. Correctness is enforced by an **oracle**: fixtures are
compiled and run through a real `cargo` toolchain, so a passing test means the Rust
actually builds and produces the expected output. See
[docs/architecture.md](./docs/architecture.md).

## Docs

- [docs/dialect.md](./docs/dialect.md) — the accepted TypeScript subset.
- [docs/architecture.md](./docs/architecture.md) — pipeline, oracle harness,
  emitter invariants.
- [docs/plan.md](./docs/plan.md) — goal, memory-model decision, status.

## Contributing

Contributions are welcome. The development workflow (spec-first BDD, oracle-driven
TDD, no barrel files) is documented in [.agents/AGENTS.md](./.agents/AGENTS.md). The
one gate to run before opening a PR:

```bash
bun run check    # typecheck + Rust tests + compiler tests
```

## Layout

- `packages/compiler/` — parser front-end, emitter, and the cargo-backed
  verification harness.
- `packages/std/` — `@ttr/std`, the TS-side standard-library shim.
- `crates/tslib/` — the Rust runtime for JS-behavioral fidelity (methods whose
  semantics diverge from the obvious Rust).
- `crates/ts-primitives/` — minimal runtime (`TsAny`) for the rare constructs
  without a clean static mapping.
- `apps/website/` — the documentation site.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](./LICENSE-APACHE))
- MIT license ([LICENSE-MIT](./LICENSE-MIT))

at your option. Unless you explicitly state otherwise, any contribution
intentionally submitted for inclusion in this project by you, as defined in the
Apache-2.0 license, shall be dual licensed as above, without any additional
terms or conditions.
