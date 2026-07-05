/**
 * Library-free diff utilities used to render write/edit tool calls.
 * Kept here (pure, no React) so it is reusable and independently testable.
 */

export type DiffPart = { text: string; emph: boolean };

export type DiffRow = {
  type: "add" | "del" | "ctx";
  text: string;
  /** 1-based line number in the old file (set for del/ctx rows). */
  oldLine?: number;
  /** 1-based line number in the new file (set for add/ctx rows). */
  newLine?: number;
  /**
   * Word-level segments for paired del/add rows. When present, `emph` segments
   * are the intra-line changes and render as a second highlight layer.
   * Omitted for context rows and unpaired add/del rows.
   */
  parts?: DiffPart[];
};

type RawRow = { type: "add" | "del" | "ctx"; text: string };

/**
 * Myers' O((n+m)d) diff over two arrays (the same approach git uses).
 * Edit distance d is small for typical edits, so this stays fast and
 * low-memory even on large inputs.
 */
function diffArrays(a: string[], b: string[]): RawRow[] {
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

  const rows: RawRow[] = [];
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

/**
 * Line diff via Myers. Returns rows describing how to turn `oldText` into
 * `newText` line by line.
 */
export function computeLineDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  return diffArrays(a, b).map((r) => ({ type: r.type, text: r.text }));
}

/** Split a line into word / whitespace / punctuation tokens (kept as units). */
function tokenize(line: string): string[] {
  return line.match(/\s+|[^\s\w]+|\w+/g) ?? [];
}

/** Skip word-level diff for pathological lines to bound cost. */
const MAX_WORD_TOKENS = 400;

/**
 * Word-level diff between two lines. Returns segments for the old and new side;
 * `emph: true` marks the changed words. Returns null when nothing useful can
 * be highlighted (identical lines, or lines too long to diff cheaply).
 */
export function wordDiff(
  oldLine: string,
  newLine: string,
): { oldParts: DiffPart[]; newParts: DiffPart[] } | null {
  if (oldLine === newLine) return null;
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  if (a.length + b.length > MAX_WORD_TOKENS) return null;
  const rows = diffArrays(a, b);
  // If token diff says everything changed (no context), word-level emphasis
  // adds noise — fall back to whole-line highlight.
  const hasCtx = rows.some((r) => r.type === "ctx");
  if (!hasCtx) return null;
  const oldParts: DiffPart[] = [];
  const newParts: DiffPart[] = [];
  for (const r of rows) {
    if (r.type === "ctx") {
      oldParts.push({ text: r.text, emph: false });
      newParts.push({ text: r.text, emph: false });
    } else if (r.type === "del") {
      oldParts.push({ text: r.text, emph: true });
    } else {
      newParts.push({ text: r.text, emph: true });
    }
  }
  return { oldParts, newParts };
}

/**
 * Full diff: line-level changes with 1-based old/new line numbers and, where a
 * deleted line was replaced by an added one, word-level `parts` for the
 * intra-line changes.
 */
export function buildDiffRows(oldText: string, newText: string): DiffRow[] {
  const raw = diffArrays(oldText.split("\n"), newText.split("\n"));
  const rows: DiffRow[] = raw.map((r) => ({ type: r.type, text: r.text }));

  // Assign line numbers.
  let oldNo = 0;
  let newNo = 0;
  for (const r of rows) {
    if (r.type === "ctx") {
      r.oldLine = ++oldNo;
      r.newLine = ++newNo;
    } else if (r.type === "del") {
      r.oldLine = ++oldNo;
    } else {
      r.newLine = ++newNo;
    }
  }

  // Word-level emphasis: within each maximal run of changed rows, pair the del
  // sub-sequence with the add sub-sequence positionally and diff their words.
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type === "ctx") {
      i++;
      continue;
    }
    const start = i;
    while (i < rows.length && rows[i].type !== "ctx") i++;
    const end = i;
    const delIdx: number[] = [];
    const addIdx: number[] = [];
    for (let k = start; k < end; k++) {
      if (rows[k].type === "del") delIdx.push(k);
      else addIdx.push(k);
    }
    const pairs = Math.min(delIdx.length, addIdx.length);
    for (let p = 0; p < pairs; p++) {
      const w = wordDiff(rows[delIdx[p]].text, rows[addIdx[p]].text);
      if (!w) continue;
      rows[delIdx[p]].parts = w.oldParts;
      rows[addIdx[p]].parts = w.newParts;
    }
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
