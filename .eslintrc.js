import boundaries from "eslint-plugin-boundaries";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["dist/**", "**/dist/**", "docs/**", "node_modules/**"],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      boundaries,
    },
    settings: {
      "boundaries/elements": [
        {
          type: "adapter",
          pattern: "apps/extension/**/*",
          mode: "full",
        },
        {
          type: "ui",
          pattern: "apps/manager-ui/**/*",
          mode: "full",
        },
        {
          type: "protocol",
          pattern: "packages/protocol/**/*",
          mode: "full",
        },
        {
          type: "core",
          pattern: [
            "packages/agent-core/**/*",
            "packages/tools/**/*",
            "packages/providers/**/*",
            "packages/sandbox/**/*",
            "packages/artifacts/**/*",
          ],
          mode: "full",
        },
      ],
    },
    rules: {
      "boundaries/element-types": [
        "error",
        {
          default: "allow",
          rules: [
            {
              from: ["adapter", "ui"],
              disallow: ["core"],
              message:
                "The extension must contain no business logic: adapter and ui are forbidden from importing core elements.",
            },
          ],
        },
      ],
    },
  },
];
