import { describe, expect, it } from "vitest";
import { baseLevel, cssRules, readCss, resolveColor, stops, stripComments, token, worst } from "../testing/cssRules";

// 待辦面板的顏色對比防線。
//
// 為什麼需要這個檔：Tasks.test.tsx 只斷言「done 的記號有一個 svg」，
// 那條測試對「這個 svg 在畫面上根本看不清楚」完全無感——Codex 第二輪就是抓到
// done 記號被 opacity: .65 打到 2.13:1（門檻 3:1）而測試全綠。
//
// 這裡守兩件事：
//   ① 記號與已完成列**實際用的**顏色 token 對比度要過門檻
//   ② 這些規則不准用 opacity 做淡化——opacity 把顏色往底色拉，
//      對比度是無聲被打掉的，從 token 值算不出來（①）也就守不住

// 從 Tasks.css 讀出某條規則實際用的顏色 token；讀檔、查規則、算對比的工具在 ../testing/cssRules.ts（票 28 抽出）。
// 只看基礎等級：@media／@container 區塊內的覆寫只在那個寬度生效，混進「取最後一條」會把基礎值蓋掉
const tasksCss = readCss("/src/components/Tasks.css");
const { paintToken, paintColor, paintColors } = cssRules(baseLevel(stripComments(tasksCss)));

