// 剪貼簿寫入：WKWebView 在 secure context 下 writeText 可用。失敗（權限/環境）只記 log 不擲回，
// 由呼叫端決定要不要提示——終端機複製是 fire-and-forget，設置卡則要靠回傳值顯示「已複製」。
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.warn("剪貼簿寫入失敗（複製）", err);
    return false;
  }
}
