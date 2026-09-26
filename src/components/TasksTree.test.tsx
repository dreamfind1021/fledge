// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "../i18n";
import en from "../locales/en/tasks.json";
import type { TasksOverview, TasksProjectRow } from "../lib/sidecar";
import { TasksTree } from "./TasksTree";

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, { ns: "tasks", ...o }) as string;
const proj = (over: Partial<TasksProjectRow> = {}): TasksProjectRow => ({
  path: "/p/a", name: "a", account: "work", unfinished: 1, doing: 0, parked: 0,
  doing_tasks: [], recent_tasks: [], tasks_status: "ok", next_step: "", ...over,
});
const data = (projects: TasksProjectRow[]): TasksOverview => ({ projects, permission_error: false, recent_days: 7 });

describe("TasksTree", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); });
  afterEach(cleanup);

  it("分兩組：有話要說的在使用中，absent 且沒下一步的在未開待辦；順序照 payload", () => {
    const { container } = render(<TasksTree data={data([
      proj({ path: "/p/z", name: "z" }),
      proj({ path: "/p/n", name: "n", tasks_status: "absent", unfinished: 0, next_step: "" }),
      proj({ path: "/p/m", name: "m", tasks_status: "absent", unfinished: 0, next_step: "go" }),
    ])} selected={null} onSelect={() => {}} t={t} />);
    const names = [...container.querySelectorAll(".tree-item:not(.is-all) .tree-name")].map((x) => x.textContent);
    expect(names).toEqual(["z", "m", "n"]);                       // 使用中 z、m；未開待辦 n
    expect(container.querySelector(".tree-item.is-dim .tree-name")?.textContent).toBe("n");
  });

  it("數字三向分支：ok 畫數字、absent 不畫、其餘畫讀不到", () => {
    const { container } = render(<TasksTree data={data([
      proj({ path: "/p/a", name: "a", unfinished: 3 }),
      proj({ path: "/p/b", name: "b", tasks_status: "absent", unfinished: 0, next_step: "x" }),
      proj({ path: "/p/c", name: "c", tasks_status: "unavailable", unfinished: null, doing: null, parked: null, doing_tasks: null, recent_tasks: null }),
      proj({ path: "/p/d", name: "d", unfinished: -1 }),          // ok 但壞值 → 警告，不是 0
    ])} selected={null} onSelect={() => {}} t={t} />);
    const row = (name: string) => [...container.querySelectorAll(".tree-item")].find((x) => x.querySelector(".tree-name")?.textContent === name)!;
    expect(row("a").querySelector(".tree-n")?.textContent).toBe("3");
    expect(row("b").querySelector(".tree-n")).toBeNull();
    expect(row("c").querySelector(".tree-una")?.textContent).toBe(en.overview.unavailable);
    expect(row("d").querySelector(".tree-una")).not.toBeNull();
  });

  // spec §11.6：填充長度＝n／樹上最大值；進行中段＝d／n；擱置槽每列都在
  it("軌道：填充寬＝n／最大值、進行中段＝d／n、數字在軌道裡、擱置槽每列都在", () => {
    const { container } = render(<TasksTree data={data([
      proj({ path: "/p/a", name: "a", unfinished: 4, doing: 1, parked: 2 }),
      proj({ path: "/p/b", name: "b", unfinished: 2 }),
    ])} selected={null} onSelect={() => {}} t={t} />);
    const [a, b] = [...container.querySelectorAll(".tree-item:not(.is-all)")];
    expect((a.querySelector(".tree-fill") as HTMLElement).style.width).toBe("100%");
    expect((b.querySelector(".tree-fill") as HTMLElement).style.width).toBe("50%");
    expect((a.querySelector(".tree-doing") as HTMLElement).style.width).toBe("25%");
    expect(b.querySelector(".tree-doing")).toBeNull();
    expect(a.querySelector(".tree-trk .tree-num")?.textContent).toBe("4");
    expect(a.querySelector(".tree-n .pk")?.textContent).toBe("+2");
    expect(b.querySelector(".tree-n .pk")?.textContent).toBe("");            // 槽在、是空的
  });

  it("0 張：不畫軌道、只寫 0；最大值只看有數字的列（讀不到、absent、ok 但壞值都不算）", () => {
    const { container } = render(<TasksTree data={data([
      proj({ path: "/p/a", name: "a", unfinished: 2 }),
      proj({ path: "/p/z", name: "z", unfinished: 0 }),
      proj({ path: "/p/c", name: "c", tasks_status: "unavailable", unfinished: null, doing: null, parked: null, doing_tasks: null, recent_tasks: null }),
      proj({ path: "/p/d", name: "d", unfinished: 9.5 }),          // ok 但壞值 → 讀不到；比 a 大，天真的 max 會把它算進去
      proj({ path: "/p/m", name: "m", tasks_status: "absent", unfinished: 0, next_step: "go" }),
    ])} selected={null} onSelect={() => {}} t={t} />);
    const row = (name: string) => [...container.querySelectorAll(".tree-item")].find((x) => x.querySelector(".tree-name")?.textContent === name)!;
    expect((row("a").querySelector(".tree-fill") as HTMLElement).style.width).toBe("100%");
    expect(row("z").querySelector(".tree-trk")).toBeNull();
    expect(row("z").querySelector(".tree-n")?.textContent).toBe("0");
    expect(row("m").querySelector(".tree-n")).toBeNull();
  });

  // Review Focus 2：一個專案很大時，小專案的填充照比例很小，最小寬交給 CSS 的 min-width（layout 測試守）
  it("最大值 200、自己 1 張 → 填充 0.5%（最小寬由 CSS 保證），數字照寫", () => {
    const { container } = render(<TasksTree data={data([
      proj({ path: "/p/a", name: "a", unfinished: 200 }),
      proj({ path: "/p/b", name: "b", unfinished: 1 }),
    ])} selected={null} onSelect={() => {}} t={t} />);
    const b = [...container.querySelectorAll(".tree-item:not(.is-all)")][1];
    expect((b.querySelector(".tree-fill") as HTMLElement).style.width).toBe("0.5%");
    expect(b.querySelector(".tree-num")?.textContent).toBe("1");
  });

  // runtime JSON 沒驗證。doing 只有 0..n 的整數才算（doing 是 unfinished 的子集，超過 n 代表資料壞了）；
  // 壞值只退拆分、不把整列降級成警告，數字與頂端總數照舊來自 unfinished（spec §11.6 第 3、4 點）。
  // 1.5、"2"、5（> n）是會分辨的：天真的 `(d ?? 0) > 0` 對它們都會畫出進行中段
  it.each([
    ["-1", -1],
    ["null", null],
    ["非整數 1.5", 1.5],
    ["字串 \"2\"", "2" as unknown as number],
    ["大於未完成數 5", 5],
  ])("doing／parked 壞值 %s → 不畫進行中段、擱置槽空的，數字與總數不變", (_label, bad) => {
    const { container } = render(<TasksTree data={data([
      proj({ path: "/p/a", name: "a", unfinished: 3, doing: bad, parked: bad === 5 ? -1 : bad }),
    ])} selected={null} onSelect={() => {}} t={t} />);
    const a = container.querySelector(".tree-item:not(.is-all)")!;
    expect(a.querySelector(".tree-doing")).toBeNull();
    expect(a.querySelector(".tree-n .pk")?.textContent).toBe("");
    expect(a.querySelector(".tree-num")?.textContent).toBe("3");
    expect(a.querySelector(".tree-una")).toBeNull();
    expect(container.querySelector(".tree-head .s")?.textContent).toBe(en.overview.summary.replace("{{n}}", "3"));
  });

  it("所有專案在最上面；selected 為 null 時它反白，否則對應專案反白", () => {
    const { container, rerender } = render(<TasksTree data={data([proj()])} selected={null} onSelect={() => {}} t={t} />);
    const all = container.querySelector(".tree-item.is-all")!;
    expect(all.textContent).toContain(en.tree.allProjects);
    expect(all.classList.contains("active")).toBe(true);
    rerender(<TasksTree data={data([proj()])} selected="/p/a" onSelect={() => {}} t={t} />);
    expect(container.querySelector(".tree-item.is-all")!.classList.contains("active")).toBe(false);
    expect([...container.querySelectorAll(".tree-item.active .tree-name")].map((x) => x.textContent)).toEqual(["a"]);
  });

  it("點專案回呼路徑、點所有專案回呼 null", () => {
    const onSelect = vi.fn();
    render(<TasksTree data={data([proj()])} selected="/p/a" onSelect={onSelect} t={t} />);
    fireEvent.click(screen.getByText("a"));
    expect(onSelect).toHaveBeenLastCalledWith("/p/a");
    fireEvent.click(screen.getByText(en.tree.allProjects));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("頂端摘要：未完成總數只加 ok 的；讀不到另計", () => {
    const { container } = render(<TasksTree data={data([
      proj({ path: "/p/a", name: "a", unfinished: 2 }),
      proj({ path: "/p/c", name: "c", tasks_status: "unavailable", unfinished: null, doing: null, parked: null, doing_tasks: null, recent_tasks: null }),
    ])} selected={null} onSelect={() => {}} t={t} />);
    const s = container.querySelector(".tree-head .s")?.textContent ?? "";
    expect(s).toContain(en.overview.summary.replace("{{n}}", "2"));
    expect(s).toContain(en.overview.summaryUnreadable.replace("{{n}}", "1"));
  });

  it("data 為 null 時只畫頂端與所有專案，不炸", () => {
    const { container } = render(<TasksTree data={null} selected={null} onSelect={() => {}} t={t} />);
    expect(container.querySelector(".tree-item.is-all")).not.toBeNull();
    expect(container.querySelectorAll(".tree-item").length).toBe(1);
  });
});
