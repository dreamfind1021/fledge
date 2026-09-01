import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // 沒有這行，vitest 會把所有 .css import 換成空字串——連 `?raw` 也一樣。
    // 兩個測試靠讀 CSS 原始碼工作：components/Tasks.contrast.test.ts（顏色對比門檻）
    // 與 lib/sourceHygiene.test.ts（掃控制字元，它的 .css 那部分在這之前一直是空掃）。
    css: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
