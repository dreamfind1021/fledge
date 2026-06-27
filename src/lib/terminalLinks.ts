// 純函式：終端機行內連結偵測（URL + 本機檔案路徑），給 xterm 自訂 link provider 用。
// 安全立場（終端機內容不可信；Codex 對抗式審查後收緊）：
//   - URL 只放行 http/https（regex 僅配此兩種 scheme；不支援 mailto/tel——payload 風險、
//     在 claude CLI 輸出幾乎不出現；file:/javascript: 天然落空）
//   - 路徑解析後必須落在 **projectPath** 內（邊界收到專案根：擋 `..` 逃逸與專案外絕對路徑、
//     縮小 reveal 攻擊面）。注意：containment 為 lexical，未解 symlink——但動作僅 Finder 顯示
//     （非開檔/執行），且限縮在專案內，殘留風險低（已知 v1 限制）。
// 元件只負責「按 kind 呼叫 openUrl / revealItemInDir」，所有判斷在此測試。

export interface TerminalLink {
  start: number; // 行內起始索引
  end: number; // 結束索引（exclusive）——底線範圍
  kind: "url" | "path";
  target: string; // url（給 openUrl）或絕對路徑（給 revealItemInDir）
}

export interface LinkOpts {
  home?: string; // 僅供 `~/` 展開；缺 home 時 `~/` 路徑略過（URL 與相對路徑不受影響）
  projectPath?: string; // 檔案路徑的 containment 邊界＝專案根；無則不做檔案連結
}

const URL_RE = /https?:\/\/[^\s]+/gi; // 只 http/https；i flag 容大寫 scheme（無 bypass，仍只配這兩種）
// 路徑候選：含至少一個 `/` 的路徑字元串，選擇性帶 `:line[:col]` 行號後綴
const PATH_RE = /[A-Za-z0-9._\-/~@+]*\/[A-Za-z0-9._\-/~@+]*(?::\d+(?::\d+)?)?/g;
const LINE_SUFFIX_RE = /:\d+(?::\d+)?$/;

// 剝除尾隨標點（句尾句號、無對應開括號的閉括號等）——避免把句子標點吃進連結
function stripTrailingPunct(s: string): string {
  let e = s.length;
  for (;;) {
    const c = s[e - 1];
    if (c === undefined) break;
    if (".,;:!?'\"".includes(c)) { e--; continue; }
    if ((c === ")" && !s.slice(0, e).includes("(")) ||
        (c === "]" && !s.slice(0, e).includes("[")) ||
        (c === "}" && !s.slice(0, e).includes("{"))) { e--; continue; }
    break;
  }
  return s.slice(0, e);
}

function overlaps(s: number, e: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([rs, re]) => s < re && e > rs);
}

// 只把「像路徑」的字串當候選：以 / ~/ ./ ../ 開頭，或最後一段帶副檔名。
// 擋掉 "cat/dog" 這種含斜線但非路徑的普通字。
function qualifiesAsPath(rawPath: string): boolean {
  if (/^(\/|~\/|\.\/|\.\.\/)/.test(rawPath)) return true;
  const lastSeg = rawPath.slice(rawPath.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9]+$/.test(lastSeg);
}

// POSIX 路徑正規化（解 . 與 ..，不碰檔案系統）
function normalizePosix(p: string): string {
  const isAbs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!isAbs) out.push("..");
    } else out.push(seg);
  }
  return (isAbs ? "/" : "") + out.join("/");
}

// 解析路徑為絕對路徑並做 projectPath containment；不合格回 null
function resolvePath(rawPath: string, { home, projectPath }: LinkOpts): string | null {
  if (!projectPath) return null; // 邊界＝專案根；無專案根則不做檔案連結
  let abs: string;
  if (rawPath.startsWith("~/")) {
    if (!home) return null; // 缺 home → 無法展開 ~/，略過（URL/相對路徑不受影響）
    abs = home + rawPath.slice(1);
  } else if (rawPath.startsWith("/")) {
    abs = rawPath;
  } else {
    abs = `${projectPath}/${rawPath}`;
  }
  const norm = normalizePosix(abs);
  if (norm === projectPath || norm.startsWith(`${projectPath}/`)) return norm;
  return null; // 逃逸出專案根 → 拒絕
}

// ── 字串索引 → xterm 欄位映射（全形字佔 2 欄，translateToString 卻只 1 char）──
// 結構化型別（不直接綁 xterm，便於單測）：xterm 的 IBufferLine/IBufferCell 結構相容。
export interface BufferCellLike { getChars(): string; getWidth(): number }
export interface BufferLineLike { length: number; getCell(i: number): BufferCellLike | undefined }

// translateToString 的 0-based 字串索引 → 0-based 欄位（cell index）。
// 全形字的 spacer cell（width 0）佔欄不佔字串，須跳過。
// 註：連結端點永遠落在 token 邊界（空白/標點分隔），不會切在 emoji/surrogate pair 或
// combining sequence 中間（同 cell 的 getChars 整串計入），故無 mid-char 位移問題。
export function strIndexToColumn(line: BufferLineLike, strIndex: number): number {
  let s = 0;
  for (let col = 0; col < line.length; col++) {
    const cell = line.getCell(col);
    if ((cell?.getWidth() ?? 1) === 0) continue; // 全形 spacer：非字串位置
    if (s >= strIndex) return col;
    s += (cell?.getChars() ?? "").length || 1; // 空 cell 以 1（空白）計，對齊 translateToString
  }
  return line.length;
}

export function linksInLine(line: string, opts: LinkOpts): TerminalLink[] {
  const links: TerminalLink[] = [];
  const consumed: Array<[number, number]> = [];

  // URL 優先（並記錄佔用範圍，避免路徑偵測重複命中）
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(line))) {
    const visible = stripTrailingPunct(m[0]);
    if (!visible) continue;
    const start = m.index;
    const end = start + visible.length;
    links.push({ start, end, kind: "url", target: visible });
    consumed.push([start, end]);
  }

  // 路徑（跳過 URL 範圍）
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(line))) {
    const visible = stripTrailingPunct(m[0]);
    if (!visible) continue;
    const start = m.index;
    const end = start + visible.length;
    if (overlaps(start, end, consumed)) continue;
    const sfx = visible.match(LINE_SUFFIX_RE);
    const rawPath = sfx ? visible.slice(0, visible.length - sfx[0].length) : visible;
    if (!qualifiesAsPath(rawPath)) continue;
    const target = resolvePath(rawPath, opts);
    if (!target) continue;
    links.push({ start, end, kind: "path", target });
  }

  return links.sort((a, b) => a.start - b.start);
}
