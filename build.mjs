// Bundles the CLI into a single ESM file for packaging with @yao-pkg/pkg.
//
// pkg cannot reliably snapshot our ESM dependency graph directly: modules like
// ink and yoga-layout mix top-level `await` with `export`, which pkg's ESM->CJS
// transformer can't convert, so their sibling files (e.g. yoga's wasm blob)
// fail to resolve at runtime inside the snapshot. Pre-bundling with esbuild
// inlines all of that into one file, sidestepping the whole problem.
import { build } from "esbuild";

// ink lazily pulls in react-devtools-core only when DEV=true, but esbuild
// hoists that import and tries to resolve it eagerly. It isn't a dependency we
// ship, so stub it with an empty module — the code path never runs in a build.
const stubDevtools = {
  name: "stub-react-devtools-core",
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

await build({
  entryPoints: ["index.js"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: "dist/app.mjs",
  // puppeteer spawns Chrome and does its own dynamic requires; let pkg snapshot
  // it from node_modules (it's CJS and packages cleanly) instead of bundling.
  external: ["puppeteer"],
  plugins: [stubDevtools],
  // Bundled CommonJS deps (commander, inquirer, …) call require() for builtins
  // like "events". An ESM bundle has no require, so provide a real one.
  banner: {
    js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
  },
  logLevel: "info",
});
