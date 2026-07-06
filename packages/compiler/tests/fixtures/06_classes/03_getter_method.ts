class Temp {
  celsius: number;
  constructor(c: number) {
    this.celsius = c;
  }
  fahrenheit(): number {
    return this.celsius * 9 / 5 + 32;
  }
}
const t: Temp = new Temp(100);
console.log(t.fahrenheit());
