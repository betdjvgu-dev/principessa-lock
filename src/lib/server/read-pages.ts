/** Continue through short pages too: PostgREST's configured row cap can be lower than requested. */
export async function readAllPages<T, E>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: E | null }>,
  pageSize = 200,
): Promise<{ data: T[]; error: E | null }> {
  const rows: T[] = [];
  for (;;) {
    const page = await fetchPage(rows.length, rows.length + pageSize - 1);
    if (page.error) return { data: [], error: page.error };
    if (!page.data?.length) return { data: rows, error: null };
    rows.push(...page.data);
  }
}

export function chunks<T>(values: T[], size = 200): T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, (i + 1) * size));
}
