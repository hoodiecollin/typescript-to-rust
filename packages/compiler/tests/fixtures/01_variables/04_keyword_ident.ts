interface Node {
  type: number;
}
function kind(n: Node): number {
  return n.type;
}
const box: Node = { type: 7 };
console.log(kind(box));
