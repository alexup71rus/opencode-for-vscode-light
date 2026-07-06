// Preload hook for node:test: registers a fake `vscode` module so that source
// files imported by tests (diffProvider.ts, …) can `import * as vscode from
// "vscode"` without the real VS Code API. Loaded via `--import`.
//
//   node --import tsx --import ./test/register-vscode.cjs --test test/*.test.ts
//
// We monkey-patch Module._resolveFilename so `require("vscode")` resolves to our
// stub regardless of where the test file lives. This is the standard CJS loader
// hook approach; tsx routes requires through it too.
const Module = require("module");
const path = require("path");

const STUB_PATH = path.join(__dirname, "vscode-stub.cjs");
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, ...args) {
  if (request === "vscode") {
    return STUB_PATH;
  }
  return originalResolveFilename.call(this, request, ...args);
};
