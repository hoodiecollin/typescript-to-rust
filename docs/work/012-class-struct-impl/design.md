# 012 — Data structures: `class` → `struct` + `impl`

## Problem

Series 011 shipped `interface` → `struct`. A `class` is that struct **plus
behavior**: a constructor and methods (`06_classes/01_basic`, still `test.todo`):

```ts
class Counter {
  count: number;
  constructor(start: number) {
    this.count = start;
  }
  increment(): void {
    this.count = this.count + 1;
  }
}
```

Rust splits data from behavior: a `struct` for the fields and an `impl` block for
an associated constructor (`fn new`) and methods (`fn(&self)` / `fn(&mut self)`).
`this` becomes `self`; `new Counter(x)` becomes `Counter::new(x)`.

The target compiles and runs (verified with `rustc`):

```rust
struct Counter {
    count: f64,
}

impl Counter {
    fn new(start: f64) -> Counter {
        return Counter { count: start };
    }
    fn increment(&mut self) {
        self.count = self.count + 1.0;
    }
}
```

## Scope (decided 2026-07-02)

**In:** a class with field declarations, an explicit field-init constructor, and
methods; construction and field/method use through a binding.

- **Item.** `ClassDeclaration` → a new `HirClass` item
  (`{ name; fields; ctor; methods }`), emitted as a `struct Name { … }` **and** an
  `impl Name { … }`. `HirModule.items` broadens to `HirFn | HirStruct | HirClass`.
- **Fields.** `PropertyDefinition`s → struct fields (same as interface fields).
- **Constructor.** `constructor(params) { this.f = e; … }` → an associated
  `fn new(params) -> Name { return Name { f: e, … }; }`. The body must be a
  sequence of `this.<field> = <expr>;` assignments covering **all** fields (a
  Rust struct literal is total); anything else (logic, a missing/extra field)
  throws `UnsupportedError`. Constructor params are taken **by value** (moved into
  the fields).
- **Methods.** `MethodDefinition`s → `fn name(<self>, params) -> ret { body }`.
  The `self` receiver is `&mut self` when the body mutates `this` (assigns a
  `this.<field>` or calls a mutating method on `this`), else `&self`. `HirFn`
  gains an optional `recv` receiver (`ref` / `refMut`); a free function leaves it
  unset.
- **`this` / `new`.** `ThisExpression` → the `self` identifier (so `this.count`
  reuses the existing `field` node → `self.count`, and `this.count = …` the
  `assign` node). `new C(args)` → a `call` to `C::new`.
- **Receiver mutability.** Calling a `&mut self` method through a binding requires
  that binding be `mut`. The ownership analysis collects the module's
  self-mutating method names and marks a receiver `mut` when it calls one — so
  `const c = new Counter(1); c.increment();` lowers to `let mut c` (const→let,
  `mut` from use, as everywhere).

**Deferred — own later series (documented, not silently handled):**

- **Inheritance** (`extends` / `super` / `implements`) — rejected. Rust has no
  class inheritance; this needs a trait/composition strategy.
- **Implicit / non-trivial constructors** — no constructor, or a body beyond
  `this.f = e` field inits (branching, locals, calling other methods) — deferred;
  a general `new` needs field defaults or a builder.
- **Static members, getters/setters, private/accessibility, generics, decorators**
  — each its own concern.
- **Method-parameter borrows** — method params are taken by value (owned) for now;
  `&T` / `&mut T` inference for method params (as `analysis.ts` does for free
  functions) is a follow-up. Owned-`self` (consuming) methods are also deferred.
- **Cross-class same-named methods** — receiver-mutability is name-based across the
  module, so two classes with a same-named method of differing receiver could mark
  a binding `mut` unnecessarily (a Rust `unused_mut` warning, not an error). A
  binding-type-aware resolution is the sound follow-up.

**Out:** shared-mutable/aliased instances (the `Rc<RefCell>` fallback) — the
dialect keeps instances owned.

## Design

### AST (`ast.ts`)

Add (verified against real parser output): `ClassDeclaration`, `ClassBody`,
`PropertyDefinition`, `MethodDefinition`, `FunctionExpression`, `ThisExpression`,
`NewExpression`.

### HIR (`hir.ts`)

```ts
export interface HirFn { …; recv?: "ref" | "refMut"; }   // self receiver (methods)
export interface HirClass {
  kind: "class";
  name: string;
  fields: { name: string; ty: RustType }[];
  ctor: HirFn | null;   // associated `new`, no receiver
  methods: HirFn[];     // each with a `recv`
}
export type HirItem = HirFn | HirStruct | HirClass;
```

### Emitter (`emitter.ts`) — the shape (lands in the scaffold)

- `emitItem` gains a `class` case → `emitClass`: the `struct` (reusing
  `emitStruct`) then `impl Name {\n <indented ctor+methods>\n}`.
- `emitFn` prepends the receiver when `recv` is set (`&self` / `&mut self`).

### Lowering (`lower.ts`) — the gate

- Collect class names into `analysis.structs` (so `lowerType` resolves `Counter`)
  and self-mutating method names into `analysis.mutatingMethods`.
- `lower()` routes `ClassDeclaration` → `lowerClass`.
- `lowerClass` builds fields, `lowerConstructor` (field-init → struct literal),
  `lowerMethod` (receiver from body mutation; `this`→`self`).
- `lowerExpr`: `ThisExpression` → `{ kind: "ident", name: "self" }`;
  `NewExpression` → `{ kind: "call", callee: "<Class>::new", args }`.
- `mutableBindings` (`analysis.ts`) marks a receiver `mut` when it calls a method
  in `mutatingMethods`.

### Numeric / string passes

`refineNumerics` / `refineStrings` descend into a class's `ctor` and each `method`
(their param/body), skipping nothing.

## Limits (documented, not silently handled)

- **Explicit field-init constructor only**; no inheritance, statics, accessors,
  generics, decorators.
- **Constructor params moved in; method params moved in** (borrow inference for
  method params deferred).
- **Receiver-mutability is name-based** across the module (documented collision).

## Verification

- **Unit (cargo-free):** `tests/classes.test.ts` drives `emit(…)` — the
  `struct Counter { count: f64, }` + `impl Counter {` shape (CLS1), the
  `fn new(start: f64) -> Counter` returning a `Counter { count: start }` literal
  (CLS2), a `&mut self` method whose body is `self.count = self.count + 1.0;`
  (CLS3), `new C()` → `Counter::new(…)` and `this`→`self` (CLS4), and a
  non-class green control (CLS5).
- **Oracle (cargo-backed):** flip `06_classes/01_basic` to `SUPPORTED` (tier 1:
  COMPILES) and add a tier-2 differential — construct, `increment()` twice, print
  the field — asserting Rust stdout equals the TypeScript's (`3`).

## Workflow note

Full spec-first: docs → scaffold (HIR `HirClass` item + `recv` and the emitter
cases land; `lower.ts` keeps a `ClassDeclaration` seam throwing `UnsupportedError`
"class → struct/impl lowering pending", so the specs are RED) → **RED** → real
`lowerClass`/`lowerConstructor`/`lowerMethod` + `this`/`new` + receiver-mutability
to GREEN → archive. Inheritance, statics, accessors, implicit constructors, and
method-param borrows each get a **new** series.
