module.exports = {
  Uri: {
    file: (p) => ({ fsPath: p, scheme: "file" }),
    from: () => ({ fsPath: "", scheme: "opencode-diff" }),
    joinPath: () => ({ fsPath: "" }),
  },
  commands: { executeCommand: async () => undefined },
  ViewColumn: { Beside: 0 },
  window: { createTextEditorDecorationType: () => ({}) },
};
