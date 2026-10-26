import { createRequire } from "node:module";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-plugin-prettier/recommended";

const require = createRequire(import.meta.url);
const reactVersion = require("react/package.json").version;

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
    // eslint-config-next sets `settings.react.version: "detect"`, which makes
    // eslint-plugin-react call `context.getFilename()` — an API ESLint 10
    // removed — so every lint run crashes. Handing it the installed React
    // version skips detection entirely; read it from the package so the pin
    // can't go stale.
    settings: { react: { version: reactVersion } },
  },
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
  {
    // Settings may only be written through the settings registry
    // (`src/lib/settings/update.ts`). A direct mutation elsewhere would bypass
    // the registry's validation, its scope checks, and the eviction of pooled
    // agent sessions whose model/tools the setting feeds — so it is an error,
    // not a review comment.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/settings/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...["appSettings", "adminSettings"].map((model) => ({
          selector: `MemberExpression[object.property.name='${model}'][property.name=/^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/]`,
          message:
            `Write ${model} through @/lib/settings/update (setSetting / applyUserSettingsPatch) ` +
            `instead of prisma.${model} directly — otherwise the change skips the settings registry.`,
        })),
      ],
    },
  },
  {
    /*
     * A page action is `PageAction` and its row is `PageActions`
     * (`src/components/layout/page.tsx`). Copying either is how the nine pages
     * this rule was written for ended up with their own sizes and placements,
     * and `e2e/page-actions.spec.ts` measures the result.
     */
    files: ["src/**/*.tsx"],
    ignores: ["src/components/layout/page.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...["h-8 w-8 md:w-auto", "items-center justify-end border-b px-4"].flatMap((pattern) => [
          {
            selector: `Literal[value=/${pattern}/]`,
            message: `Hand-rolled page action (${pattern}). Use PageActions and PageAction from @/components/layout/page.`,
          },
          {
            selector: `TemplateElement[value.raw=/${pattern}/]`,
            message: `Hand-rolled page action (${pattern}). Use PageActions and PageAction from @/components/layout/page.`,
          },
        ]),
      ],
    },
  },
]);

export default eslintConfig;
