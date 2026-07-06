class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function lookup(id: number): number {
  if (id < 0) {
    throw new NotFoundError("no such id");
  }
  return id * 2;
}

const x: number = lookup(3);
console.log(x);
