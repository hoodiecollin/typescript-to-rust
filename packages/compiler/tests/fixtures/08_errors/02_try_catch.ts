function risky(n: number): void {
  if (n < 0) {
    throw new Error("negative");
  }
  console.log("ran");
}

function attempt(n: number): void {
  try {
    risky(n);
  } catch (e) {
    console.log("caught");
  } finally {
    console.log("done");
  }
}
