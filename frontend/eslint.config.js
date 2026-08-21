import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import prettierConfig from "eslint-config-prettier";

// Same minimal, low-noise posture as the backend's own eslint.config.js:
// eslint's `recommended` set for real mistakes, react-hooks' rules for the
// one category of React bug ESLint actually catches well (a hook called
// conditionally, a missing effect dependency), react-refresh for Vite's
// Fast Refresh constraint (a file that mixes component and non-component
// exports breaks HMR), and eslint-config-prettier so formatting stays
// Prettier's job alone.
export default [
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.es2021 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      // Deliberately just these two, not react-hooks' full `recommended`
      // set — v7 added a large batch of React-Compiler-oriented rules
      // (set-state-in-effect, purity, refs, ...) that flag this codebase's
      // completely ordinary "load data in a useEffect on mount" pattern as
      // an error. That's a real, opinionated architectural stance (this
      // app doesn't target the React Compiler), not a mistake — rules-of-
      // hooks (hooks called unconditionally, in a stable order — a genuine
      // class of bug) and exhaustive-deps (as a warning: often correct to
      // flag, but has legitimate, deliberate exceptions in real code) are
      // the same low-noise, real-mistakes-only bar the backend's own
      // eslint.config.js holds.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": "warn",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
  {
    // Vitest test files run under Node/jsdom, not a real browser — `global`
    // (used to stub fetch/etc.) is Node's global object, not a browser one.
    files: ["**/__tests__/**", "**/*.test.{js,jsx}"],
    languageOptions: { globals: { ...globals.node } },
  },
  { ignores: ["node_modules/**", "dist/**", "coverage/**"] },
  prettierConfig,
];
