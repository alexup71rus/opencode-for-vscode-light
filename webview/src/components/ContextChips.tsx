import { useStore } from "../store/store";
import { basename } from "../utils";

interface ContextChipsProps {
  onRemove?: (key: "file" | "selection") => void;
}

function FileIcon(): React.ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 2 H9.5 L12.5 5 V14 H3.5 Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9.5 2 V5 H12.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

export function ContextChips({ onRemove }: ContextChipsProps): React.ReactElement | null {
  const activeFilePath = useStore((s) => s.activeFilePath);
  const activeFileName = useStore((s) => s.activeFileName);
  const selection = useStore((s) => s.selection);

  if (!activeFilePath && !selection) return null;

  const displayName = activeFileName ?? (activeFilePath ? basename(activeFilePath) : "");

  return (
    <div className="context-chips">
      {activeFilePath && (
        <span className="chip chip-file" title={activeFilePath}>
          <span className="chip-icon"><FileIcon /></span>
          <span className="chip-label">{displayName}</span>
          {onRemove && (
            <button
              className="chip-remove"
              onClick={() => onRemove("file")}
              title="Remove"
              aria-label={`Remove ${displayName} from context`}
            >
              ×
            </button>
          )}
        </span>
      )}
      {selection && (
        <span className="chip chip-selection" title={selection}>
          <span className="chip-icon">⌗</span>
          <span className="chip-label">{selection.length > 30 ? `${selection.slice(0, 30)}…` : selection}</span>
          {onRemove && (
            <button
              className="chip-remove"
              onClick={() => onRemove("selection")}
              title="Remove"
              aria-label="Remove selection from context"
            >
              ×
            </button>
          )}
        </span>
      )}
    </div>
  );
}
