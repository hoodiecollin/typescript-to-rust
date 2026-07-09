# 055 — `await` of a non-future unwraps (finish #13)

Graduates the **second half of #13**. The first half (an un-awaited async call →
`tokio::spawn` → `JoinHandle`) shipped in series 051c. This half graduates the
remaining `await` residuals: awaiting something that is **not a future** — a sync
call, a plain value, a member access, a non-async method.

In JS, `await x` on a non-thenable simply yields `x` (on the next microtask
tick). There is no future to poll. Per the #13 DECISION (2026-07-08, "broad"),
the dialect now **drops the `await`** wherever the operand is not one of the
modeled futures and lowers the operand as an ordinary expression. Value semantics
are identical; the only thing JS's `await` adds on a non-thenable is a microtask
deferral, which is unobservable in the differential-stdout oracle for these
shapes.

## What stays a real `.await` (unchanged — these ARE futures)

`lowerAwait` peels the modeled futures off first, exactly as before:

| Awaited operand | Lowering | Series |
|---|---|---|
| `await h` where `h` is a spawned-task handle | `h.await.unwrap()` | 051c |
| `await sleep(ms)` | `sleep(Duration…).await` | 051b |
| `await Promise.all/race/x.then(…)` | join / try_join / select | 051a/b |
| `await obj.m(…)` where `m` is an **async** method | `obj.m(…).await` (+`?`) | 054a |
| `await asyncFn(…)` where `asyncFn` is a declared **async** fn | `asyncFn(…).await` (+`?`) | 07_async |

## What now drops the `await` (the graduation)

Everything reaching the tail of `lowerAwait` after those peels — i.e. the operand
is provably **not** a modeled future:

| Awaited operand | Before | After |
|---|---|---|
| `await syncFn(…)` (a declared non-async free fn) | `UnsupportedError` | `syncFn(…)` (fallible → `syncFn(…)?`) |
| `await obj.m(…)` (a non-async method) | `UnsupportedError` | `obj.m(…)` (fallible → `?`) |
| `await x` / `await obj.field` / `await <literal>` (a non-call) | `UnsupportedError` | the operand, lowered as-is |

The `?`-propagation for a fallible sync call is **already** applied by `lowerCall`
(`{kind:"try"}` at `lower.ts:3624` for free fns, `:3873` for methods) — so
"drop the await" is literally `return lowerExpr(arg, analysis)`; fallibility
threads through for free.

## HIR / analysis / emitter changes

**None.** No new HIR node, no new analysis field, no new emit case. The change is
three `throw` sites in `lowerAwait` becoming `return lowerExpr(arg, analysis)`.
Because the operand is lowered by the ordinary expression path, every downstream
pass (fallibility, ownership, numerics) sees a plain expression it already
handles.

## Impl plan

`packages/compiler/src/lower.ts`, `lowerAwait`:

1. Non-call operand (`arg.type !== "CallExpression"`, and not the already-peeled
   spawned-handle identifier) → `return lowerExpr(arg, analysis)` instead of the
   "await of a non-call expression" throw.
2. Member-callee, non-async method → `return lowerExpr(arg, analysis)` instead of
   the "await of a call to a non-async method" throw.
3. Identifier-callee (or any non-Identifier callee) that is not a declared async
   fn → `return lowerExpr(arg, analysis)` instead of the "await of a call to a
   non-async function" throw.

`docs/dialect.md` — flip the three `await`-residual rows from "Not yet" to
modeled (drop-await), leaving the async-fn/method/combinator rows unchanged.

## Fail-loud residuals (unchanged)

There is **no** new fail-loud residual introduced by this series. The genuine
async residuals (async generators → `Stream`, etc.) are unrelated and stay as
they were. `await` itself now has no fail-loud shape — every operand is either a
modeled future (real `.await`) or a non-future (drop). This closes #13.
