export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function shouldRetry(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  const status = Number(/http (\d{3})/.exec(error.message)?.[1] ?? "");
  if (!Number.isFinite(status) || status === 0) return true;
  return isRetryableStatus(status);
}

export async function withBackoff<T>(
  work: () => Promise<T>,
  options?: { attempts?: number; baseMs?: number },
): Promise<T> {
  const attempts = Math.max(1, options?.attempts ?? 5);
  const baseMs = Math.max(0, options?.baseMs ?? 400);
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      last = error;
      if (!shouldRetry(error) || attempt === attempts - 1) break;
      const delay = baseMs * 2 ** attempt;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw last instanceof Error ? last : new Error("fetch failed");
}
