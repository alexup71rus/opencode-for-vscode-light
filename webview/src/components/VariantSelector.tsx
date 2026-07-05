import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/store";
import { postMessage } from "../api/vscodeApi";

export function VariantSelector(): React.ReactElement | null {
  const providers = useStore((s) => s.providers);
  const selectedModel = useStore((s) => s.selectedModel);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const variants = useMemo<string[] | null>(() => {
    if (!selectedModel) return null;
    const provider = providers.find((p) => p.id === selectedModel.providerID);
    const model = provider?.models.find((m) => m.modelID === selectedModel.modelID);
    return model?.variants ?? null;
  }, [providers, selectedModel]);

  if (!variants || variants.length === 0) return null;

  const current = selectedModel?.variant;

  const select = (variant: string | null) => {
    if (!selectedModel) return;
    const next = { ...selectedModel };
    if (variant === null) delete next.variant;
    else next.variant = variant;
    useStore.getState().setSelectedModel(next);
    postMessage({ type: "selectModel", model: next });
    setOpen(false);
  };

  return (
    <div className="variant-selector" ref={ref}>
      <button
        className={`variant-selector-button ${open ? "open" : ""} ${current ? "active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={current ? `Thinking: ${current}` : "Thinking: default"}
        aria-label="Select thinking level"
      >
        <span className="variant-selector-icon" aria-hidden="true">⚡</span>
        <span className="variant-selector-label">{current ?? "auto"}</span>
        <span className="variant-selector-caret">▾</span>
      </button>
      {open && (
        <div className="variant-selector-dropdown">
          <button
            type="button"
            className={`variant-option ${!current ? "active" : ""}`}
            onClick={() => select(null)}
            title="Let the server pick the default variant"
          >
            <span className="variant-option-name">Default</span>
            <span className="variant-option-desc">server pick</span>
          </button>
          {variants.map((v) => (
            <button
              key={v}
              type="button"
              className={`variant-option ${current === v ? "active" : ""}`}
              onClick={() => select(v)}
            >
              <span className="variant-option-name">{v}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
