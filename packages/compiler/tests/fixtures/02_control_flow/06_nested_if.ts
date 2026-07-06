function grade(x: number): string {
  if (x >= 90) {
    return "A";
  } else {
    if (x >= 80) {
      return "B";
    } else {
      return "C";
    }
  }
}
console.log(grade(85));
