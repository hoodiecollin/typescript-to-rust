function sum(): number {
  let total: number = 0;
  for (let i: number = 0; i < 5; i = i + 1) {
    total = total + i;
  }
  return total;
}
