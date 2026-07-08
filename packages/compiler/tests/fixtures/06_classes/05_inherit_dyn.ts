class Animal {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  speak(): string {
    return "...";
  }
}
class Dog extends Animal {
  constructor(name: string) {
    super(name);
  }
  speak(): string {
    return "woof";
  }
}
class Cat extends Animal {
  constructor(name: string) {
    super(name);
  }
  speak(): string {
    return "meow";
  }
}
const zoo: Array<Animal> = [new Dog("Rex"), new Cat("Tom")];
for (const a of zoo) {
  console.log(a.name);
  console.log(a.speak());
}
