import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

const eslintConfig = [
  ...compat.config({
    extends: ["next/core-web-vitals", "next/typescript"],
  }),
  {
    ignores: [".next/**", "node_modules/**", "out/**", "build/**", "next-env.d.ts"],
  },
  // Temporary, narrowly scoped compatibility for the legacy backend demo UI.
  // Keep all other Next.js and TypeScript lint checks enabled.
  {
    files: ["app/page.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    files: ["components/ProfessionDetails.tsx"],
    rules: { "react/no-unescaped-entities": "off" },
  },
];

export default eslintConfig;