describe("待辦面板的顏色對比", () => {
  const bg = token("bg");
  // 編輯器（spec §6.2）的文字實際坐落在 .full-editor 的 --surface 上，不是 --bg——
  // --surface 比 --bg 亮，拿 --bg 當底算出來的對比度會偏高、掩蓋掉真的不夠的情況，
  // 所以這裡另外備一個底色，各選擇器依實際坐落的容器各自指定（task 10 review）
  const surface = token("surface");
  // 票 21 指令區塊的 <pre> 有自己的 --surface-2 底，比 --surface 再亮一階，同一個理由要另備一個底色
  const surface2 = token("surface-2");
  // 專案樹（票 19）反白列的底是 --active，不是 --bg——同一個選擇器坐落在兩種底色上，
  // 各自要驗一次（.tree-item 平常在 --bg，選到 .active 後底色換成 --active、文字色不變）
  const active = token("active");
  // 抽屜卡片（spec §11.5）：右欄內容坐落在 .tasks-col-detail 的底色上。從 CSS 讀，不寫死 token
  const drawer = paintColor(".tasks-col-detail", "background");
  // 清單的磚塊與元件（spec §11.5）：全部從 CSS 讀
  const tile = paintColor(".tk-row", "background");
  const tileHover = paintColor(".tk-row:hover", "background");
  const tileDoing = paintColor(".tk.is-doing .tk-row", "background");
  const cmdRow = paintColor(".tasks-cmd-row", "background");
  const pill = paintColor(".tasks-sec-n", "background");
  const newBtn = paintColor(".tasks-new-btn", "background");
  // 下一步是漸層：標籤、內文、› 可能落在任何一站，三態各取全部色站
  const nextBase = paintColors(".tasks-next", "background");
  const nextHover = paintColors(".tasks-next:hover", "background");
  const nextOn = paintColors(".tasks-next.is-on", "background");
  // 專案樹軌道（spec §11.6）：數字坐落在軌道、填充、進行中段三種底色上，選中列的軌道另一個色
  const track = paintColor(".tree-trk", "background");
  const trackActive = paintColor(".tree-item.active .tree-trk", "background");
  const fill = paintColor(".tree-fill", "background");
  const doingSeg = paintColor(".tree-doing", "background");

  // helper 自己的防線：數字取自 spec §11.9（另以 Python 獨立算過）
  it("resolveColor：var、color-mix；stops：漸層每一站；認不得就炸", () => {
    expect(resolveColor("var(--surface)")).toBe(token("surface"));
    expect(resolveColor("color-mix(in srgb, var(--primary) 38%, var(--surface-2))")).toBe("#705541");
    expect(stops("linear-gradient(135deg, color-mix(in srgb, var(--primary) 16%, var(--sidebar)), var(--sidebar) 70%)")).toEqual(["#342C28", token("sidebar")]);
    expect(stops("var(--surface)")).toEqual([token("surface")]);
    expect(() => resolveColor("linear-gradient(135deg, var(--surface), var(--bg))")).toThrow();
    expect(() => resolveColor("rgba(0,0,0,.5)")).toThrow();
    // 兩邊都寫百分比：CSS 要正規化、總和不足 100% 還會變半透明——這裡不支援，要炸而不是靜默忽略第二個（Codex final R1）
    expect(() => resolveColor("color-mix(in srgb, var(--primary) 30%, var(--surface) 30%)")).toThrow();
  });

  // 記號是可操作的 UI 元件，非文字門檻 3:1（WCAG 1.4.11）
  it.each([
    ["todo 空心框", ".tk-mark.is-todo::before", "border", tile],
    ["todo 空心框（選中）", ".tk-mark.is-todo::before", "border", active],
    ["doing 實心方", ".tk-mark.is-doing::before", "background", tileDoing],
    ["done 打勾（繼承 .tk-mark 的 color）", ".tk-mark", "color", tile],
    // 整頁編輯器（spec §6.2／§6.4）停用態的邊框：平常文字已經是 --dim，改文字色沒有用，
    // 訊號改放邊框上（task 10 review FIX 2）——都坐落在 .full-editor 的 --surface 上
    [".ed-btn 停用邊框", ".ed-btn:disabled", "border", surface],
    ["Preview／Cancel 停用邊框", ".btn.is-quiet:disabled", "border-color", surface],
    ["Save 停用邊框", ".btn.is-primary:disabled", "border-color", surface],
    // 票 21 指令框尾的複製圖示（lucide svg 吃 currentColor）與已複製的勾，坐落在框的 --surface-2 上
    ["指令複製圖示", ".tasks-cmd-act", "color", cmdRow],
    ["指令已複製的勾", ".tasks-cmd-act.is-done", "color", cmdRow],
    // 票 19 清單（spec §5.4／§5.6）：擱置是第四種輪廓（虛線空心方）；編輯中清單唯讀（D12）
    // 停用的記號與動作鍵是圖示（lucide svg 吃 currentColor），非文字 3:1；下一步右上的「›」
    // 是唯一的字符、spec 指定 --faint，同樣按非文字驗
    ["parked 虛線框", ".tk-mark.is-parked::before", "border", tile],
    ["停用的狀態記號", ".tk-mark:disabled", "color", tile],
    ["停用的動作鍵", ".tk-act:disabled", "color", tile],
    ["下一步的 › 記號", ".tasks-next-more", "color", nextBase],
    ["下一步的 ›（滑過）", ".tasks-next-more", "color", nextHover],
    ["下一步的 ›（選中）", ".tasks-next-more", "color", nextOn],
    // 右欄（票 19，spec §5.5）：動作鍵是圖示，非文字 3:1。
    // 票 26＋27 起 .d-body 沒有邊框，動作鍵與 × 都坐落在抽屜卡片（drawer）上
    ["右欄動作鍵", ".d-acts .tk-act", "color", drawer],
    ["右欄的 ×", ".d-close", "color", drawer],
  ])("%s 對背景至少 3:1", (_label, selector, prop, backdrop) => {
    expect(worst(token(paintToken(selector, prop)), backdrop)).toBeGreaterThanOrEqual(3);
  });

  // 票上的文字門檻 4.5:1。已完成的標題淡化到某個 token 就停，再淡就不合格
  it.each([
    ["已完成的標題", ".tk.is-done .tk-title", "color", tile],
    // 票 19：擱置的標題淡化到 --dim 就停（與已完成同一條線）；編輯中停用的一行輸入是文字，不能掉到 --faint
    ["擱置的標題", ".tk.is-parked .tk-title", "color", tile],
    ["停用的一行輸入", ".tasks-new-input:disabled", "color", bg],
    ["來源 AI", ".tk-src.is-ai", "color", tile],
    ["來源 我", ".tk-src.is-me", "color", tile],
    // 所有專案頁的跨專案票列（票 19，spec §5.3）：列文字在 --bg 上；專案標籤有自己的 --surface-2 底
    ["跨專案票列文字", ".tk-xrow", "color", tile],
    ["跨專案票列的專案標籤", ".tk-proj", "color", surface2],
    ["第二層分區標籤", ".tasks-sec-lab", "color", bg],
    ["第二層分區計數", ".tasks-sec-n", "color", pill],
    // 票內文的 markdown（右欄與編輯器預覽共用）：正文與連結都要各自過 4.5:1
    [".tk-md 內文", ".tk-md", "color", drawer],
    [".tk-md 連結", ".tk-md a", "color", drawer],
    // 票 25：離場筆記的 `# 標題`；票 26＋27 起右欄內容直接坐落在抽屜卡片（drawer）上
    [".tk-md 一級標題", ".tk-md h1", "color", drawer],
    // 整頁編輯器（spec §6.2／§6.4，task 10 review FIX 4）：坐落在 --surface 上的文字
    [".ed-title 正常文字", ".ed-title", "color", surface],
    [".ed-area 正常文字", ".ed-area", "color", surface],
    [".ed-hint 狀態字", ".ed-hint", "color", surface],
    [".ed-title 停用文字", ".ed-title:disabled", "color", surface],
    [".ed-area 停用文字", ".ed-area:disabled", "color", surface],
    ["Save 停用文字", ".btn.is-primary:disabled", "color", surface],
    // 返回列（編輯器頁首）坐落在抽屜卡片上；提示條在清單（--bg）與抽屜兩處都會出現，各驗一次
    ["返回列的專案名", ".full-back", "color", drawer],
    ["返回列的票號", ".full-num", "color", drawer],
    ["提示條文字", ".tk-banner", "color", bg],
    ["提示條文字（抽屜）", ".tk-banner", "color", drawer],
    ["提示條按鈕文字", ".tk-banner .bbtn", "color", bg],
    ["提示條按鈕文字（抽屜）", ".tk-banner .bbtn", "color", drawer],
    // 票 25：孤兒草稿的丟棄鍵在編輯中停用；停用的仍是文字，淡化到 --dim 就停
    ["停用的提示條按鈕文字", ".tk-banner .bbtn:disabled", "color", bg],
    ["停用的提示條按鈕文字（抽屜）", ".tk-banner .bbtn:disabled", "color", drawer],
    // 票 21 貼進新對話的指令：標籤坐落在 .tasks-pane 的 --bg；<pre> 在框自己的 --surface-2 上
    ["指令區塊標籤", ".tasks-cmd-lab", "color", bg],
    ["指令內文", ".tasks-cmd-pre", "color", cmdRow],
    // 專案樹（票 19，spec §5.2）：brief 的「新規則自動納入」是錯的，這幾條要補（task 5 review FIX）
    ["樹頂端摘要文字", ".tree-head .s", "color", bg],
    ["樹頂端摘要讀不到警告", ".tree-head .s .is-warn", "color", bg],
    ["樹的數字", ".tree-n", "color", bg],
    // review 點名的那一條：demo 用 --faint，brief 明確要求換成 --dim，這裡才守得住
    ["樹的擱置 +N", ".tree-n .pk", "color", bg],
    ["樹讀不到警告", ".tree-una", "color", bg],
    ["樹未開待辦的淡化名稱", ".tree-item.is-dim .tree-name", "color", bg],
    ["樹分組標籤", ".tree-grp", "color", bg],
    ["樹列文字（一般底 --bg）", ".tree-item", "color", bg],
    ["樹列文字（反白底 --active）", ".tree-item", "color", active],
    // 右欄（票 19，spec §5.5）：.tk-empty／.tk-noedit 坐落在抽屜卡片上（票 26＋27 起 .d-body 透明），
    // 不是 --bg（task 7 拿掉時的白名單死條目留在別處，這裡是它們在右欄的落點）
    [".tk-empty 無內文提示", ".tk-empty", "color", drawer],
    [".tk-noedit 不可編輯說明", ".tk-noedit", "color", drawer],
    ["右欄麵包屑", ".d-crumb", "color", drawer],
    ["右欄資訊列", ".d-meta", "color", drawer],
    // 選中的票列反白底是 --active（見 .tk-row.active）：已完成／擱置的標題淡化在那個底上
    // 同樣要過 4.5:1——沒有測試釘住的話，反白列上淡化過頭的標題會被漏掉（task 7 review 遺留）
    ["已完成的標題（反白底 --active）", ".tk.is-done .tk-title", "color", active],
    ["擱置的標題（反白底 --active）", ".tk.is-parked .tk-title", "color", active],
    // 磚塊上的淡字（spec §11.9）：一般、滑過、進行中都過 4.5；選中（--active）只有 --dim 以上過
    ["票號（磚）", ".tk-num", "color", tile],
    ["票號（滑過）", ".tk-num", "color", tileHover],
    ["日期（磚）", ".tk-date", "color", tile],
    ["日期（滑過）", ".tk-date", "color", tileHover],
    ["日期（進行中磚）", ".tk-date", "color", tileDoing],
    ["來源 AI（滑過）", ".tk-src.is-ai", "color", tileHover],
    ["來源 AI（選中）", ".tk-src.is-ai", "color", active],
    ["來源 AI（進行中磚）", ".tk-src.is-ai", "color", tileDoing],
    ["進行中票號", ".tk.is-doing .tk-num", "color", tileDoing],
    ["選中列票號", ".tk:not(.is-doing) .tk-row.active .tk-num", "color", active],
    ["選中列日期", ".tk-row.active .tk-date", "color", active],
    ["停用的新增鍵", ".tasks-new-btn:disabled", "color", newBtn],
    ["下一步標籤", ".tasks-next-lab", "color", nextBase],
    ["下一步標籤（滑過）", ".tasks-next-lab", "color", nextHover],
    ["下一步標籤（選中）", ".tasks-next-lab", "color", nextOn],
    ["下一步內文（選中）", ".tasks-next-tx", "color", nextOn],
    ["樹的軌道數字（軌道）", ".tree-num", "color", track],
    ["樹的軌道數字（選中列軌道）", ".tree-num", "color", trackActive],
    ["樹的軌道數字（填充）", ".tree-num", "color", fill],
    ["樹的軌道數字（進行中段）", ".tree-num", "color", doingSeg],
  ])("%s 對背景至少 4.5:1", (_label, selector, prop, backdrop) => {
    expect(worst(token(paintToken(selector, prop)), backdrop)).toBeGreaterThanOrEqual(4.5);
  });

  // 完成區的展開箭頭是 lucide 的 svg，用 currentColor 吃 .tasks-sec 的 color；
  // 標籤與計數各有自己的 color。分開設就會漂移——2026-09-01 就是標籤改成 --dim
  // 而容器留在 --faint，箭頭比旁邊的字淡一截。
  // 這裡不驗絕對門檻：--faint 是 3.43:1，本來就過得了非文字的 3:1，那樣的斷言
  // 在缺陷還在的時候也是綠的。要驗的是「箭頭不可以比標籤淡」這個關係本身。
  it("完成區展開箭頭與分區標籤用同一個顏色 token", () => {
    expect(paintToken(".tasks-sec", "color")).toBe(paintToken(".tasks-sec-lab", "color"));
  });

  // opacity 禁令。上面那組是從 token 值算的，算不到 opacity 疊出來的實際顏色，
  // 所以「不准用 opacity」本身要是一條規則，否則上面那組會給出安心的假象。
  // 停用態也在禁令裡：index.contrast.test.ts 的全域白名單豁免 :disabled（WCAG 1.4.3），這裡不豁免——
  // 編輯中清單唯讀是靠換 token 淡化的，一用 opacity 上面那組就驗不到實際顏色。
  // `.tk-act(?!s)` 排除 .tk-acts：那是滑過才顯形的容器，0↔1 是顯示／隱藏不是淡化，刻意用 opacity
  // `.tasks-cmd(?!-acts)(?![^{]*cmd-acts)`／`.tk-row(?![^{]*tk-acts)`（票 26＋27）：同理排除 .tasks-cmd-acts 與 `.tk-row:hover .tk-acts` 那兩條滑過顯形
  // `.tasks-col[^{]*`／`.tasks-split[^{]*`（票 19 Task 10）：版面規則只管 display/flex/padding，
  // 絕不准用 opacity 蓋掉整欄——那會讓一整欄安靜消失又量不出對比度
  // `^\s*`（task 10 fix round 1）：Task 10 review 抓到的漏洞——原本 `^` 不容許縮排，
  // @container 區塊裡的規則全部縮排兩格，`.tasks-col-list` 等版面規則因此完全沒被掃到，
  // 上面那句「與版面」形同虛設。容許前導空白後，中／寬兩個等級的規則才真的進 rules
  it("狀態記號、票列磚塊、分區、下一步、指令框、一行輸入、專案樹、跨專案票列、動作鍵、右欄與版面不得用 opacity 淡化", () => {
    const rules = [...tasksCss.matchAll(/^\s*(\.tk-mark[^{]*|\.tk\.is-done[^{]*|\.tree[^{]*|\.tk-xrow[^{]*|\.tk-proj[^{]*|\.tk-act(?!s)[^{]*|\.tasks-new-input[^{]*|\.tasks-new-btn[^{]*|\.tasks-next[^{]*|\.tasks-sec[^{]*|\.tasks-cmd(?!-acts)(?![^{]*cmd-acts)[^{]*|\.tk-row(?![^{]*tk-acts)[^{]*|\.d-[^{]*|\.lb-detail[^{]*|\.tasks-col[^{]*|\.tasks-split[^{]*)\{([^}]*)\}/gm)];
    // regex 沒命中會讓迴圈跑零次而測試全綠——先確認真的有抓到規則。
    // 門檻從 4 提到 70（task 10 fix round 1）：容許縮排前只掃得到 66 條（@container 內的
    // 9 條版面規則全部漏掉），現在是 104 條——用 100 卡住（票 26＋27 擴正則後重算），anchor 退回 `^` 會直接讓這條炸
    expect(rules.length).toBeGreaterThanOrEqual(100);
    for (const [, selector, body] of rules) {
      expect(`${selector.trim()} { ${body.trim()} }`).not.toMatch(/\bopacity\s*:/);
    }
  });
});
