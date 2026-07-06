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

## Open questions — raised 2026-07-06 (post error-recovery trio)

5. **Fail-loud gap: esoteric features are silently *mistranslated*, not rejected.**
   The dialect validator (`validate.ts`) only rejects `any`/`unknown` today, and
   the AST walk ignores parts it doesn't model — so several constructs pass
   through *wrong* instead of failing loud (verified by probe):
   - `function* g()` (generator) → emitted as a plain `fn g()`; the `*`/`yield`
     semantics vanish. Sync **and** async generators.
   - `for await (const x of xs)` → emitted as an ordinary `for x in xs.iter()`;
     the async-iteration/await is dropped.
   - `using r = …` (explicit resource mgmt / `Symbol.dispose`) → emitted as a
     plain `let r = …`; the deterministic-dispose semantics vanish (ironically
     Rust's `Drop` *could* model this well — see below).
   - `@decorator class C` → the decorator is dropped, class emitted bare.
   This is the highest-priority correctness item: it violates the project's
   fail-loud contract. **Action:** extend `validate.ts` to *reject* generators,
   `for await`, `using`, decorators, and any other unmodelled node kind (a
   default-deny "unknown node → DialectError" pass), before considering whether to
   *support* any of them. Ranking if we later support them (complexity × how
   common in real TS): decorators (high complexity, common in Nest/Angular/TypeORM
   — but semantics are library-defined, poor Rust target); `using`/`Disposable`
   (medium complexity, rising usage, **excellent** Rust fit via `Drop` — likely
   the best ROI); generators (high complexity — need a state machine or
   `Iterator`/`Stream` impl, moderate usage); async generators / `for await`
   (highest complexity — `Stream`, niche usage). Rough order to *support*:
   `using`→`Drop` first, then sync generators→`Iterator`, decorators/async-gen
   last (or never).

6. **Codegen mechanism — settled, but worth recording.** It is **not** naive
   string concatenation of source: there is a typed IR (`hir.ts`) and a pure,
   *total* HIR→string emitter (`emitter.ts`) with an exhaustiveness guard (a
   `switch` returning `string` with no `default`, so a new node forces a new
   case). What we do *not* have is a Rust **AST** with a real pretty-printer — the
   emitter renders strings directly (template literals) and relies on `rustfmt`
   for final normalization. Open question: is a structured Rust-AST + printer
   (à la `prettyplease`/`quote`) worth it? Likely **no** while output stays
   line-oriented; revisit if we ever need precedence-aware expression nesting
   (e.g. auto-parenthesizing) that string rendering makes error-prone.

7. **Do we get rich type inference to avoid explicit annotations?** Two parts:
   - **Locals** (`const y = f()`, `const x = 5`): **already work without
     annotations** — but *because Rust infers them*, not because we do. We emit
     `let y = f()` / `let x = 5.0` and let rustc/our numeric pass settle the type.
     So no TS-side inference needed for local `let`/`const` initializers.
   - **Params / return types / fields:** **required** today (`lowerParam` throws on
     a missing annotation). oxc is a *parser*, not a typechecker — it gives us no
     inference. To drop annotations here we'd need either our own Hindley–Milner-ish
     pass or to embed a real TS type-checker (tsc API / ts-morph / STC). Open
     question: is annotation-required an acceptable permanent dialect constraint
     (cheap, honest) vs. investing in inference (large, enables friendlier input)?
     Leaning: keep params annotated; only revisit if adoption friction demands it.

8. **A `tslib` runtime crate as a translation target for native prototypes.**
   Instead of special-casing every `Array`/`Object`/`String`/`Function` method in
   the emitter, provide a small crate (mirrors the existing `ts-primitives`/`TsAny`
   precedent) so e.g. `someArr.map(f)` → `tslib::array::map(&arr, f)` (or a trait
   ext). Pros: keeps method semantics *out* of codegen, gives one tested home for
   JS-quirk fidelity (e.g. `.sort()` default string compare, `.map` index arg,
   negative-index `.at()`), and makes the emitter's job "pick the target symbol,"
   not "reimplement the method." Cons: less idiomatic output (a `tslib::` call vs.
   a native `.iter().map()`), and closures (`f`) still need real arrow/closure
   support first. Open question: **hybrid** — emit idiomatic native Rust for the
   methods that map cleanly (`.map`/`.filter`/`.length`) and fall back to `tslib::`
   only for quirk-heavy ones (`.sort`, `.splice`, loose-equality helpers)? This is
   the likely sweet spot. Ranking of library surfaces to support (complexity ×
   popularity): Array iteration methods (`map`/`filter`/`reduce`/`forEach` — high
   popularity, medium complexity, blocked on value-position closures) first;
   `Object`/`JSON` helpers next; JS iterators/`Symbol.iterator` (medium/medium);
   event emitters (low popularity in pure-logic TS, high complexity — channels/
   callbacks — likely out of scope).

9. **Compiler directives to alter per-scope behavior (Vercel-style).** Vercel's
   Workflow SDK uses function-level string directives — `"use workflow"` /
   `"use step"` — as *compile-time contracts*: the build tool sees the directive
   and transforms/validates that function differently (sandboxing, determinism
   checks, turning step calls into enqueued+cached ops), à la React's
   `"use client"`/`"use server"`. Analogue for us: let a function/block opt into a
   different translation strategy, e.g. `"use rc"` (translate this scope under the
   Option-B `Rc<RefCell<T>>` managed-memory model when idiomatic borrows can't
   express the aliasing), `"use panic"` (translate `throw` as `panic!` instead of
   `Result` in a scope where recovery isn't wanted), or `"use unsafe"`/`"use
   arena"` opt-ins. Mechanically cheap to detect (a leading `ExpressionStatement`
   string literal in a block — already in the ESTree AST) and a clean, *explicit*
   escape hatch that keeps the default dialect strict while letting the user
   widen it locally. Open question: which behaviors are worth a directive vs. an
   annotation vs. staying out-of-dialect? Strongest candidate: `"use rc"` as the
   sanctioned bridge to the Option-B fallback the plan already reserves.
