class Animal {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  speak(): string {
    return "...";
  }
  describe(): string {
    return this.name;
  }
}
class Dog extends Animal {
  breed: string;
  constructor(name: string, breed: string) {
    super(name);
    this.breed = breed;
  }
  speak(): string {
    return "woof";
  }
}
const a: Animal = new Animal("generic");
const d: Dog = new Dog("Rex", "Lab");
console.log(a.speak());
console.log(d.speak());
console.log(d.describe());
