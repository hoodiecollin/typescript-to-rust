# 099 — Inference tier: relax "explicit annotation required" via a lib-backed TypeOracle

## Decisions (DECIDED 2026-07-16)

The §7 sub-decisions (previously "recommended defaults") are now **DECIDED** — the
owner accepted every recommended default. Build to these; the §7 rows below are
retained as rationale.

- **Lib set (A): DECIDED = pin the `es2022`-ish bundle** matching the already-accepted
  built-in surface (`Object.entries`, `Array.prototype.at`, `.map`, template
  machinery) — explicit and deterministic, not the tsc default.
- **Wide (non-nullish) inferred unions (B): DECIDED = stay fail-loud.** Inferring an
  anonymous enum from a join is a guess; the user annotates to name the union (093
  enums are name-driven). Nullish unions (`T|undefined`/`T|null`) remain the sole
  modeled exception.
- **Class-field non-literal initializers (C): DECIDED = deferred** to a later series
  (out of the decided "bindings + returns" scope; the `Option`-wrapping /
  ctor-vs-initializer interaction needs its own care).
- **By-construction binding exemptions (D): DECIDED = keep as a fast pre-check** this
  series (they short-circuit before the oracle); retiring the subsumed ones is a
  follow-up cleanup, not now.
- **Return-inference span (E): DECIDED = `getReturnTypeOfSignature`** on the fn/method
  signature (robust to multi-return / implicit `undefined`) over span-matching a
  single `return` expression.
- **Parameters stay required (from §"Collin's decision"): DECIDED** — a param is
  implicit `any`, which the dialect forbids; no sound type to infer. Hard boundary,
  not a deferral.

### Cross-cutting ordering dependency (with 050 modules)

**099 (this inference tier) lands before 050 (modules).** The module resolver's
**global symbol table** reads exported-function **signatures**; if 099 lets an
exported fn omit its return annotation, that signature is *inferred*, so inference
must produce it **before** 050's visibility/resolution passes run. The inferred type
(not the absent annotation) is what 050's `private_interfaces` reachable-type closure
widens to `pub(crate)`. This is a direct ordering dependency: 099's inferred output
must be available to 050's global symbol table.

## Status

Design. Graduates the "Explicit type annotations on every variable … and function
return type" positive rule (`docs/dialect.md`, *Required (the positive rules)*)
from a hard requirement to an **inference-with-re-validation** rule. Builds the
"later, lazy tier" that `type-oracle.ts`'s own header (lines ~17-20) and the 082
design (`docs/work/_archive/082-type-oracle/design.md`, *Fail-loud residuals* and
*Impl decomposition* step 2, "#48 driver") explicitly deferred.

## Collin's decision (already made — build to it)

Relax the required-annotation rule on **two** positions, keep it on the third:

1. **(a) local `const`/`let`/`var` bindings** — an un-annotated binding whose
   initializer's type the oracle can infer *and* which re-validates to a modeled
   `RustType` no longer fails loud; it uses the inferred type.
2. **(b) function / method / static-method / getter return types** — same: infer,
   re-validate, use; else keep today's fail-loud message.
3. **Parameters stay required.** A parameter type cannot be inferred from a
   declaration — `tsc` gives an un-annotated param **implicit `any`**, which the
   dialect forbids (`DialectError` on `any`). There is no sound type to infer, so
   the `parameter '<name>' without a type annotation` throw is unchanged. This is
   a *hard* boundary, not a deferral.

Top-level scope is DECIDED. The only open items are the sub-decisions in §7, each
presented with a recommended default for sign-off.

## 1. Approach — flip the oracle to a lazy, lib-backed inference tier

### Today: `noLib`, annotation-only

`createTypeOracle` (`type-oracle.ts:76`) builds its `ts.Program` with
`{ noLib: true }`. Under `noLib` there is no `lib.d.ts`, so:

- Built-in method signatures don't exist. `xs.map(x => x*2)` has no resolvable
  return type; a template literal has no `string` type flowing from the built-in
  template machinery; `Object.entries` has no signature. The checker can only read
  back **types the source states explicitly** (annotations, and struct/enum
  declarations in-file).
