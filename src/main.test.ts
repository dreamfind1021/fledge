// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

// main.tsx 的啟動順序（票 38）：render 之前呼叫 initTheme()。刪掉那一行其他測試全綠，但淺色使用者重開後
// 外觀選項亮在「午夜藍」、原生標題列一直是深色、存壞的值不會被修正。
// 實際載入 main.tsx、記下兩個呼叫的先後；App 與 createRoot 換成假的，不掛整個 app
// （Codex plan R2：讀原始碼得自己處理註解與字串，改成實際執行）
const order = vi.hoisted(() => [] as string[]);
vi.mock("./lib/theme", () => ({ initTheme: () => order.push("initTheme") }));
vi.mock("react-dom/client", () => ({ default: { createRoot: () => ({ render: () => order.push("render") }) } }));
vi.mock("./App", () => ({ default: () => null }));
vi.mock("./i18n", () => ({}));

it("render 之前呼叫 initTheme()", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  await import("./main");
  expect(order).toEqual(["initTheme", "render"]);
});
