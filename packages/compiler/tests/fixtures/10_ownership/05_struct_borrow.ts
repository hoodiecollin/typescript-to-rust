interface Bag {
  v: number;
}
function readBag(b: Bag): number {
  return b.v;
}
const bag: Bag = { v: 42 };
console.log(readBag(bag));
