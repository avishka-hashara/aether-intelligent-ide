import { defineConfig } from "tsup";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  outDir: "dist",
  clean: true,
  sourcemap: true,
  external: ["better-sqlite3"],
  outExtension() {
    return {
      js: ".js",
    };
  },
  async onSuccess() {
    await fs.writeFile(
      path.resolve(__dirname, "dist/package.json"),
      JSON.stringify({ type: "commonjs" }, null, 2)
    );
  },
});
