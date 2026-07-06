async function one(): Promise<number> {
  return 1;
}
async function two(): Promise<number> {
  return 2;
}
async function sum(): Promise<number> {
  const a: number = await one();
  const b: number = await two();
  return a + b;
}
const r: number = await sum();
console.log(r);
