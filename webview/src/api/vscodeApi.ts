import type { WebviewToExtension } from "./types";

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

export const vscode = acquireVsCodeApi();

export function postMessage(msg: WebviewToExtension): void {
  vscode.postMessage(msg);
}
