# 023 — Errors: `throw` / propagation inside class methods & constructors

## Problem

Series 013 analysed fallibility for **free functions + the script only**; a
`throw` (or a `?`-propagating call) inside a class method or constructor is
rejected fail-loud (`lowerClass`'s `hirHasThrowOrTry` guard). Real classes fail:

```ts
class Account {
  balance: number;
  constructor(initial: number) {
    if (initial < 0) {
      throw new Error("negative initial");
    }
    this.balance = initial;
  }
  withdraw(amount: number): void {
    if (amount > this.balance) {
      throw new Error("insufficient funds");
    }
    this.balance = this.balance - amount;
  }
  pay(amount: number): void {
    this.withdraw(amount);   // a fallible method calling a fallible method
    console.log("paid");
  }
}
```

Rust models exactly this with `Result` on the associated `fn`s and `?` at the
method/`new` call sites. Verified with `rustc`:

```rust
impl Account {
    fn new(initial: f64) -> Result<Account, String> {
        if initial < 0.0 { return Err("negative initial".to_string()); }
        return Ok(Account { balance: initial });
    }
    fn withdraw(&mut self, amount: f64) -> Result<(), String> {
        if amount > self.balance { return Err("insufficient funds".to_string()); }
        self.balance = self.balance - amount;
        return Ok(());
    }
    fn pay(&mut self, amount: f64) -> Result<(), String> {
        self.withdraw(amount)?;
        println!("paid");
        return Ok(());
    }
}
fn main() -> Result<(), String> {
    let mut a = Account::new(100.0)?;
    a.pay(30.0)?;
    println!("{}", a.balance);
    return Ok(());
}
```

## Scope (decided 2026-07-06)

**In:** extending fallibility from free functions to **methods and
constructors**, and `?`-propagating fallible **method calls** and fallible
**`new`**.

- **Unified fallibility fixpoint.** `analyzeFallible` grows from "free fns +
  script" to a fixpoint over **all** scopes: free fns, the script, each
  `Class.method`, and each class constructor (`Class` → its `new`). A scope is
  fallible iff it (own-level, `try`-shielded per series 021) `throw`s, **or**
  calls a fallible free function, **or** calls a fallible **method** (by name),
  **or** `new`s a class whose constructor is fallible. Because a method's
  fallibility feeds back into the fixpoint, method→method propagation
  (`this.withdraw()` making `pay` fallible) falls out for free.
- **Method fallibility is name-based** (like the existing `mutatingMethods`): a
  method name `M` is "fallible" iff *some* declared method named `M` is a fallible
  scope. A call `obj.M(args)` / `this.M(args)` where `M` is a known class-method
  name and is fallible → wrapped in `?`. (Names are matched against the universe
  of declared class methods, so `.push`/`.length`/`console.log` are never treated
  as fallible.) The cross-class same-name edge is a documented limit.
- **Fallible method emission.** `lowerMethod`: a fallible method wraps its return
  type in `Result<ret, E>` and runs `makeFallible` over its body (`return v` →
  `Ok(v)`, trailing `Ok(())` for `void`, `throw` → `Err`) — exactly what
  `lowerFunction` already does for free fns, now shared. The `&self`/`&mut self`
  receiver is unchanged.
- **Fallible constructor emission.** `lowerConstructor`: a fallible ctor returns
  `Result<Name, E>`; its synthesised trailing struct return becomes `Ok(Name {
  … })` and any `throw` in the body stays `Err`. The body may now interleave
  `throw`/`if (…) throw …` before the `this.<field> = …` assignments (still
  required to cover exactly the declared fields on the success path).
- **`?` at call sites.** `lowerCall`'s method branch wraps `obj.M(args)` in `try`
  when `M` is a fallible method name; `lowerNew` wraps `C::new(args)` in `try`
  when `C`'s constructor is fallible. The unified fixpoint guarantees the
  enclosing scope is itself fallible (its `Result` return makes `?` well-typed) —
  the same invariant series 013 relies on for free calls.
- **`E` is the program error type** (`String`, or `Box<dyn Error>` when series 022
  applies) — shared with free functions so `?` composes uniformly.

**Deferred — own later series (documented, not silently handled):**

- **Cross-class same-name methods** — name-based fallibility means two classes
  with a method `M`, one fallible and one not, both treat `.M()` as fallible (an
  extra `?` in a `Result` context; at worst a type error the cargo oracle
  catches). Precise per-receiver-type resolution needs real method-type
  inference — a later series (mirrors the `mutatingMethods` name-based limit).
- **`try`/`catch` inside a method** — composes with series 021 but is not
  exercised here; the interaction (shielding within a method scope) is its own
  slice.
- **A fallible method used as a first-class value / ignored `Result`** — every
  fallible method call is `?`-propagated, as with free calls.
- **Fallible getters/setters/static methods/`async` methods** — those method
  kinds remain rejected on their existing grounds.

**Out:** `panic!` in methods; poisoning/`Drop`-based cleanup.

## Design

### AST (`ast.ts`)

No new nodes — `MethodDefinition`/`ThrowStatement`/`NewExpression` already exist.

### Analysis (`analysis.ts`)

- `ModuleAnalysis` gains `fallibleMethods: Set<string>` (fallible method **names**)
  and `fallibleCtors: Set<string>` (class **names** whose ctor is fallible).
  `fallible` continues to hold free-fn + `SCRIPT_SCOPE` names.
- `analyzeFallible` is generalised. Collect, per scope (free fn, script,
  `Class.method`, `Class`-ctor): own-level `throws` (`try`-shielded), called
  **free-fn** names, called **method** names (property of a `CallExpression`
  callee, filtered to declared class-method names), and `new`ed class names.
  Fixpoint: `fallible(S)` if it throws, or calls a fallible free fn, or calls a
  method name that is fallible, or `new`s a class whose ctor scope is fallible.
  Derive `fallibleMethods` = `{ methodName(S) | S is a fallible Class.method }`
  and `fallibleCtors` = `{ Class | Class-ctor scope is fallible }`.

### HIR (`hir.ts`)

No new nodes. `HirFn` already carries `ret`/`recv`; a fallible method/ctor simply
has a `result` `ret` and an `Ok`/`Err`-wrapped body (existing nodes).

### Emitter (`emitter.ts`)

Unchanged — `emitFn` already renders a `self` receiver and a `Result` return; the
method/ctor `?`, `Ok`, and `throw` nodes all already emit.

### Lowering (`lower.ts`) — the gate

- Extract the free-fn fallible-wrap (`resultType(ret)` + `makeFallible(body,
  ret)`) into a shared helper and call it from `lowerMethod` and
  `lowerConstructor` when the scope is fallible.
- `lowerConstructor`: build the field-init body, then — if the ctor is fallible —
  wrap the synthesised struct return in `Ok` and `makeFallible` the rest; return
  type becomes `resultType(structTy)`.
- `lowerCall` (method branch): `analysis.fallibleMethods.has(name)` → wrap the
  `method` node in `{ kind: "try", expr }`.
- `lowerNew`: `analysis.fallibleCtors.has(className)` → wrap the `C::new` `call`
  in `{ kind: "try", expr }`.
- **Remove** the `hirHasThrowOrTry` rejection in `lowerClass` (the whole point of
  the slice). Keep it only for the still-unsupported method kinds if needed.

### Numeric / string passes

Unaffected structurally (methods/ctors already lowered as `HirFn`s the passes
descend into; the new `try` wrappers are existing nodes the passes already visit).

## Limits (documented, not silently handled)

- **Name-based method fallibility** — the cross-class same-name edge (see
  deferred) can over-`?`; the cargo oracle backstops it.
- **`E` shared program-wide** — a method and a free function must agree on `E`
  for `?` to compose (they do — the module error type).
- **No caught throws inside a method yet** — `try`/`catch`-in-method is series 021
  composition, not proven here.

## Verification

- **Unit (cargo-free):** `tests/method-throw.test.ts` drives `emit(…)` on the
  `Account` reference and asserts: a throwing method wraps its return in `Result`
  (MT1: `fn withdraw(&mut self, amount: f64) -> Result<(), String> {`); a throwing
  constructor returns `Result<Name, …>` with an `Ok`-wrapped struct
  (MT2: `fn new(initial: f64) -> Result<Account, String> {` and
  `return Ok(Account { balance: initial });`); a fallible method call propagates
  (MT3: `self.withdraw(amount)?`); a fallible `new` propagates (MT4:
  `Account::new(100.0)?`); and a green control — a **non-throwing** class — emits
  no `Result`/`?` (MT5, the 012-compat guard).
- **Oracle (cargo-backed):** add `08_errors/04_method_throw` (or `06_classes/02`)
  and flip it to `SUPPORTED` (COMPILES), plus a tier-2 differential on the success
  path (`new Account(100)`, `pay(30)` → prints `paid` / `70`) so both runtimes
  agree while the throwing branches stay untaken (proven to compile at tier 1).

## Workflow note

Spec-first: docs → scaffold (share the fallible-wrap helper as a seam that still
throws for methods/ctors — `UnsupportedError` "throw-in-method pending" — and add
the `fallibleMethods`/`fallibleCtors` analysis fields returning empty so specs are
**RED**) → **RED** → the unified `analyzeFallible` fixpoint, `lowerMethod`/
`lowerConstructor` fallible-wrap, and the method-call/`new` `?` to **GREEN** →
archive. Cross-class method-type resolution and `try`/`catch`-in-method each get a
**new** series.
