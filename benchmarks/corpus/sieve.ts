/**
 * Sieve of Eratosthenes — array allocation + index-heavy inner loops. The
 * index loops bound against `sieve.length` (a `usize`) so the emitted Rust index
 * variables and their bounds agree in type. Returns the count of primes below the
 * bound as the checksum.
 */
export function run(): number {
  const sieve: boolean[] = [];
  for (let i: number = 0; i < 200000; i = i + 1) {
    sieve.push(true);
  }
  let count: number = 0;
  for (let p: number = 2; p < sieve.length; p = p + 1) {
    if (sieve[p]) {
      count = count + 1;
      for (let m: number = p * 2; m < sieve.length; m = m + p) {
        sieve[m] = false;
      }
    }
  }
  return count;
}
