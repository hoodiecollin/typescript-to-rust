/**
 * Recursive Fibonacci — call-heavy, exercises function-call overhead + integer
 * arithmetic with no allocation. `run()` returns a checksum so nothing is
 * dead-code-eliminated.
 */
function fib(n: number): number {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}

export function run(): number {
  let acc: number = 0;
  for (let i: number = 0; i < 5; i = i + 1) {
    acc = acc + fib(30);
  }
  return acc;
}
