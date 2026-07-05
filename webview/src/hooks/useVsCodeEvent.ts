import { useEffect } from "react";
import { useStore } from "../store/store";

export function useVsCodeEvent(): void {
  const handleMessage = useStore((s) => s.handleMessage);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data && typeof event.data === "object" && "type" in event.data) {
        handleMessage(event.data);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [handleMessage]);
}
