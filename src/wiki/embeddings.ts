/** Pull a matrix of embedding vectors out of a Workers AI response (binding or REST). */
export function readEmbeddingMatrix(payload: unknown): number[][] {
  const root = asRecord(payload);
  const nested = asRecord(root?.result);
  const data = nested?.data ?? root?.data;
  if (!Array.isArray(data) || data.length === 0) return [];
  if (data.every((value) => typeof value === "number")) return [data.filter((value): value is number => typeof value === "number")];
  const rows: number[][] = [];
  for (const row of data) {
    if (!Array.isArray(row)) continue;
    const numbers = row.filter((value): value is number => typeof value === "number");
    if (numbers.length > 0) rows.push(numbers);
  }
  return rows;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}
