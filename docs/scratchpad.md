# Scratchpad & Notes

Working notes. Settled decisions live in plan.md / architecture.md / dialect.md;
this file holds genuinely-open questions only.

## Resolved

- **Parser**: `oxc-parser` (`parseSync`). Note its JS API emits an *ESTree* AST,
  not the `@oxc-project/types` shape — see architecture.md.
- **Memory model**: **Option A (idiomatic borrows)**, decided. Rationale and the
  resulting escape-analysis obligation are in plan.md. `Rc<RefCell<T>>` is a
  local fallback, not the default. (This supersedes the old "investigate Option
  B" note — Option B is rejected: it makes targeting Rust pointless.)
- **Oracle**: compile + run via the harness; differential testing. Hand-written
  `.rs` golden files are gone.
- **Async runtime**: **tokio**, decided. TS `async function` → Rust `async fn`;
  the generated entry point becomes `#[tokio::main]`. tokio is pinned in the
  `.scratch` crate. The harness runs **offline-first with an online fallback**:
  it tries `--offline` (fast, warm cache) and only retries online when cargo
  fails *before emitting any diagnostic* — the signature of a cold-cache
  dependency fetch, not a code error.

## Open questions

1. **Numeric inference.** When does `number` become `i64`/`usize` instead of
   `f64`? Minimum viable rule: anything used as an array index or `for`-counter,
   and anything only ever holding integer literals + integer arithmetic. Needs
   the symbol table to be reliable. Until then, `f64` everywhere (known to break
   `arr[i]`).

2. **`string` borrow strategy.** Default `String` (owned) is safe but allocates.
   Promoting read-only string params to `&str` is an output of the ownership
   pass — needs that pass first.

3. **Ownership inference scope.** Intra-procedural is straightforward; the hard
   part is the *caller* side (move vs. `&`/`&mut` at call sites) which needs
   whole-program-ish liveness. Start intra-procedural with conservative
   by-value/`&mut`-on-mutation, then refine.

4. **Async cancellation / Promise semantics.** tokio is settled (see Resolved),
   but JS promises are eager and multi-await-able while Rust futures are lazy and
   single-poll. Decide how faithfully to model this (e.g. whether `await`ing the
   same binding twice is rejected by the dialect) when implementing `07_async`.
