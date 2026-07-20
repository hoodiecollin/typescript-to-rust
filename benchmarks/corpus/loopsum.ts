/**
 * Tight numeric loop — a warmed JIT should do very well here; measures raw
 * arithmetic + branch throughput with no allocation. Mixes a modulo branch so
 * it is not trivially strength-reduced to a closed form.
 */
export function run(): number {
  let acc: number = 0;
  for (let i: number = 0; i < 5000000; i = i + 1) {
    if (i % 3 === 0) {
      acc = acc + i;
    } else {
      acc = acc - 1;
    }
  }
  return acc;
}
