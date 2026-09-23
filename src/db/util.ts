/** Small helpers shared across the data layer. */

/** SQLite has no uuid type; generate a short, sortable-enough id. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${time}${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Normalises a path for storage: forward slashes, no trailing slash. */
export function normalisePath(input: string): string {
  let p = input.trim().replace(/\\/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
}

/** Parses a JSON column defensively; returns fallback when absent or corrupt. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/** Trims to a maximum length, marking that truncation happened. */
export function limitText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
