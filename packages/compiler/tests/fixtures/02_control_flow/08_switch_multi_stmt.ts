function describe(x: number): string {
  let label: string = "";
  switch (x) {
    case 1:
      label = "one";
      return label;
    case 2:
      label = "two";
      return label;
    default:
      return "other";
  }
}
console.log(describe(2));
