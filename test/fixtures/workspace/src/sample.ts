export function add(a: number, b: number): number {
  return a + b;
}

export function total(values: number[]): number {
  return values.reduce((sum, value) => add(sum, value), 0);
}
