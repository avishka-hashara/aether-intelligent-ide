import { defineConfig } from "tsup";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  outDir: "dist",
  clean: true,
  sourcemap: true,
  outExtension() {
    return {
      js: ".js",
    };
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
  async onSuccess() {
    await fs.writeFile(
      path.resolve(__dirname, "dist/package.json"),
      JSON.stringify({ type: "commonjs" }, null, 2)
    );
  },
});
