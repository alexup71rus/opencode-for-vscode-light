import { useEffect } from "react";
import { useStore } from "../store/store";

interface Shortcut {
  keys: string;
  action: string;
}

export function HelpModal(): React.ReactElement | null {
  const open = useStore((s) => s.helpOpen);
  const setOpen = useStore((s) => s.setHelpOpen);
  const sendOnEnter = useStore((s) => s.settings.sendOnEnter);

  const shortcuts: Shortcut[] = sendOnEnter
    ? [
        { keys: "Enter", action: "Send message" },
        { keys: "Shift + Enter", action: "Insert newline" },
        { keys: "⌘/Ctrl + Enter", action: "Send message" },
      ]
    : [
        { keys: "⌘/Ctrl + Enter", action: "Send message" },
        { keys: "Enter", action: "Insert newline" },
      ];

  const SHORTCUTS: Shortcut[] = [
    ...shortcuts,
    { keys: "⌘/Ctrl + L", action: "Focus input" },
    { keys: "⌘/Ctrl + K", action: "New chat" },
    { keys: "⌘/Ctrl + Shift + S", action: "Toggle sessions sidebar" },
    { keys: "⌘/Ctrl + ↑ / ↓", action: "Switch session" },
    { keys: "Shift + ?", action: "Open this help" },
    { keys: "Esc", action: "Close dialogs; interrupt generation if not typing" },
  ];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Keyboard shortcuts</span>
          <button className="modal-close" title="Close" onClick={() => setOpen(false)}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <ul className="shortcut-list">
            {SHORTCUTS.map((s) => (
              <li key={s.keys} className="shortcut-row">
                <kbd className="shortcut-key">{s.keys}</kbd>
                <span className="shortcut-action">{s.action}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
