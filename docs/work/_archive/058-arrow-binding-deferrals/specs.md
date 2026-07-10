# 058 — Arrow binding deferrals · specs

Differential oracle: emitted Rust compiles **and** its run matches the TS run (via
Bun), plus emitted-text checks for the lifted shape and fail-loud `UnsupportedError`
/ cargo-reject checks for the residuals.

> **Impl note (placement).** The design proposed placing the lifted `fn` in the
> *nearest enclosing block*. The implementation hoists it to **module scope**
> instead (`fn __arrow_n`), reusing 048's proven hoist + refine pipeline. This is
> semantically identical — a nested `fn` cannot capture, so scope placement is
> observationally irrelevant — and it keeps every lifted fn on the normal
> numeric/ownership/string refine path. The binding still holds a `fn`-pointer.

## Behaves (differential-match JS)

1. **`let`-bound arrow** — `let f = (n: number): number => n + 1; f(2)` → a direct
   free `fn f` (top-level, non-reassigned); calls match.
2. **reassignment** — `let op = add; op = sub; op(5, 2)` → a `let mut op: fn(..)->..`
   fn-pointer binding; reassignment matches (`op` ends as `sub`).
3. **multiple declarators** — `const f = x => x+1, g = x => x*2;` splits per binding;
   both call correctly.
4. **destructuring param** — `const dist = ({x, y}: Point) => x*x + y*y` → `fn
   dist(Point { x, y }: Point)`; called with a `Point` binding, matches.
5. **local (nested-scope) arrow** — an arrow bound inside a fn body hoists to `fn
   __arrow_n` + a local `let f: fn(..)->.. = __arrow_n` pointer binding; matches.
6. **async** — `let load = async (): Promise<number> => 1; await load()` (top-level,
   non-reassigned) → a direct `async fn load`; matches.

## Emitted-shape checks

7. **fn-pointer binding** — the local/reassigned path emits `let [mut] name:
   fn(P…)->R = __arrow_n` and a top-level `fn __arrow_n`.
8. **direct promotion** — the top-level non-reassigned path emits `fn name(…)`
   (no `__arrow_` indirection).

## Fail-loud residuals

9. **rest param** — `(...xs: number[]) => …` is rejected (no Rust variadics; its own
   slice-convention series).
10. **capturing arrow** — an arrow that reads an outer binding is rejected: the
    direct/hoist path references an out-of-scope name → **cargo rejects** it
    (unchanged from 048; a nested `fn` cannot capture).
11. **anonymous-object destructured param** — `({x, y}: {x: number; y: number}) =>
    …` is rejected (no named struct to pattern against).
