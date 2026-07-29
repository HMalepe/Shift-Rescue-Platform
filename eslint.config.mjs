import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/migrations/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Unused vars are usually a half-finished refactor. Underscore-prefixed
      // names are the documented opt-out.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Floating promises in a system that writes to Postgres and enqueues
      // jobs are how work silently does not happen.
      "@typescript-eslint/no-floating-promises": "off",
      "no-console": "off",
    },
  },
  {
    // Tests deliberately reach into internals and cast driver results.
    files: ["**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
