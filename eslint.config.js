const js = require("@eslint/js");
const prettierConfig = require("eslint-config-prettier");

// Self-audit finding: no lint step existed anywhere in this repo — ci.yml's
// own comment said as much ("no lint step... adding one as a CI gate
// without first agreeing on the actual rules would just be a wall nobody
// asked for"). This is the minimal, low-noise version of that: eslint's
// own `recommended` set (catches real mistakes — unused vars, unreachable
// code, undefined globals — not style opinions), plus eslint-config-prettier
// to turn off every ESLint rule that would otherwise fight Prettier over
// formatting, since formatting is Prettier's job, not a lint rule's.
// Deliberately not opinionated beyond that (no airbnb/standard preset) —
// this repo already has a consistent, deliberate voice (see every file's
// own extensive comments); a style-opinionated preset would just start a
// fight with that, not improve correctness.
module.exports = [
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        exports: "writable",
        process: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortController: "readonly",
        FormData: "readonly",
        Blob: "readonly",
      },
    },
    rules: {
      // Prefixing an intentionally-unused parameter with `_` is this
      // codebase's existing convention (grep any (err, _next) callback) —
      // codified here instead of flagging every one of them.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
  {
    // public/marketing/*.js are plain <script> tags the marketing site
    // loads directly in a browser (no build step — see README's own "no
    // bundler" note on that directory) — real browser globals, not Node's.
    files: ["public/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        matchMedia: "readonly",
        IntersectionObserver: "readonly",
        performance: "readonly",
        requestAnimationFrame: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  {
    // public/app/ is the built dashboard bundle (Vite output, gitignored —
    // see .gitignore's own "public/app/" entry), not source; frontend/'s
    // own source has its own separate eslint.config.js.
    ignores: ["node_modules/**", "frontend/**", "public/app/**", "logs/**", "data/**", "coverage/**"],
  },
  prettierConfig,
];
