# 017 — Generalize `throw`: built-in Error subclasses + string-literal throws

## Problem

Series 013 shipped `throw` → `Err`, but `lowerThrow` accepts exactly one shape:
`throw new Error(<message>)`. Real TypeScript also throws the standard **Error
subclasses** (`throw new TypeError("…")`, `RangeError`, …) and, occasionally, a
**bare string** (`throw "boom"`). Both carry a `String` message, and this
project's error type is uniformly `String`, so both map cleanly to
`Err(<message>)` — the same `throw` HIR node, no new machinery. This slice widens
the accepted throw surface to those two forms.

## Scope (decided 2026-07-02)

**In** (both lower to the existing `throw` HIR node → `return Err(<String>);`):

- **`throw new <ErrorClass>(message)`** for the standard built-in constructors —
  `Error`, `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`,
  `EvalError`, `URIError`. All take the message as their first argument; the class
  distinction is erased (E is uniformly `String`, as documented). Still exactly
  **one** argument.
- **`throw "<string literal>"`** — the literal *is* the message:
  `Err("boom".to_string())`.

The fallibility analysis is unchanged: `bodyThrows` already flags **any**
`ThrowStatement`, so a function throwing a `TypeError` or a string is already
marked fallible (`Result` return, `Ok`/`Err` bodies) — only `lowerThrow`'s
acceptance widens.

**Deferred — fail-loud, each a later series:**

- **`throw <variable>` / any non-literal value** — `throw n`, `throw err` — sound
  only if the value's type is `String`, which needs type tracking this project
  does not yet have. Rejected (a `number`/object throw would mistype `Err`).
- **`throw new Error(msg, options)`** (a `cause`/2-arg throw) — still requires
  exactly one message argument.
- **A non-built-in / user error class** (`throw new MyError(...)`) — custom error
  types are their own series (an error enum / `Box<dyn Error>`); erasing them to a
  `String` message would be a silent lie. Rejected.
- **`throw new AggregateError(...)`** — its constructor takes an iterable of
  errors, not a single message; out of scope.

## Design

No AST, HIR, emitter, or analysis **shape** change — one function, `lowerThrow`
in `lower.ts`, gains two accepted forms:

1. A module-level `ERROR_CLASSES` set of the seven built-in single-message
   constructors. The `NewExpression` branch checks membership instead of the bare
   `name === "Error"`, keeping the exactly-one-argument rule; the message lowers
   as before (`{ kind: "throw", value: lowerExpr(message) }`).
2. A new branch: a string-`Literal` argument lowers directly
   (`{ kind: "throw", value: lowerExpr(arg) }` → `Err("…".to_string())`).
3. Everything else stays fail-loud (`throw of a non-Error, non-string-literal
   value`).

## Limits (documented, not silently handled)

- **The Error class is erased to a `String` message.** `TypeError`/`RangeError`/…
  are indistinguishable from `Error` in the emitted `Result<_, String>` — the
  documented uniform-`String` error model; custom error types are a later series.
- **Only a string *literal* throws bare** — a thrown variable/expression is
  rejected until type tracking can confirm it is a `String`.

## Verification

- **Unit (cargo-free):** `tests/throw-values.test.ts` drives `emit(…)` — a
  `TypeError` throw → `Err(msg)` in a `Result` fn (THROWV1), a second subclass
  `RangeError` (THROWV2), a string-literal throw → `Err("boom".to_string())`
  (THROWV3), a plain `new Error` still working (THROWV4, green control), and three
  fail-loud rejections — a non-built-in class (THROWV5), a bare variable throw
  (THROWV6), and a two-argument `Error` (THROWV7).
- **Oracle (cargo-backed):** a tier-2 differential in `compiler.test.ts` — a
  function whose untaken branches throw a `RangeError` and a bare string, returning
  on the success path — asserts Rust stdout equals the TypeScript's, exercising
  both new throw forms in a compiling `Result` program.

## Workflow note

No scaffold commit: no HIR/emitter/AST shape is added, and `lowerThrow`'s existing
non-`Error` rejection already *is* the fail-loud seam the specs are RED against.
Flow: docs → **RED** → **GREEN** (widen `lowerThrow`) → archive. Custom error
types, `cause`/multi-arg throws, and thrown variables each remain their own series.
