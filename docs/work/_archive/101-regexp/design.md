# 101 — RegExp (Tier-3): graduate `/…/` and `RegExp` onto the Rust `regex` crate

## Decisions (DECIDED 2026-07-16)

The sub-decisions (previously "recommended defaults") are now **DECIDED** — the owner
accepted every recommended default. The § sections below are retained as rationale.

- **RE-PORT — runtime-variable `RegExp` pattern: DECIDED = Option A, fail-loud.** Never
  emit an un-vetted pattern; a `new RegExp(non-literal)` is rejected with
  `UnsupportedError` pointing the user to inline the pattern as a literal so it can be
  validated against the Rust `regex` engine (rejecting backrefs/lookaround at transpile
  time). Compile-through-with-runtime-panic (B) is explicitly rejected.
- **RE-STATE — stateful `g` / `lastIndex` / `exec`-loop: DECIDED = Option A, stateless
  value.** Model the regex as an immutable value; support the non-stateful uses fully
  (`re.test`, `s.match(/…/g)`, `s.matchAll`, `replace`/`split`, single non-looped
  `re.exec`); **fail-loud** the stateful `exec`-loop and any `re.lastIndex` read/write,
  redirecting to `s.matchAll(re)`. The `RefCell` stateful newtype (B) is rejected for
  v1.
- **RE-FNREPL — function replacers in `.replace`: DECIDED = v1 fail-loud.** A function
  replacer `(m, g1) => …` is rejected with `UnsupportedError`; string-template
  replacers ship first (closure-`Replacer` plumbing is a later graduation).
- **Transpile-time literal-pattern validation + JS→Rust translation: DECIDED** — a
  statically-known pattern is translated and validated at transpile time (reject
  backref/lookaround naming the construct; rewrite flags to an `(?ims)` prefix; leave
  the faithful core untouched).
- **Minor (`\d`/`\w` unicode, capturing-group split): DECIDED = accept-and-document**
  both as faithful divergences (not fail-loud).

## Status

