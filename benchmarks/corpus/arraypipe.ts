/**
 * Array map/filter/reduce pipeline — allocation + closure-call heavy. Builds a
 * vector, transforms it, and folds to a checksum.
 */
export function run(): number {
  const n: number = 500000;
  const xs: number[] = [];
  for (let i: number = 0; i < n; i = i + 1) {
    xs.push(i);
  }
  const doubled: number[] = xs.map((v: number): number => v * 2 + 1);
  const kept: number[] = doubled.filter((v: number): boolean => v % 5 !== 0);
  const total: number = kept.reduce((a: number, b: number): number => a + b, 0);
  return total;
}
