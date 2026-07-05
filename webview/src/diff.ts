/**
 * Library-free line diff utilities used to render write/edit tool calls.
 * Kept here (pure, no React) so it is reusable and independently testable.
 */

export type DiffRow = { type: "add" | "del" | "ctx"; text: string };

/**
 * Line diff via Myers' O((n+m)d) algorithm (the same approach git uses).
 * Returns rows describing how to turn `oldText` into `newText` line by line.
 * Edit distance d is small for typical code edits, so this stays fast and
 * low-memory even on large files where the old LCS dp blew up.
 */
export function computeLineDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((text) => ({ type: "add" as const, text }));
  if (m === 0) return a.map((text) => ({ type: "del" as const, text }));

  const max = n + m;
  const offset = max;
  const size = 2 * max + 1;
  const v = new Int32Array(size).fill(-1);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];
  let d = 0;
  for (; d <= max; d++) {
    let done = false;
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        done = true;
        break;
      }
    }
    trace.push(v.slice());
    if (done) break;
  }

  const rows: DiffRow[] = [];
  let x = n;
  let y = m;
  for (let dd = d; dd > 0; dd--) {
    const vPrev = trace[dd - 1];
    const k = x - y;
    let prevK: number;
    if (k === -dd || (k !== dd && vPrev[offset + k - 1] < vPrev[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vPrev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      rows.push({ type: "ctx", text: a[x - 1] });
      x--;
      y--;
    }
    if (x > prevX) {
      rows.push({ type: "del", text: a[x - 1] });
      x--;
    } else if (y > prevY) {
      rows.push({ type: "add", text: b[y - 1] });
      y--;
    }
  }
  while (x > 0 && y > 0) {
    rows.push({ type: "ctx", text: a[x - 1] });
    x--;
    y--;
  }
  while (x > 0) {
    rows.push({ type: "del", text: a[x - 1] });
    x--;
  }
  while (y > 0) {
    rows.push({ type: "add", text: b[y - 1] });
    y--;
  }
  rows.reverse();
  return rows;
}

export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** opencode tools use `filePath`; some MCP tools use snake_case variants. */
export function extractFilePath(input: { [key: string]: unknown }): string | undefined {
  return asString(input.filePath) ?? asString(input.file_path) ?? asString(input.path);
}
