/**
 * A work-queue churn exercising **front mutation** (`shift`/`unshift`) — the pattern
 * that lowers to a `VecDeque` (series 116/117, issues #78/#101). A deterministic LCG
 * drives a mix of back-enqueue (`push`), front-enqueue / priority-bump (`unshift`),
 * and front-dequeue (`shift`), then drains the tail. Front ops are O(1) on a `VecDeque`
 * (vs O(n) `Vec::remove(0)`/`insert(0, …)`) — the whole point of the promotion. The
 * folded checksum stays within f64's exact-integer range and is accumulated in the same
 * order everywhere, so all three runtimes (Node / Bun / TTR) agree byte-for-byte.
 */
export function run(): number {
  const queue: number[] = [];
  let seed: number = 123456789;
  let checksum: number = 0;
  const rounds: number = 2000000;
  for (let i: number = 0; i < rounds; i = i + 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const kind: number = seed % 4;
    if (kind === 0) {
      queue.push(seed % 100000); // enqueue at the back
    } else if (kind === 1) {
      queue.unshift(seed % 100000); // priority-bump to the front
    } else {
      const task: number = queue.shift() ?? 0; // dequeue from the front
      checksum = (checksum + task) % 1000000007;
    }
  }
  // Drain whatever is left so the checksum reflects every enqueued task.
  while (queue.length > 0) {
    const task: number = queue.shift() ?? 0;
    checksum = (checksum + task) % 1000000007;
  }
  return checksum;
}
