// react-hooks/rules-of-hooks 設成 error 並納入 build。
// 理由：hook 寫在 early return 後面，TypeScript 檢查不出來，
// 但執行時會丟 React error #310 把整個畫面炸成白屏。這個規則擋得住。
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
