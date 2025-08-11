// ESLint configuration to enforce deterministic time operations
// Forbids Date.now() and setTimeout in favor of injected Clock interface

import tseslint from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.js", "src/**/*.ts"],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // Forbid direct use of Date.now() - should use injected Clock instead
      "no-restricted-globals": [
        "error",
        {
          name: "Date",
          message: "Use injected Clock interface instead of Date for deterministic time operations",
        },
      ],
      // Forbid direct use of setTimeout/setInterval - should use Clock.sleep() instead
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='setTimeout']",
          message: "Use Clock.sleep() instead of setTimeout for deterministic timing",
        },
        {
          selector: "CallExpression[callee.name='setInterval']",
          message: "Use Clock.interval() instead of setInterval for deterministic timing",
        },
        {
          selector: "CallExpression[callee.name='clearTimeout']",
          message: "Timeout cleanup should be handled by Effect cancellation system",
        },
        {
          selector: "CallExpression[callee.name='clearInterval']",
          message: "Interval cleanup should be handled by Effect cancellation system",
        },
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message: "Use injected Clock.now() instead of Date.now() for deterministic time",
        },
        {
          selector: "NewExpression[callee.name='Date']",
          message: "Use injected Clock interface instead of Date for deterministic time operations",
        },
      ],
    },
  },
  {
    files: ["test/**/*.js", "test/**/*.ts"],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // Allow setTimeout in tests for test utilities, but still forbid Date operations
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message: "Use Clock.now() from controlled clock in tests for deterministic time",
        },
        {
          selector: "NewExpression[callee.name='Date']",
          message: "Use controlled clock in tests for deterministic time operations",
        },
      ],
    },
  },
];
