import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  { ignores: ["dist/", "coverage/", "node_modules/"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-var": "error",
      "prefer-const": "error",
      "object-shorthand": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    // The engine runs inside a Web Worker and must not touch the DOM.
    files: ["src/engine/**/*.js", "src/worker.js"],
    languageOptions: { globals: { ...globals.worker } },
  },
  {
    files: ["tests/**/*.js", "*.config.js"],
    languageOptions: { globals: { ...globals.node } },
  },
  // Turns off style rules that Prettier owns. Must stay last.
  prettier,
];
