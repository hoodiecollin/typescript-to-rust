function isPositive(n: number): boolean {
  return n > 0;
}
function label(n: number): string {
  if (isPositive(n)) {
    return "pos";
  }
  return "nonpos";
}
console.log(label(5));
