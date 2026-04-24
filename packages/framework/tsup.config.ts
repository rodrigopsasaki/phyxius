import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: false,
  // Transport adapters are optional peers; don't bundle them.
  external: ["@phyxiusjs/http", "@phyxiusjs/queue", "@phyxiusjs/scheduler"],
});
