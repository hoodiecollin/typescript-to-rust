# 070 — Implicit / non-field-init constructors

> **Status: DESIGN COMPLETE (2026-07-10). Impl BLOCKED on series 066 / issue #42**
> (the `undefined` model an uninitialized field resolves to). Graduates the 060
> constructor deferral, issue **#36**. Dialect calls made with Collin 2026-07-10
> (`needs-user-input` cleared). Generics were split to **#40**.
>
> Spec-first: this `design.md` → mock → RED `specs.md` → impl → archive.

## Problem

`lowerClass` (`lower.ts:2285`) turns a class into a `struct` + `impl` where the
constructor becomes an associated `new`. A class **without an explicit field-initializing
constructor** stays fail-loud (`lower.ts:2281`). Two gaps:

- A class with **no constructor** at all.
- A constructor that does **not directly initialize every field** (partial init).

Also, **field initializers** (`class C { x = 5 }`) are currently *dropped* — `fields.map`
(`lower.ts:2336`) reads only `name` + type from each `PropertyDefinition`, ignoring
`f.value`. So even an explicit default isn't used at construction today.

## Scope (decided 2026-07-10)

Graduate implicit / non-field-init constructors to a valid `struct` + `new`:

- **No constructor** → synthesize `new(..)` from the field initializers.
- **Partial constructor** → fields the ctor doesn't assign fall back to their initializer,
  else to absence.
- **Field initializers** (`x = 5`) become the synthesized construction defaults.

Generics (`class Box<T>`) are **not** here → **#40**. `protected` and decorators remain
permanent by-design rejections.

## Decision — an uninitialized field is `Option<T>`/`None` (via 066)

A field with **neither a field initializer nor a constructor assignment** has no honest
value. The dialect has no `undefined`… until series **066** lands it. Per the 2026-07-10
call, rather than fail-loud on such a field, **#36 waits on #42/066** and models it as
`Option<T>`, initialized `None` at construction — exactly 066's absence model. This is
why 070 is impl-blocked on 066.

| Field | Construction value |
| --- | --- |
| has initializer `x = 5` | the initializer (`5.0`) |
| assigned in ctor `this.x = x` | from the ctor param (existing 060 path) |
| neither | `Option<T>` field, initialized `None` (066) |

## Mechanism

- **`lowerClass`** — replace the missing/partial-ctor fail-loud with synthesis:
  1. Collect fields (existing) **plus their initializers** — extend the `fields.map` at
     `lower.ts:2336` to capture `f.value` (lowered) when present.
  2. Determine each field's construction source: ctor-assigned (existing param map),
     initializer, or neither → `Option<T>`/`None`.
  3. Synthesize `new(..)`: params are the ctor's (or none), and the returned struct
     literal fills every field from its determined source.
- **Uninitialized fields** reuse 066's `Option<T>` lowering (type → `Option<lower(T)>`,
  init `None`, reads require narrowing per 066). Construction sets them `None`.
- Existing field-init constructors (the 060 happy path) are unchanged.

## Fail-loud residuals

- **Generics** — `class Box<T>` → **#40** (unchanged rejection here).
- **`protected` members, decorators** — permanent.
- **Computed constructor init / reordered / defaulted-in-ctor** beyond the three sources
  above — as today, until a later series.

## Impl sequence (after 066 lands)

1. Capture field initializers (`f.value`) in `lowerClass`.
2. Per-field construction-source resolution (ctor-assigned / initializer / `None`).
3. Synthesize `new(..)` for missing/partial constructors.
4. Uninitialized fields → 066 `Option<T>`/`None`.
5. RED `specs.md` → GREEN (differential).

## Specs sketch

- `class A { x = 5 }` (no ctor) → `impl A { fn new() -> A { A { x: 5.0 } } }`.
- `class B { constructor() {} }` (no fields) → `fn new() -> B { B {} }`.
- `class P { x: number; constructor(x: number){ this.x = x } y = 0 }` (partial: `y` from
  initializer) → `new(x)` fills `x` from param, `y` from `0`.
- `class C { x: number }` (no init, no ctor assignment) → `x: Option<f64>`, `new()` sets
  `x: None`; a read requires narrowing (066).

## Open sub-details (impl, not dialect forks)

- Initializer expressions that reference other fields / `this` — support order or fail-loud.
- Whether a synthesized `new()` with zero params collides with a user `static new`.
- Numeric-pass typing of an initializer literal (`x = 5` → `f64`) — reuse the numeric pass.
