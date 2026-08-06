/**
 * Specs for `throw` / propagation inside class methods & constructors
 * (series 023). Drives the public `emit(...)` entry and asserts the emitted
 * shape: a `Result`-wrapped method, a `Result`-wrapped constructor with an
 * `Ok`-wrapped struct return, `?`-propagation at a fallible method call and a
 * fallible `new`, and a non-throwing class staying unchanged. The cargo proof
 * lives in compiler.test.ts. IDs map to series 023.
 *
 * RED until the unified `analyzeFallible` fixpoint + fallible method/ctor
 * lowering land (throw-in-method currently hits the `lowerClass` rejection).
 * MT5 is a green control (non-throwing class → unchanged 012 behaviour).
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

const ACCOUNT = `class Account {
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
}`;

describe("errors: throw in class methods & constructors", () => {
  test("MT1 a throwing method wraps its return type in Result", () => {
    expect(compile(ACCOUNT)).toContain(
      "fn withdraw(&mut self, amount: f64) -> Result<(), String> {",
    );
  });

  test("MT2 a throwing constructor returns Result<Name,…> with an Ok-wrapped struct", () => {
    const rust = compile(ACCOUNT);
    expect(rust).toContain("fn new(initial: f64) -> Result<Account, String> {");
    expect(rust).toContain("return Ok(Account { balance: initial });");
  });

  test("MT3 a fallible method call (via this) propagates with `?`", () => {
    expect(compile(ACCOUNT)).toContain("self.withdraw(amount)?");
  });

  test("MT4 a fallible `new` at a use site propagates with `?`", () => {
    const rust = compile(
      `${ACCOUNT}\nconst a: Account = new Account(100);\na.pay(30);`,
    );
    expect(rust).toContain("Account::new(100.0)?");
    expect(rust).toContain("a.pay(30.0)?");
    expect(rust).toContain("fn main() -> Result<(), String> {");
  });

  test("MT5 (compat control) a non-throwing class emits unchanged", () => {
    const rust = compile(`class Counter {
  count: number;
  constructor(start: number) {
    this.count = start;
  }
  increment(): void {
    this.count = this.count + 1;
  }
}`);
    expect(rust).toContain("fn new(start: f64) -> Counter {");
    expect(rust).toContain("fn increment(&mut self) {");
    expect(rust).not.toContain("Result");
    expect(rust).not.toContain("?");
  });
});
