import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-plugin-prettier/recommended";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "next-env.d.ts",
    "prisma/generated/**",
  ]),
  {
    rules: {
      // --- Existing ---
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          // Catch unused exports within the same file (e.g., functions defined but never called)
          // Note: this does NOT catch exports unused by OTHER files — that requires
          // import/no-unused-modules which is incompatible with re-export patterns.
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "prefer-const": "error",
      "react-hooks/incompatible-library": "off",
      // Data fetching in useEffect is a legitimate pattern; this rule is too strict
      "react-hooks/set-state-in-effect": "off",

      // --- Strictness ---

      // Enforce exhaustive deps (promote from warn to error)
      "react-hooks/exhaustive-deps": "error",
      // Catch the state cascade antipattern (setting state during render)
      "react-hooks/set-state-in-render": "error",
      // Enforce import type for type-only imports
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          // Allow `typeof import("module").Foo` syntax (can't use import type there)
          disallowTypeAnnotations: false,
        },
      ],
      // Code quality
      "no-debugger": "error",
      "no-inner-declarations": "error",
      "no-var": "error",

      // Catch `ban-ts-comment` without explanations
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": "allow-with-description",
          "ts-nocheck": "allow-with-description",
          "ts-check": "allow-with-description",
          minimumDescriptionLength: 10,
        },
      ],
    },
  },
]);

export default eslintConfig;
