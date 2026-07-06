function countEvens(): number {
  let i: number = 0;
  let evens: number = 0;
  while (i < 10) {
    if (i % 2 === 0) {
      evens = evens + 1;
    }
    i = i + 1;
  }
  return evens;
}
console.log(countEvens());
