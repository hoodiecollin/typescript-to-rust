async function fetchData(id: number): Promise<string> {
  const res: string = await doFetch(id);
  return res;
}
