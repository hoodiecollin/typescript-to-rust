function sumArray(arr: Array<number>): number {
  let total: number = 0;
  for (const val of arr) {
    total = total + val;
  }
  return total;
}
