import type { ReactNode } from "react";
import type { TasksOverview as TasksOverviewData, TasksProjectRow } from "../lib/sidecar";

type T = (k: string, o?: Record<string, unknown>) => string;

// 未完成條數的刻度：一根＝一張票。超過 CAP 就不再加根，數量交給旁邊的數字說。
// **刻意不畫進度條**——overview 的 payload 只有 unfinished、沒有總數，比例的分母只能是編出來的。
// 同理刻度也不分狀態上色：payload 沒有 doing/todo 的拆分，上色等於畫一個後端沒說的事實。
const TALLY_CAP = 12;

function Tally({ n, doing }: { n: number; doing: number }) {
  // n 超過 CAP 時刻度本來就是近似（封頂 12 根）。上色的根數要同比例縮，
  // 否則 20 張裡 15 張進行中會畫成「12 根全上色」＝ 看起來 100%。
  // doing 不是 0 就至少留 1 根：有進行中卻一根都沒上色，等於說「沒人在動」
  const shown = Math.min(n, TALLY_CAP);
  const lit = doing === 0 ? 0 : Math.max(1, Math.round((doing / n) * shown));
  // 純視覺編碼，語意由旁邊的數字承擔（螢幕報讀讀數字就好，不需要聽 12 根刻度）
  return (
    <span className="tov-marks" aria-hidden="true">
      {Array.from({ length: shown }, (_, i) => (
        <i key={i} className={i < lit ? "is-doing" : undefined} />
      ))}
    </span>
  );
}

// 進行中的張數。runtime JSON 沒有驗證，壞值一律退回 0＝不上色——
// 刻度總數來自 unfinished 仍然可信，**只有拆分不可信**，不必把整列降級成警告
// （那是 tasks_status 壞掉時才做的事）。doing 必須是 0 到 n 之間的整數
const doingCount = (p: TasksProjectRow, n: number) =>
  Number.isInteger(p.doing) && (p.doing as number) >= 0 && (p.doing as number) <= n
    ? (p.doing as number)
    : 0;

// 只有非負整數才是真的條數。runtime JSON 沒有驗證，壞值不可被 ?? 0 壓成「沒有待辦」
const okCount = (p: TasksProjectRow) =>
  p.tasks_status === "ok" && Number.isInteger(p.unfinished) && (p.unfinished as number) >= 0
    ? (p.unfinished as number)
    : null;

function ProjectRow({ p, onSelect, t }: {
  p: TasksProjectRow; onSelect: (path: string) => void; t: T;
}) {
  const n = okCount(p);
  return (
    <button className="tov-row" title={p.path} onClick={() => onSelect(p.path)}>
      <span className="tov-name">{p.name}</span>
      <span className="tov-count">
        {n !== null ? (
          <><Tally n={n} doing={doingCount(p, n)} /><span className={n ? "tov-n" : "tov-n is-zero"}>{n}</span></>
        ) : p.tasks_status === "absent" ? (
          // 沒有 tasks/ 資料夾。**不是 0**——payload 分得開，不該被 UI 壓平成同一個數字
          <span className="tov-unused">{t("overview.notUsing")}</span>
        ) : (
          // unavailable、認不得的狀態、以及 ok 但數字是壞的，全部走這一支。
          // 刻意不寫 === "unavailable"：fail-safe 要落在警告這一側，否則異常會被說成「沒有待辦」
          <span className="tov-una">{t("overview.unavailable")}</span>
        )}
      </span>
      {/* 空白會讓人以為壞了。明講「沒設定」，也讓使用者知道這個欄位存在、可以設 */}
      <span className={p.next_step ? "tov-next" : "tov-next is-none"}>
        {p.next_step || t("overview.noNextStep")}
      </span>
    </button>
  );
}

function Group({ label, n, children }: { label: string; n: number; children: ReactNode }) {
  return (
    <>
      <div className="tov-sec">
        <span className="tov-sec-lab">{label}</span>
        <span className="tov-sec-line" />
        <span className="tov-sec-n">{n}</span>
      </div>
      {children}
    </>
  );
}

// 第一層：所有已知專案的未完成條數 ＋ 下一步（design §5.1）。
// 沒有待辦的專案也要列出——隱藏了使用者就不知道那個專案可以開票。
export function TasksOverview({ data, failed, onSelect, t }: {
  data: TasksOverviewData | null;
  failed: boolean;
  onSelect: (path: string) => void;
  t: T;
}) {
  const head = (extra?: ReactNode) => (
    <div className="tasks-head"><h1>{t("tabTitle")}</h1>{extra}</div>
  );

  if (failed) return <>{head()}<div className="tasks-note is-error">{t("overview.loadError")}</div></>;
  if (data == null) return <>{head()}<div className="tasks-note">{t("overview.loading")}</div></>;
  if (data.projects.length === 0) return <>{head()}<div className="tasks-note">{t("overview.empty")}</div></>;

  // 「這個專案在總覽上有沒有話要說」。absent 但帶著 state.md 的下一步時仍然展開——
  // scanner.py:52-54 刻意讓 absent 也抽得到 next_step，只看 tasks_status 會把那句話丟掉。
  // 注意反面不成立：next_step 為空**不代表**這個專案沒動靜（read_next_step 讀不到、
  // 沒有標記、標記落在前 20 行之外時都回空字串）。
  const speaks = (p: TasksProjectRow) => p.tasks_status !== "absent" || Boolean(p.next_step);
  const rows = data.projects.filter(speaks);
  const chips = data.projects.filter((p) => !speaks(p));

  // 讀不到的專案不併進總數也不當成 0（design §6.3）：它們單獨報「N 個讀不到」，
  // 否則整份摘要會把不可讀說成沒有。兩個計數都走 okCount，壞值算進「需要注意」而不是「沒有待辦」
  const total = data.projects.reduce((s, p) => s + (okCount(p) ?? 0), 0);
  const unreadable = data.projects.filter((p) => okCount(p) === null && p.tasks_status !== "absent").length;

  return (
    <>
      {head(
        <span className="tasks-sum">
          {t("overview.summary", { n: total })}
          {unreadable > 0 && (
            <span className="is-warn"> · {t("overview.summaryUnreadable", { n: unreadable })}</span>
          )}
        </span>,
      )}
      {rows.length > 0 && (
        <Group label={t("overview.groupInUse")} n={rows.length}>
          <div className="tasks-overview">
            {rows.map((p) => <ProjectRow key={p.path} p={p} onSelect={onSelect} t={t} />)}
          </div>
        </Group>
      )}
      {chips.length > 0 && (
        <Group label={t("overview.notUsing")} n={chips.length}>
          <div className="tov-chips">
            {chips.map((p) => (
              // 只做導覽，沒有副作用。第二層顯示空清單＋輸入框，
              // 資料夾要等使用者真的送出標題、sidecar 的 create_task 才逐層 mkdir
              <button className="tov-chip" key={p.path} title={p.path} onClick={() => onSelect(p.path)}>
                {p.name}
              </button>
            ))}
          </div>
        </Group>
      )}
    </>
  );
}
