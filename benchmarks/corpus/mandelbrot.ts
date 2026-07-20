/**
 * Mandelbrot escape-time over a grid — dense f64 math, the shape where native
 * codegen and a warmed JIT are closest. Returns the summed iteration count.
 */
export function run(): number {
  const side: number = 400;
  const maxIter: number = 100;
  let total: number = 0;
  for (let py: number = 0; py < side; py = py + 1) {
    const y0: number = (py / side) * 2 - 1;
    for (let px: number = 0; px < side; px = px + 1) {
      const x0: number = (px / side) * 3 - 2;
      let x: number = 0;
      let y: number = 0;
      let iter: number = 0;
      while (iter < maxIter && x * x + y * y <= 4) {
        const xt: number = x * x - y * y + x0;
        y = 2 * x * y + y0;
        x = xt;
        iter = iter + 1;
      }
      total = total + iter;
    }
  }
  return total;
}
