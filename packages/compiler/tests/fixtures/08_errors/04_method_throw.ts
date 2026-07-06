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

const a: Account = new Account(100);
a.pay(30);
console.log(a.balance);