- `Map`/`Set` are *unresolved* lib types. The oracle extracts their name/args
  through the **alias view** (`aliasSymbol` / `aliasTypeArguments`) — this is the
  `nameOf` / `argsOf` split, and the `argsOf` alias-first-then-reference comment
  (`type-oracle.ts:105-112`) already anticipates the lib tier ("present once a lib
  tier lands").
- Cost: ~1 ms per compile (082 measured). This fast path is the reason `noLib` was
  chosen for slice 1 — annotation resolution needs nothing more.

### Proposed: lazy lib load, cached, on first inference query

Inferring *through* built-in signatures needs `lib.d.ts` loaded into the program.
Loading the default libs is the expensive part (the checker must parse and bind
~tens of thousands of lines of `lib.es*.d.ts`). Estimated cost: **tens of ms**
one-time (a `lib`-enabled `createProgram` + first `getTypeChecker()` walk), vs the
~1 ms `noLib` build. That is a real regression for the common case — most compiled
modules are fully annotated and never need inference.

So: **do not** flip the existing program to lib mode. Keep the `noLib` program as
the fast path and add a **second, lazily-built lib-enabled program** consulted only
when an un-annotated position actually asks for inference:

```ts
interface TypeOracle {
  // unchanged, noLib, ~1 ms:
  typeAtSpan(start, end): ts.Type | null;
  collectionAtSpan(start, end): RustType | null;
  typeAtSpan_rustType(start, end): RustType | null;
  // NEW — lib-backed, lazy. Infers a binding/return type through built-in
  // signatures, then re-validates to a modeled RustType (§2). null ⇒ caller
  // keeps its existing fail-loud message. First call pays the lib-load cost;
  // subsequent calls reuse the cached lib program + checker.
  inferredRustType(start, end): RustType | null;
}
```

- The lib program/checker are built once, memoized in a closure variable, on the
  **first** `inferredRustType` call. A module with zero un-annotated
  binding/return positions never triggers it → zero perf change.
- Same host shape as today, but `{ noLib: false, lib: [...], target }` and a
  `getDefaultLibFileName` / `fileExists` / `readFile` that actually serve the
  `lib.*.d.ts` from the resolved `typescript/lib` directory (via the same
  `createRequire` path that loads the v5.9.3 API — the lib files sit beside
  `typescript.js`). Pin the lib set explicitly (recommend the `es2022`/`esnext`
  bundle that matches the surface the dialect already accepts — `Object.entries`,
  `Array.prototype.at`, `.map`, `String` template machinery) rather than the tsc
  default, so the inferable surface is deterministic and reviewable.

### Reconciliation with the existing `noLib` slice-1 surface

**No existing resolution changes.** `collectionAtSpan` and `typeAtSpan_rustType`
keep calling the `noLib` program. The lib program is a *sibling*, only reached by
the new `inferredRustType` entry point, so:

- Every `collectionOf` / `receiverTypeOf` answer the 082/083 tiers produce today is
  byte-for-byte identical (same program, same alias-view extraction).
- The `argsOf` alias-vs-reference view matters here: under `noLib`, `Map`/`Set`
  args come through `aliasTypeArguments`; under lib, a `Map` receiver resolves
  through the **reference** view (`getTypeArguments`). `argsOf` already tries alias
  first, then reference — so the **same `rustTypeOf` mapper works unchanged against
  a lib-resolved type**, which is exactly why the new tier can reuse it. We only
  ever *add* a resolution path; we never mutate the one the slice-1 surface reads.
- If a future slice wants to *retire* the `noLib` program and serve everything from
  the lib program, that is a separate perf/consolidation decision (out of scope);
  keeping both is the zero-regression choice now.

### Relationship to issue #61 (tsgo v7 native checker)

#61 tracks migrating the oracle off the v5.9.3 JS API onto the tsgo **v7 native**
checker, behind the same `typeAtSpan` boundary — externally blocked (no v7
compiler API yet). This series stays on the **v5.9.3 JS API already loaded via
`createRequire`** (`type-oracle.ts:31-32`). The new `inferredRustType` method sits
*behind* the same `TypeOracle` boundary, so when #61 unblocks, the lib-backed tier
migrates with the rest — no new coupling to the JS-API surface beyond what 082/083
already have.

## 2. The re-validation gate — inferred `Type` → `RustType`, or fail-loud

Inference gives a `tsc Type`. That type may be **outside the accepted dialect
surface** (an inferred tuple, function type, anonymous object, wide union, `any`
leaking from an un-annotated helper, etc.). The gate MUST:

1. Translate the inferred `Type` to a `RustType` via the existing `rustTypeOf`
   (extended, see below), reusing the same mapper `collectionAtSpan` uses so the
   accepted surface is defined in exactly one place.
2. Return `null` for **anything outside the modeled surface** — the caller then
   keeps its existing fail-loud message. Nothing outside the surface is ever
   silently accepted; the annotation requirement is replaced by inference **only
   where inference lands on a type the dialect already models**.

This is the critical fail-loud invariant: the annotation rule was a *forcing
function* that kept the surface narrow (§5). The re-validation gate now does that
job — an inferred type that doesn't map is exactly as loud as a missing annotation
was, and points at the same fix (annotate it) via the unchanged throw.

### Which inferred shapes GRADUATE to accepted

Mapped by `rustTypeOf` (current + small extensions), so an inferred instance of any
of these is accepted:

| Inferred `tsc` type | `RustType` | Source of mapping |
|---|---|---|
| `string` (incl. template-literal result) | `String` | `rustTypeOf` StringLike |
| `number` | `f64` (value position) | `rustTypeOf` NumberLike — see §4 |
| `boolean` | `bool` | `rustTypeOf` BooleanLike |
| `T[]` / `Array<T>` / `ReadonlyArray<T>` (T modeled) | `vec<elem>` | `rustTypeOf` Array arm (083) |
| `Map<K,V>` / `Set<T>` (K/V/T modeled) | `hashmap` / `set` | `rustTypeOf` Map/Set arms |
| a declared in-file `interface`/`class`/`enum` name in `structs` | `struct` | `rustTypeOf` struct arm |
| `T | undefined` / `T | null` (T modeled) — an inferred `Option` | `option<inner>` | **extension** (see below) |
| `Promise<T>` (inferred async return, T modeled) | `T` at the await/return site | **extension**, mirrors `lowerType`'s Promise handling |

**Extensions to `rustTypeOf` needed for the return/binding surface** (the current
mapper was scoped to Map/Set key/elem, which never sees `Option`/`Promise`):

- **Nullable union → `option`**: an inferred `T | undefined` / `T | null` must map
  to `{kind:"option", inner}` exactly as `lowerType` does for the annotated form —
  otherwise an un-annotated `const c = s.at(i)` (already exempt today by a special
  case) would regress. Recommended: fold the existing `isStringAtCall` /
  `isArrayFindCall` special-case exemptions **into** this general path so the
  hand-maintained exemption list in the binding gate (`lower.ts:7684-7711`) can
  shrink over time (see §7-D).
- **`Promise<T>` → inner `T`**: a fn/method with an inferred `async` return infers
  `Promise<T>`; the return-position mapping unwraps to `T` (the emitter already
  wraps async returns), matching `lowerType`.

### Which inferred shapes STAY fail-loud (map to `null`)

Enumerated so the gate is reviewable — each is a type the dialect does not model,
so inference declining it is correct, not a gap:

- **`any`** — forbidden (`DialectError` territory). An inferred `any` (e.g. a
  helper that itself lost its type) must **never** be accepted. `rustTypeOf`
  returns null; better still, the gate can *explicitly* reject an `any`/`unknown`
  inferred type with the existing `DialectError` message so the class is right.
- **`unknown`** — same.
- **tuple type** (`[number, string]`) — not in the surface (dialect *Types* table,
  "tuple … Not yet"). null.
- **function type** (an inferred `(x) => y` value, `fnPtr`) — not a binding/return
  surface type here. null → fail-loud. (Distinct from a lifted-callback context.)
- **anonymous object literal type** (`{ a: number; b: string }` with no declared
  name) — the dialect requires *named* shapes (positive rule: "statically-known,
  closed object shapes via interface/type/class"). An inferred anonymous object has
  no nominal name for a `struct`, so null. (This is the common `Object.entries`
  shape's element being a **named** tuple — `Object.entries` stays on its
  by-construction exemption, unchanged.)
- **wide / non-nullish union** (`string | number`, `A | B`) — 093 lowers *annotated*
  unions to enums by name; an **inferred anonymous** union has no alias name to
  synthesize a stable enum from in this path, and inferring an enum shape from a
  join is exactly the kind of guess the fail-loud philosophy forbids. null →
  fail-loud (annotate the union to name it). (Nullish unions `T|undefined`/`T|null`
  are the modeled exception above.)
- **`bigint` / `symbol`** — forbidden/unmodeled. null.
- **a generic type parameter escaping inference** — null.
- **anything `rustTypeOf` doesn't recognize** — null (the existing default).

## 3. Where it plugs in — per throw site

Each site's new flow is: *no annotation → ask `inferredRustType` → if it returns a
modeled `RustType`, use it; else throw the existing message unchanged.* The oracle
is `analysis.typeOracle` (nullable when compiled without source — that path keeps
today's behavior exactly, same as 082's no-source guarantee).

| Site | File:line (approx) | New flow |
|---|---|---|
| **binding** `const`/`let`/`var` | `lower.ts:7681` gate; `ty` set at ~7655 | When `ty === null` and no by-construction exemption fires, call `inferredRustType(d.init.start, d.init.end)`. Non-null → use as `ty` (feeds `lowerTyped` and `bindingTypes`). Null → the `binding '<name>' without a type annotation` throw. |
| **fn return** | `lower.ts:1564` | `if (!func.returnType)` → `inferredRustType` over the fn body's inferred return (span the fn node / its signature). Non-null → `ret`. Null → `function '<name>' without a return type annotation`. |
| **method return** | `lower.ts:4975` | Same, → `method '<name>' without a return type annotation`. |
| **static-method return** | `lower.ts:4060` | Same, → `static method '<name>' without a return type annotation`. |
| **getter return** | `lower.ts:4106` | Same, → `getter '<name>' without a return type annotation`. |
| **class field** | `lower.ts:8414` | Already has an `inferInitType` path for a literal initializer. Optionally extend to `inferredRustType` for a non-literal initializer (§7-C — recommend deferring; ctor-assigned fields are the common case and this needs care around `Option`-wrapping). |
| **parameter** | `lower.ts:5062` (+ default-param `5033`) | **UNCHANGED.** No inference — a param is implicit `any`. Keep `parameter '<name>' without a type annotation`. |

For a **return** position the span handed to the oracle is the function/method
*signature* node (or, equivalently, the inferred return type read via the checker's
signature-return API on the fn node). The oracle already maps oxc spans → tsc nodes
by `[start,end]`; a fn/method declaration span aligns. Recommended: resolve the tsc
signature at the fn node and take `checker.getReturnTypeOfSignature(sig)` rather
than hunting a `return` expression, so a multi-return or implicit-`undefined`
function infers the joined return `tsc` computes (which then re-validates: a
`T | undefined` join → `option`, a wide join → null → fail-loud).

## 4. Numeric-intent subtlety

Annotations currently anchor `usize` vs `i64` vs `f64`: `lowerType` maps `number`
→ `f64`, and `numeric.ts` **later** refines an `f64` to `usize` (array-index flow)
or `i64` (integer switch discriminant). The annotation only ever produces `f64`;
the refinement is a downstream pass over the whole HIR.

**Inference must enter the identical way.** `rustTypeOf` already maps an inferred
`number` (value position) → `{kind:"f64"}` (`type-oracle.ts:125`, `asKey=false`).
So an inferred binding/return `number` produces exactly the same `f64` an annotated
`: number` would, and `numeric.ts` refines it identically. **An inferred index
counter still becomes `usize`** because the refinement keys on *use* (the
index/`++`/`.get` flow), not on the annotation's provenance — the provenance is
gone by the time `numeric.ts` runs.

**Risk / call-outs:**

- The re-validation must hand `numeric.ts` an `f64`, never a pre-refined `usize`.
  `rustTypeOf` with `asKey=false` guarantees `f64` — do **not** pass `asKey=true`
  for a value binding/return (that path is for Map/Set keys only). The gate calls
  the value-position form.
- One genuine edge: `numeric.ts`'s inter-procedural rule (`dialect.md:951`) already
  fails loud when a non-literal is passed to a `usize`/`i64` param. Inference does
  not change that boundary — it only affects *binding/return* types, which are the
  positions `numeric.ts` refines locally. No new numeric conflict is introduced; an
  inferred `number` is strictly a superset-free substitute for an annotated one.
- A `.length` (`usize`) flowing into an inferred binding: today `const n =
  s.length` would need annotation; with inference the oracle sees `number` → `f64`,
  and the *existing* `usize`-in-`f64`-binary residual (`dialect.md:948`,
  098 specs note) applies unchanged. Inference does not widen or fix that
  pre-existing gap; it's the same fail-loud it is for annotated code.

## 5. Tradeoffs & residuals

- **Perf** — the lib load (tens of ms) is paid **only** by modules that actually
  have an un-annotated binding/return and reach inference. Fully-annotated modules
  keep the ~1 ms `noLib` path untouched (lazy build). The lib program is built once
  per compile and cached across all inference queries in that compile.
- **The forcing-function argument** — the mandatory-annotation rule kept the
  accepted surface narrow *by construction* (you couldn't accidentally feed the
  compiler a tuple/anon-object because you had to write the type, and the type
  checker rejected the un-modeled annotation). Relaxing it moves that guarantee to
  the **re-validation gate** (§2): an inferred out-of-surface type is rejected
  exactly as loudly as a missing annotation was. The narrowness is preserved; only
  the *ergonomics* change (you may omit the annotation when the type is both
  inferable and modeled). This is the whole point of the series and the reason the
  gate's fail-loud list must be exhaustive and reviewed.
- **Explicit fail-loud residual list** (unchanged-loud after this series):
  - Un-annotated **parameter** → `parameter '<name>' without a type annotation`
    (hard boundary, implicit-`any`).
  - Un-annotated binding/return whose inferred type is **out of surface** (tuple,
    function type, anonymous object, wide union, `any`/`unknown`, `bigint`,
    `symbol`) → the site's existing throw (or a `DialectError` for `any`/`unknown`).
  - Un-annotated binding/return the oracle **can't resolve** (no source threaded →
    `typeOracle` null; or a span that finds no tsc node) → today's throw. No-source
    path is byte-for-byte today's behavior (082 guarantee).
  - The `usize`-in-`f64`-binary numeric residual — unchanged, inference-agnostic.
  - **class fields** with a non-literal initializer — recommended to stay loud this
    series (§7-C).

## 6. Impl decomposition (each spec-first)

1. **`inferredRustType` + lazy lib program.** `type-oracle.ts`: the lazy lib
   program/checker builder, the method, and the `rustTypeOf` extensions
   (`option`, `Promise`, explicit `any`/`unknown` rejection). Unit-ish specs via
   the differential oracle for the binding cases.
2. **Binding-site cut-over.** Wire `lower.ts:7681` gate. `INF` binding
   differentials + the out-of-surface fail-loud pins + the param regression.
3. **Return-site cut-over.** Wire the four return throw sites via
   `getReturnTypeOfSignature`. `INF` return differentials (fn + method).
4. *(optional / §7-C)* class-field non-literal initializer inference — its own
   increment if graduated.

## 7. Sub-decisions for Collin (recommended defaults)

- **A. Lib set.** Which `lib.*.d.ts` bundle to load. *Recommend:* pin the
  `es2022`-ish bundle matching the already-accepted built-in surface
  (`Object.entries`, `Array.prototype.at`, `.map`, template machinery) — explicit
  and deterministic, not the tsc default. Wider libs risk inferring types the
  dialect can't model (extra fail-loud noise, no benefit).
- **B. Wide (non-nullish) inferred unions.** *Recommend:* **stay fail-loud** —
  inferring an anonymous enum from a join is a guess; the user should annotate to
  name the union (093 enums are name-driven). Nullish unions (`T|undefined/null`)
  remain the sole modeled exception.
- **C. Class-field non-literal initializers.** *Recommend:* **defer** to a later
  series — the `Option`-wrapping / ctor-vs-initializer interaction (`lower.ts:8404`)
  needs its own care and is out of the "bindings + returns" decided scope.
- **D. Fold the by-construction binding exemptions into the gate.** The binding
  gate carries a long hand-maintained exemption list (`isObjectEntriesCall`,
  `isArrayFindCall`, `isStringAtCall`, …, `lower.ts:7684-7711`). *Recommend:* keep
  them as the fast pre-check this series (they short-circuit before the oracle), but
  note that once `inferredRustType` covers `Option`/`vec` shapes, several
  (`isArrayFindCall`, `isStringAtCall`) become *subsumed* and can be retired in a
  follow-up cleanup series — not now (avoids churn + regression risk mid-graduation).
- **E. Span for return inference.** *Recommend:* `getReturnTypeOfSignature` on the
  fn/method signature (robust to multi-return / implicit `undefined`) over
  span-matching a single `return` expression.
