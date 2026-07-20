/**
 * Number-keyed histogram via `Map` — hashing + insert/update churn. Uses a
 * numeric key (a deterministic LCG bucketed into a fixed range) to avoid the
 * string-key borrow residual, so it exercises the `Map` path cleanly.
 */
export function run(): number {
  const buckets: number = 997;
  const counts: Map<number, number> = new Map<number, number>();
  let seed: number = 987654321;
  for (let i: number = 0; i < 1000000; i = i + 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const key: number = seed % buckets;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let total: number = 0;
  for (let k: number = 0; k < buckets; k = k + 1) {
    total = total + (counts.get(k) ?? 0);
  }
  return total;
}
