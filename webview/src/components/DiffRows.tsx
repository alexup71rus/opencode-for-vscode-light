import type { ReactNode } from "react";
import type { DiffRow } from "../diff";

interface DiffRowsProps {
  rows: DiffRow[];
  /** Optional per-segment transform (e.g. in-modal search match highlighting). */
  decorate?: (text: string) => ReactNode;
  /** Per-row ref callback (used for scroll-into-view by index). */
  rowRef?: (idx: number, el: HTMLDivElement | null) => void;
}

/**
 * Renders a unified diff as flex rows: [line number gutter] [sign] [code].
 * The gutter and sign are `user-select: none`, so dragging to select the code
 * copies only the code (clean selection). The code cell is the only part that
 * wraps (`white-space: pre-wrap`); the gutter stays aligned as a fixed column
 * even when a long line wraps to several visual rows.
 */
export function DiffRows({ rows, decorate, rowRef }: DiffRowsProps): React.ReactElement {
  return (
    <div className="diff-rows">
      {rows.map((row, idx) => {
        const sign = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
        const gutterNo = row.type === "del" ? row.oldLine : row.newLine;
        const code: ReactNode = row.parts
          ? row.parts.map((p, i) => (
              <span
                key={i}
                className={p.emph ? (row.type === "add" ? "diff-word-add" : "diff-word-del") : undefined}
              >
                {decorate ? decorate(p.text) : p.text}
              </span>
            ))
          : decorate
            ? decorate(row.text)
            : row.text;
        return (
          <div
            key={idx}
            ref={(el) => rowRef?.(idx, el)}
            className={`diff-row diff-${row.type}`}
          >
            <span className="diff-gutter" aria-hidden="true">{gutterNo ?? ""}</span>
            <span className="diff-sign" aria-hidden="true">{sign}</span>
            <span className="diff-code">{code}</span>
          </div>
        );
      })}
    </div>
  );
}
