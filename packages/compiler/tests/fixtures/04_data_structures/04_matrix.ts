function sumAll(m: Array<Array<number>>): number {
  let s: number = 0;
  for (let i = 0; i < m.length; i = i + 1) {
    for (let j = 0; j < m[i].length; j = j + 1) {
      s = s + m[i][j];
    }
  }
  return s;
}
console.log(sumAll([[1, 2], [3, 4]]));
