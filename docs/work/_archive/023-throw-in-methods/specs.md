# 023 — Specs

Unit specs drive the public `emit(...)` entry and assert the emitted shape of
throwing methods/constructors: a `Result`-wrapped method, a `Result`-wrapped
constructor with an `Ok`-wrapped struct return, `?`-propagation at a fallible
method call and at a fallible `new`, and a non-throwing class staying unchanged.
The cargo COMPILES/BEHAVES proof lives in the fixture + differential.

## Unit — throwing methods via `emit` (`tests/method-throw.test.ts`)

Reference program unless noted:
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
    this.withdraw(amount);
    console.log("paid");
  }
}
```

- **MT1** a throwing method wraps its return type in `Result`.
  emitted Rust contains `fn withdraw(&mut self, amount: f64) -> Result<(), String> {`.

- **MT2** a throwing constructor returns `Result<Name, …>` with an `Ok`-wrapped
  struct literal.
  emitted Rust contains `fn new(initial: f64) -> Result<Account, String> {` and
  `return Ok(Account { balance: initial });`.

- **MT3** a fallible method call (via `this`) propagates with `?`.
  emitted Rust contains `self.withdraw(amount)?`.

- **MT4** a fallible `new` at a use site propagates with `?`.
  program `+ \nconst a: Account = new Account(100);\na.pay(30);` → emitted Rust
  contains `Account::new(100.0)?` and `a.pay(30.0)?`, and `main` returns
  `Result<(), String>`.

- **MT5 (compat control)** a non-throwing class emits unchanged — no `Result`,
  no `?`.
  ```ts
  class Counter {
    count: number;
    constructor(start: number) { this.count = start; }
    increment(): void { this.count = this.count + 1; }
  }
  ```
  → contains `fn new(start: f64) -> Counter {` and `fn increment(&mut self) {`,
  and **not** `Result`, **not** `?`.

## Oracle — fixture + differential (`tests/compiler.test.ts`)

- **Tier 1 (COMPILES):** `08_errors/04_method_throw` moves into `SUPPORTED`; its
  emitted Rust (the `Result`-returning `new`/`withdraw`/`pay`, the `self.…()?` and
  `Account::new(…)?` propagation, and `main -> Result<(), String>`) must pass
  `cargo check`.
  ```ts
  class Account {
    balance: number;
    constructor(initial: number) {
      if (initial < 0) { throw new Error("negative initial"); }
      this.balance = initial;
    }
    withdraw(amount: number): void {
      if (amount > this.balance) { throw new Error("insufficient funds"); }
      this.balance = this.balance - amount;
    }
    pay(amount: number): void {
      this.withdraw(amount);
      console.log("paid");
    }
  }
  const a: Account = new Account(100);
  a.pay(30);
  console.log(a.balance);
  ```

- **Tier 2 (BEHAVES):** the success path (`new Account(100)`, `pay(30)`) → Rust
  stdout equals TS stdout (`paid\n70`). Exercises the fallible ctor's `Ok`-wrapped
  struct return, the `self.withdraw(amount)?` method→method propagation, the
  `Account::new(100)?` and `a.pay(30)?` use-site `?`, and `main -> Result` — while
  the throwing branches stay untaken so the runtimes agree.
