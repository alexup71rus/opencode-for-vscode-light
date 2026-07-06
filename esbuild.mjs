import * as esbuild from "esbuild";
import * as path from "node:path";

const watch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: ["src/extension/extension.ts"],
  bundle: true,
  outfile: "dist/extension/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
  // jsonc-parser ships a UMD main whose `require("./impl/*")` calls live inside
  // an AMD-conditional branch that esbuild cannot statically analyse, so the
  // four impl modules (format/edit/scanner/parser) are silently dropped from
  // the bundle and crash at runtime with `Cannot find module './impl/format'`.
  // Pin its ESM entry — static `import`s there are visible to esbuild.
  alias: {
    "jsonc-parser": path.resolve("node_modules/jsonc-parser/lib/esm/main.js"),
  },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[esbuild] watching for changes...");
} else {
  await esbuild.build(options);
  console.log("[esbuild] build complete");
}
