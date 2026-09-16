// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import i18n from "../i18n";
import en from "../locales/en/tasks.json";
import type { TaskRow, TasksOverview as TasksOverviewData, TasksProjectRow } from "../lib/sidecar";
import { TasksOverview, collectHighlights } from "./TasksOverview";

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, { ns: "tasks", ...o }) as string;
const ticket = (over: Partial<TaskRow> = {}): TaskRow => ({
  name: "01-a.md", number: 1, title: "t", status: "todo", source: "me", created: "2026-09-10",
  anomalies: [], fingerprint: "f", path: "/p/a/.fledge/tasks/01-a.md", body: "", editable: true, ...over,
});
const proj = (over: Partial<TasksProjectRow> = {}): TasksProjectRow => ({
  path: "/p/a", name: "a", account: "work", unfinished: 1, doing: 0, parked: 0,
  doing_tasks: [], recent_tasks: [], tasks_status: "ok", next_step: "", ...over,
});
const data = (projects: TasksProjectRow[], recent_days = 7): TasksOverviewData => ({ projects, permission_error: false, recent_days });

describe("collectHighlights", () => {
  it("進行中照 payload 順序串接、不自己排；讀不到的專案跳過", () => {
    const { doing } = collectHighlights([
      proj({ path: "/p/b", name: "b", doing_tasks: [ticket({ name: "09-x.md", number: 9 })] }),
      proj({ path: "/p/a", name: "a", doing_tasks: [ticket({ name: "02-y.md", number: 2 })] }),
      proj({ path: "/p/c", name: "c", tasks_status: "unavailable", doing_tasks: null, recent_tasks: null }),
    ]);
    expect(doing.map((x) => `${x.project.name}/${x.task.number}`)).toEqual(["b/9", "a/2"]);
  });

  it("最近新增合併後 created 降冪；同日維持 payload 順序（專案順序→編號）", () => {
    const { recent } = collectHighlights([
      proj({ path: "/p/b", name: "b", recent_tasks: [ticket({ number: 5, created: "2026-09-12" }), ticket({ number: 7, created: "2026-09-09" })] }),
      proj({ path: "/p/a", name: "a", recent_tasks: [ticket({ number: 1, created: "2026-09-12" }), ticket({ number: 3, created: "2026-09-13" })] }),
    ]);
    expect(recent.map((x) => `${x.project.name}/${x.task.number}`)).toEqual(["a/3", "b/5", "a/1", "b/7"]);
  });
});

describe("TasksOverview（所有專案頁）", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); });
  afterEach(cleanup);

  it("兩段標頭、天數插值來自 payload、每列帶專案標籤；點列回呼專案與檔名", () => {
    const onSelect = vi.fn();
    const { container, getByText } = render(<TasksOverview data={data([
      proj({ path: "/p/a", name: "a", doing_tasks: [ticket({ name: "02-d.md", number: 2, status: "doing", title: "doing one" })],
        recent_tasks: [ticket({ name: "04-r.md", number: 4, title: "recent one", created: "2026-09-12" })] }),
    ], 10)} failed={false} onSelect={onSelect} t={t} />);
    expect(getByText(en.overview.doingAll)).toBeTruthy();
    expect(getByText(en.overview.recent.replace("{{days}}", "10"))).toBeTruthy();
    expect([...container.querySelectorAll(".tk-proj")].map((x) => x.textContent)).toEqual(["a", "a"]);
    fireEvent.click(getByText("recent one"));
    expect(onSelect).toHaveBeenCalledWith("/p/a", "04-r.md");
  });

  it("兩段都空時各畫一句空狀態，標頭仍在", () => {
    const { getByText } = render(<TasksOverview data={data([proj()])} failed={false} onSelect={() => {}} t={t} />);
    expect(getByText(en.overview.noDoing)).toBeTruthy();
    expect(getByText(en.overview.noRecent)).toBeTruthy();
    expect(getByText(en.overview.doingAll)).toBeTruthy();
  });

  it("列上沒有動作鍵、記號不是按鈕", () => {
    const { container } = render(<TasksOverview data={data([
      proj({ doing_tasks: [ticket({ status: "doing" })] }),
    ])} failed={false} onSelect={() => {}} t={t} />);
    expect(container.querySelector(".tk-acts")).toBeNull();
    expect(container.querySelector("button.tk-mark")).toBeNull();
    expect(container.querySelector("span.tk-mark.is-doing")).not.toBeNull();
  });

  it("頁首：標題是所有專案，摘要含未完成總數與讀不到數", () => {
    const { container } = render(<TasksOverview data={data([
      proj({ unfinished: 2 }),
      proj({ path: "/p/c", name: "c", tasks_status: "unavailable", unfinished: null, doing: null, parked: null, doing_tasks: null, recent_tasks: null }),
    ])} failed={false} onSelect={() => {}} t={t} />);
    expect(container.querySelector(".tasks-head h1")?.textContent).toBe(en.tree.allProjects);
    const sum = container.querySelector(".tasks-sum")?.textContent ?? "";
    expect(sum).toContain(en.overview.summary.replace("{{n}}", "2"));
    expect(sum).toContain(en.overview.summaryUnreadable.replace("{{n}}", "1"));
  });

  it("failed／loading／沒有專案三種狀態", () => {
    const a = render(<TasksOverview data={null} failed onSelect={() => {}} t={t} />);
    expect(a.getByText(en.overview.loadError)).toBeTruthy();
    cleanup();
    const b = render(<TasksOverview data={null} failed={false} onSelect={() => {}} t={t} />);
    expect(b.getByText(en.overview.loading)).toBeTruthy();
    cleanup();
    const c = render(<TasksOverview data={data([])} failed={false} onSelect={() => {}} t={t} />);
    expect(c.getByText(en.overview.empty)).toBeTruthy();
  });
});
