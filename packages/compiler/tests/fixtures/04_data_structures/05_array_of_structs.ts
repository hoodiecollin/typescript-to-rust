interface Item {
  qty: number;
}
function totalQty(items: Array<Item>): number {
  let s: number = 0;
  for (let i = 0; i < items.length; i = i + 1) {
    s = s + items[i].qty;
  }
  return s;
}
const a: Item = { qty: 2 };
const b: Item = { qty: 3 };
console.log(totalQty([a, b]));