Design. Graduates the umbrella Tier-3 residual (GitHub issue #56): the regex
literal (`/pat/flags`), `new RegExp(...)`, the regex-taking string methods
(`match`/`matchAll`/`search`/`replace`/`replaceAll`/`split`), and the regex
object methods (`test`/`exec`). **Needs Collin's input** on the sub-decisions
flagged below before impl (dialect-shape + memory-model surface — see the
process rule in `CLAUDE.md`).

## Not greenfield — a deferral-graduation

Today RegExp is fail-loud in three shapes:

1. **The regex literal** `/pat/flags` is a `Literal` node carrying a `.regex`
   field. It is **not** in `validate.ts`'s `MODELED` allowlist as a regex — the
   `Literal` type *is* modeled, but lowering rejects a non-scalar literal value
   with the dialect Literals-table residual `literal <typeof>` (bigint / symbol /
   **regex**), per `docs/dialect.md` § Literals.
2. **`new RegExp(...)`** falls through the generic `new` path to a cargo-loud
   failure (no `RegExp` type modeled).
3. **String methods** `.match` / `.matchAll` / `.search` are clean
   *transpiler* fail-louds in `lower.ts`'s `STRING_METHOD_DEFERRED` map
   (~line 7111-7120): `` "`.match` needs RegExp (deferred, Tier 3)" `` etc.
   `.replace`/`.replaceAll`/`.split` are already modeled **for string
   arguments** (083/098) and today mis-route or reject a regex argument.

So — like 097/098 — this series **graduates fail-loud residuals** onto a real
backend (the `regex` crate), it does not invent a new surface.

## Backend: the Rust `regex` crate

The `regex` crate is the standard, well-audited Rust engine. It is **not**
PCRE — it is a finite-automaton engine with linear-time guarantees, and it
**deliberately omits backreferences and lookaround**. That omission is the
single most important fact of this design: a large, well-defined slice of JS
regex is faithfully translatable, and the rest must fail loud (never
mistranslate). See § Fail-loud residual.

### Cargo dependency

Add `regex = "1"` to `packages/compiler/rust-oracle/Cargo.toml` (the harness
oracle crate) and to `crates/tslib/Cargo.toml` (the `tslib::regex` helper
module lives there). Follow the existing "present-but-unused costs nothing at
check time" convention already used for `tokio`/`serde`/`thiserror`.

> **First-run flake note (cargo dep thundering herd).** Per the memory note
> `cargo-dep-thundering-herd`, adding a new crate to the oracle `Cargo.toml`
> triggers a one-time burst of transient differential failures on the first run
> while the offline cache warms (the harness fetches `regex` + its deps
> `aho-corasick`, `memchr`, `regex-syntax` online on a cold cache). **Re-run the
> suite once to confirm green** before treating any failure as real. Pin
> `regex = "1"` so the warm offline cache stays stable.

## The accepted surface

### 1. Regex literal & construction

| TS | Rust target |
|---|---|
| `/pat/flags` (literal) | `tslib::regex::Regex::new_lit("(?flags)pat")` — a `tslib::regex::Regex` newtype wrapping `regex::Regex`, **built once** (see § lastIndex for the `g`/stateful wrinkle). Pattern is JS→Rust-translated **at transpile time** (literal is statically known). |
| `new RegExp(pat, flags)` — **string-literal `pat`** | Same as the literal: translate at transpile time. |
| `new RegExp(runtimeVar, flags)` — **non-literal `pat`** | **Fail-loud by default** (see § Pattern portability, sub-decision RE-PORT). |

The `tslib::regex::Regex` newtype (not bare `regex::Regex`) gives us one place
to (a) carry the JS flag semantics we can't express purely in the pattern
prefix (`g`/`y` statefulness), and (b) present a JS-shaped method surface
(`test`/`exec` returning JS-shaped results).

### 2. Flags

Each JS flag maps to a `regex` inline-flag prefix on the compiled pattern, or to
newtype-level state, or is fail-loud:

| JS flag | Meaning | Mapping |
|---|---|---|
| `i` | case-insensitive | `(?i)` prefix — **faithful** |
| `m` | `^`/`$` match line boundaries | `(?m)` prefix — **faithful** |
| `s` | `.` matches newline (dotAll) | `(?s)` prefix — **faithful** |
| `g` | global (match-all / stateful `.exec` loop) | **not a pattern flag** — affects *which method* runs (`find` vs `find_iter`, `replace` vs `replace_all`) and the stateful `.exec`/`lastIndex` loop. Carried on the newtype. |
| `u` | unicode | Rust `regex` is **unicode by default** — `u` is a no-op accept (documented divergence, see § Divergences: `\d`/`\w`). |
| `y` | sticky (anchored at `lastIndex`) | **Fail-loud** (`UnsupportedError`) — sticky semantics + `lastIndex` mutation are not faithfully expressible without the stateful-object model, which we are *not* building in v1 (see sub-decision RE-STATE). |
| `d` | hasIndices (match `.indices`) | **Fail-loud** — the `d` indices surface is unmodeled. |

### 3. Regex-object methods

| TS | Rust target | Notes |
|---|---|---|
| `re.test(s)` | `re.is_match(&s)` → `bool` | faithful. **`g`/`y` caveat:** stateless in v1 (see RE-STATE). |
| `re.exec(s)` | `re.exec(&s)` → `Option<Vec<Option<String>>>`-shaped match (JS `RegExpExecArray \| null`) | faithful for a single (first) match; the **stateful loop form** (`while ((m = re.exec(s)))` advancing `lastIndex`) is the crux — see § lastIndex. |

### 4. String methods taking a regex

| TS | Rust target (via `regex` crate) | Notes |
|---|---|---|
| `s.match(re)` (no `g`) | `re.captures(&s)` → `Option<Vec<Option<String>>>` (`[full, g1, g2, …] \| null`) | faithful |
| `s.match(re)` (`g` flag) | `re.find_iter(&s).map(...).collect()` → `Vec<String> \| null` | JS `g`-match returns full matches only (no groups) — faithful |
| `s.matchAll(re)` | `re.captures_iter(&s)` → iterator of capture arrays | faithful; requires `g` in JS (fail-loud if `g` absent, matching JS's TypeError) |
| `s.replace(re, repl)` | `re.replace(&s, repl')` (first) | `repl` template `$1`/`$<name>` → Rust `$1`/`${name}` (see § Replacement) |
| `s.replaceAll(re, repl)` / `s.replace(re/g, repl)` | `re.replace_all(&s, repl')` | JS requires the `g` flag on `replaceAll`'s regex (TypeError otherwise) — mirror it |
| `s.split(re)` | `re.split(&s).map(...).collect()` → `Vec<String>` | faithful; JS's capture-group-splitting quirk (splitting on `/(,)/` *includes* the captured separators) is a **documented divergence** (Rust `Regex::split` drops them) — see § Divergences |
| `s.search(re)` | `re.find(&s).map(\|m\| m.start() as f64).unwrap_or(-1.0)` | **char-index divergence**: `regex` returns *byte* offsets; JS returns UTF-16 code-unit offsets. tslib helper converts the byte offset to a **char** index (consistent with the 083/098 char-indexed string model). |

### 5. Capture groups

- **Numbered groups** `(…)` → `regex` numbered captures; `captures[n]` maps to JS
  match array index `n` (index 0 = whole match). A non-participating group is
  `None` → JS `undefined`, rendered through the shipped 066 Option model.
- **Named groups** `(?<name>…)` → `regex` uses **identical syntax** `(?<name>…)`
  (also accepts `(?P<name>…)`). Faithful; `captures.name("name")` backs
  `match.groups.name`.

### 6. Replacement templates

JS `String.replace` replacement specials, mapped to the `regex` crate's
`Replacer` string syntax:

| JS | Rust `regex` | Status |
|---|---|---|
| `$1`, `$2`, … | `$1`, `$2` / `${1}` | faithful (use `${1}` form in tslib to avoid greedy name-parsing) |
| `$<name>` | `${name}` | translate `$<name>` → `${name}` at transpile time |
| `$&` (whole match) | `$0` / `${0}` | translate `$&` → `${0}` |
| `` $` `` (before), `$'` (after) | no equivalent | **Fail-loud** (`UnsupportedError`) — `regex` has no before/after specials |
| `$$` (literal `$`) | `$$` | faithful |
| a **function** replacer `(m, g1) => …` | `regex`'s closure `Replacer` | **v1 fail-loud** (see sub-decision RE-FNREPL) — closure replacers need arg-shape plumbing; string-template replacers ship first |

Replacement-template translation runs **at transpile time** and can therefore
fail loud on `` $` ``/`$'` in a literal template.

## The crux — pattern portability

JS regex patterns are runtime strings; the `regex` crate validates patterns
(rejecting backrefs/lookaround) **at Rust-compile time / `Regex::new` time**.
Two questions: *when* do we validate, and *what do we do* with a runtime pattern.

### Transpile-time pattern translation & validation (literal patterns)

For a **statically-known** pattern (a regex literal, or `new RegExp("lit", …)`
with a string-literal first arg), the compiler runs a **JS→Rust pattern
translator** at transpile time that:

1. Rejects unsupported constructs with a clean `UnsupportedError` **naming the
   construct**: backreferences (`\1`, `\k<name>`), lookahead (`(?=…)`,
   `(?!…)`), lookbehind (`(?<=…)`, `(?<!…)`), sticky-only anchors, and any
   syntax `regex-syntax` can't parse.
2. Rewrites the flag set into an inline `(?ims)` prefix (§ Flags).
3. Leaves the (large) faithful core untouched: char classes, quantifiers,
   alternation, anchors, numbered + named groups, non-capturing groups
   `(?:…)`, word boundaries `\b`.

This is the point of maximum value: a literal backref/lookaround pattern fails
**at transpile time with a precise message**, never mistranslated.

### Runtime-variable patterns — sub-decision **RE-PORT** (needs Collin)

`new RegExp(runtimeVar)` cannot be validated at transpile time.

- **Option A — Fail-loud (recommended default).** Reject a non-literal
  `RegExp` pattern with `UnsupportedError`: *"a `RegExp` built from a non-literal
  pattern is not modeled — inline the pattern as a literal so it can be
  validated against the Rust `regex` engine."* Keeps the fail-loud guarantee
  absolute: we never emit a pattern we haven't checked for backref/lookaround.
- **Option B — Compile-through.** Emit `tslib::regex::Regex::new_dynamic(pat,
  flags)` that calls `regex::Regex::new` at runtime; a backref/lookaround
  pattern then **panics at runtime** (`.expect("invalid regex")`). Differential
  concern: JS `new RegExp` with lookahead *succeeds* (Bun supports it), so the
  differential would show Rust panicking where Bun runs — a **mistranslation
  signal caught by the oracle only if the test exercises it**, and worse, a
  *supported* dynamic pattern that Rust also supports would run fine, masking
  the risk. **Not recommended** — it leaks an un-vetted pattern past the
  fail-loud gate.

**Recommended default: Option A.** Ship literal-only patterns in v1; graduate
runtime patterns as a later series if a real fixture needs them.

## Stateful `g` / `lastIndex` — sub-decision **RE-STATE** (needs Collin)

This is the subtle part. A JS regex object with `g` (or `y`) is **stateful**:
`re.lastIndex` advances after each `re.exec(s)` / `re.test(s)`, so
`while ((m = re.exec(s)) !== null) { … }` iterates all matches, and a `g` regex
`re.test(s)` called twice can return different answers. The `regex` crate's
`Regex` is **immutable/stateless** — it has no `lastIndex`.

- **Option A — Stateless v1 (recommended default).** Model the regex as an
  **immutable value**. Support the *idiomatic, non-stateful* uses fully:
  `re.test(s)` (single check), `s.match(/…/g)`, `s.matchAll(/…/g)` (the modern
  replacement for the `exec` loop), `s.replace`/`split`. **Fail loud** on the
  two stateful shapes:
  - `re.exec(s)` used in a **loop** / where its result feeds `lastIndex`
    progression → `UnsupportedError`: *"stateful `RegExp.exec` loop is not
    modeled — use `s.matchAll(re)` (Tier-3 residual)."*
  - any read/write of `re.lastIndex` → `UnsupportedError`.

  A **single, non-looped** `re.exec(s)` (first match only) is faithful and
  ships. Detecting "used in a loop that advances lastIndex" is done
  conservatively: an `exec` call whose result is re-assigned in a `while`/`for`
  condition, or a `.lastIndex` access anywhere on the receiver, trips the
  fail-loud. This is a **static approximation** — see tradeoffs.

- **Option B — Stateful newtype.** Make `tslib::regex::Regex` a
  `RefCell<usize>`-carrying object tracking `lastIndex`, and lower `re.exec` to a
  method that reads/advances it. Faithful to the JS `exec` loop, but pulls in
  interior mutability (against the "Option A idiomatic borrows, `Rc<RefCell>` is
  a last resort" memory-model decision) and re-derails the ownership story for a
  legacy idiom that `matchAll` already replaces. **Not recommended for v1.**

**Recommended default: Option A** — stateless value, `matchAll` for iteration,
fail-loud on the `exec`-loop / `lastIndex` idiom.

## The `tslib::regex` helper shape

A new `crates/tslib/src/regex.rs` module (registered in `lib.rs`'s `pub mod`
list, fn-first per the codegen-helper-boundary note):

```rust
//! RegExp fidelity — JS-shaped wrappers over the `regex` crate.
pub struct Regex(pub regex::Regex, /* global: */ pub bool);

impl Regex {
    pub fn new_lit(pattern_with_flags: &str, global: bool) -> Regex { … }
    pub fn is_match(&self, s: &str) -> bool { … }
    /// First-match only; JS `RegExpExecArray | null` shape.
    pub fn exec(&self, s: &str) -> Option<Vec<Option<String>>> { … }
    pub fn captures(&self, s: &str) -> Option<Vec<Option<String>>> { … }
    pub fn find_all(&self, s: &str) -> Vec<String> { … }       // s.match(/…/g)
    pub fn captures_all(&self, s: &str) -> Vec<Vec<Option<String>>> { … } // matchAll
    pub fn replace_first(&self, s: &str, repl: &str) -> String { … }
    pub fn replace_all(&self, s: &str, repl: &str) -> String { … }
    pub fn split(&self, s: &str) -> Vec<String> { … }
    /// JS `s.search(re)` — **char** index of first match, -1 if none.
    pub fn search(&self, s: &str) -> f64 { … }
}
```

The helper owns the two fidelity chores the emitter must not open-code:
**byte→char offset conversion** (for `search`) and the **`RegExpExecArray`
shape** (`[full, g1, …]` with `None`→`undefined`). Numbered/named group
extraction and Option→`undefined` rendering ride the shipped 066 model.

## Divergences (faithful-but-documented, not fail-loud)

| Construct | JS | Rust `regex` | Decision |
|---|---|---|---|
| `\d` / `\w` / `\s` | ASCII-ish (`\d` = `[0-9]`, `\w` = `[A-Za-z0-9_]`) | **unicode-aware** (`\d` matches all Unicode digits) | **Documented divergence.** Faithful for ASCII input (the common case). A fixture over non-ASCII digits would diverge; note it in dialect.md. (Could pin `(?-u:\d)` to force ASCII — deferred sub-decision, not v1.) |
| `u` flag | opt-in unicode | default | no-op accept — documented |
| `s.split(/(sep)/)` capture-including split | JS *includes* captured separators in the result array | Rust `split` drops them | **Documented divergence**; a capturing split is uncommon. (Could fail-loud a capturing-group split specifically — flag as minor sub-decision.) |
| offsets (`search`, match index) | UTF-16 code units | bytes | tslib converts to **char** index (consistent with 083/098) — documented `char`-vs-UTF-16 edge, same as the rest of the string surface |

## Fail-loud residual (explicit — never mistranslated)

Clean `UnsupportedError` (or `DialectError` where truly forbidden), each with a
message naming the construct:

- **Backreferences** — `\1`, `\k<name>` (regex-crate has none).
- **Lookahead** — `(?=…)`, `(?!…)`.
- **Lookbehind** — `(?<=…)`, `(?<!…)`.
- **Sticky `y` flag** and **`d` (hasIndices) flag**.
- **`re.lastIndex`** read/write and the **stateful `exec` loop** (RE-STATE Opt A).
- **Runtime-variable `RegExp` pattern** (RE-PORT Opt A).
- **Function replacers** `s.replace(re, (m,…) => …)` (RE-FNREPL — v1).
- **Replacement specials** `` $` `` / `$'`.
- **`Symbol.replace` / `Symbol.match` / `Symbol.split`** custom protocol objects.
- Any pattern `regex-syntax` cannot parse.

## Sub-decisions left for Collin

1. **RE-PORT** — runtime-variable `RegExp` pattern: **fail-loud (A, recommended)**
   vs compile-through-with-runtime-panic (B).
2. **RE-STATE** — stateful `g`/`lastIndex`/`exec`-loop: **stateless value +
   fail-loud the loop, `matchAll` for iteration (A, recommended)** vs
   `RefCell` stateful newtype (B).
3. **RE-FNREPL** — function replacers in `.replace`: v1 **fail-loud (recommended)**
   vs ship closure-`Replacer` plumbing now.
4. **Minor** — `\d`/`\w` ASCII-pinning (`(?-u:…)`) vs accept-unicode-and-document;
   capturing-group split as divergence vs fail-loud. Recommend
   accept-and-document for both.

## Tradeoffs

- **Stateless v1 (RE-STATE A)** is a static approximation: an `exec` used in a
  loop is detected by control-flow shape, not by proving statefulness. A false
  positive (a single non-looped `exec` mis-flagged) is safe (fail-loud, not
  mistranslation); a false negative would mistranslate, so the detector must
  err toward fail-loud. `matchAll` covers the real need cleanly.
- **Literal-only patterns (RE-PORT A)** cover the overwhelming majority of real
  code; the fail-loud message points users to inline the literal so it gets
  validated — preserving "never emit an un-vetted pattern."
- **`\d`/`\w` unicode default** is the one silent-behavior-difference risk; it's
  the standard `regex`-crate caveat and only bites non-ASCII input. Documented,
  and pin-to-ASCII is a cheap follow-up if a fixture needs it.
