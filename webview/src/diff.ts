/**
 * Library-free line diff utilities used to render write/edit tool calls.
 * Kept here (pure, no React) so it is reusable and independently testable.
 */

export type DiffRow = { type: "add" | "del" | "ctx"; text: string };

/**
 * Classic LCS line diff. Returns rows describing how to turn `oldText` into
 * `newText` line by line. Runs in O(n*m) time and space — fine for tool inputs
 * (old/new string snippets), not for whole-file dumps.
 */
export function computeLineDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", text: a[i] });
      i++;
    } else {
      rows.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    rows.push({ type: "del", text: a[i] });
    i++;
  }
  while (j < m) {
    rows.push({ type: "add", text: b[j] });
    j++;
  }
  return rows;
}

export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** opencode tools use `filePath`; some MCP tools use snake_case variants. */
export function extractFilePath(input: { [key: string]: unknown }): string | undefined {
  return asString(input.filePath) ?? asString(input.file_path) ?? asString(input.path);
}
