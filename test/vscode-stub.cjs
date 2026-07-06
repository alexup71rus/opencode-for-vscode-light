// Minimal stub of the `vscode` module for running tests under tsx/node:test,
// where the real VS Code API isn't available. Only covers the surface used by
// modules imported by tests (mainly diffProvider.ts: TextDocumentContentProvider
// type, Uri, commands, ViewColumn). Registered as a fake module by
// test/register-vscode.cjs, which the "test" script loads via --import.
//
// Keep this focused: tests that exercise real VS Code behaviour belong in the
// extension host, not here.

// `implements vscode.TextDocumentContentProvider` in diffProvider only needs the
// type to exist at compile time; at runtime it's a no-op interface.
const TextDocumentContentProvider = class {};

module.exports = {
  // Type used in `implements`.
  TextDocumentContentProvider,

  Uri: {
    file: (p) => ({ fsPath: p, scheme: "file" }),
    from: (parts) => ({
      fsPath: parts?.path ?? "",
      scheme: parts?.scheme ?? "opencode-diff",
      authority: parts?.authority ?? "",
    }),
    joinPath: () => ({ fsPath: "" }),
  },
  commands: { executeCommand: async () => undefined },
  ViewColumn: { Active: 1, Beside: 2 },
  window: { createTextEditorDecorationType: () => ({}) },
};
