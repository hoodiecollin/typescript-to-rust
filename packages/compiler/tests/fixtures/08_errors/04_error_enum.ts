class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
  }
}

class ValidationError extends Error {
  field: string;
  constructor(message: string, field: string) {
    super(message);
    this.field = field;
  }
}

function lookup(id: number): number {
  if (id < 0) {
    throw new NotFoundError("no such id");
  }
  if (id === 0) {
    throw new ValidationError("bad id", "id");
  }
  if (id === 1) {
    throw new Error("reserved");
  }
  return id * 2;
}

function run(id: number): void {
  try {
    const x: number = lookup(id);
    console.log(x);
  } catch (e) {
    if (e instanceof NotFoundError) {
      console.log("not found");
    } else if (e instanceof ValidationError) {
      console.log(e.field);
    } else {
      console.log("other");
    }
  }
}

run(3);
