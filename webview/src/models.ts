import type { ModelSelection } from "./api/types";

export function modelKey(m: ModelSelection): string {
  return `${m.providerID}/${m.modelID}`;
}
