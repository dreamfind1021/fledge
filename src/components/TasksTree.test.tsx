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
// 未開待辦預設收起（2026-10-19 spec §4.3）：要看那一組的測試先點收合鈕
const toggle = (c: HTMLElement) => c.querySelector(".tree-grp.is-toggle") as HTMLElement | null;
const names = (c: HTMLElement) => [...c.querySelectorAll(".tree-item:not(.is-all) .tree-name")].map((x) => x.textContent);

describe("TasksTree", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); });
  afterEach(cleanup);

  it("分兩組：有話要說的在使用中，absent 且沒下一步的在未開待辦；順序照 payload", () => {
    const { container } = render(<TasksTree data={data([
      proj({ path: "/p/z", name: "z" }),
      proj({ path: "/p/n", name: "n", tasks_status: "absent", unfinished: 0, next_step: "" }),
      proj({ path: "/p/m", name: "m", tasks_status: "absent", unfinished: 0, next_step: "go" }),
    ])} selected={null} onSelect={() => {}} t={t} />);
    fireEvent.click(toggle(container)!);
    expect(names(container)).toEqual(["z", "m", "n"]);            // 使用中 z、m；未開待辦 n
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

  // 填充長度＝n／10、10 張以上畫滿（2026-10-19 spec §4.4，取代 spec §11.6 的「n／樹上最大值」）；進行中段＝d／n；擱置槽每列都在
  it("軌道：填充寬＝n／10、進行中段＝d／n、數字在軌道裡、擱置槽每列都在", () => {
    const { container } = render(<TasksTree data={data([
      proj({ path: "/p/a", name: "a", unfinished: 4, doing: 1, parked: 2 }),
      proj({ path: "/p/b", name: "b", unfinished: 2 }),
    ])} selected={null} onSelect={() => {}} t={t} />);
    const [a, b] = [...container.querySelectorAll(".tree-item:not(.is-all)")];
    expect((a.querySelector(".tree-fill") as HTMLElement).style.width).toBe("40%");
    expect((b.querySelector(".tree-fill") as HTMLElement).style.width).toBe("20%");
    expect((a.querySelector(".tree-doing") as HTMLElement).style.width).toBe("25%");
    expect(b.querySelector(".tree-doing")).toBeNull();
    expect(a.querySelector(".tree-trk .tree-num")?.textContent).toBe("4");
    expect(a.querySelector(".tree-n .pk")?.textContent).toBe("+2");
    expect(b.querySelector(".tree-n .pk")?.textContent).toBe("");            // 槽在、是空的
  });

  it("0 張：不畫軌道、只寫 0；讀不到、absent、ok 但壞值都不影響別人的寬度", () => {
    const { container } = render(<TasksTree data={data([
      proj({ path: "/p/a", name: "a", unfinished: 2 }),
      proj({ path: "/p/z", name: "z", unfinished: 0 }),
      proj({ path: "/p/c", name: "c", tasks_status: "unavailable", unfinished: null, doing: null, parked: null, doing_tasks: null, recent_tasks: null }),
      proj({ path: "/p/d", name: "d", unfinished: 9.5 }),          // ok 但壞值 → 讀不到
      proj({ path: "/p/m", name: "m", tasks_status: "absent", unfinished: 0, next_step: "go" }),
    ])} selected={null} onSelect={() => {}} t={t} />);
    const row = (name: string) => [...container.querySelectorAll(".tree-item")].find((x) => x.querySelector(".tree-name")?.textContent === name)!;
    expect((row("a").querySelector(".tree-fill") as HTMLElement).style.width).toBe("20%");
    expect(row("z").querySelector(".tree-trk")).toBeNull();
    expect(row("z").querySelector(".tree-n")?.textContent).toBe("0");
    expect(row("m").querySelector(".tree-n")).toBeNull();
  });

  // 一個專案很大時（200 張），小專案照樣是 n／10：舊版以最大值為滿格，小專案全被最短長度撐成一樣長（2026-10-19 spec §1 第 4 點）
  it("別的專案再大也不影響自己的寬度：200 張旁邊的 1 張是 10%，數字照寫", () => {
    const { container } = render(<TasksTree data={data([
      proj({ path: "/p/a", name: "a", unfinished: 200 }),
      proj({ path: "/p/b", name: "b", unfinished: 1 }),
    ])} selected={null} onSelect={() => {}} t={t} />);
    const b = [...container.querySelectorAll(".tree-item:not(.is-all)")][1];
    expect((b.querySelector(".tree-fill") as HTMLElement).style.width).toBe("10%");
    expect(b.querySelector(".tree-num")?.textContent).toBe("1");
  });
  it("10 張畫滿", () => {
    const { container } = render(<TasksTree data={data([proj({ unfinished: 10 })])} selected={null} onSelect={() => {}} t={t} />);
    expect((container.querySelector(".tree-fill") as HTMLElement).style.width).toBe("100%");
  });
  it("10 張以上也是畫滿", () => {
    const { container } = render(<TasksTree data={data([proj({ unfinished: 47 })])} selected={null} onSelect={() => {}} t={t} />);
    expect((container.querySelector(".tree-fill") as HTMLElement).style.width).toBe("100%");
  });

  // 擱置的 +N 滑過時寫出是什麼（2026-10-19 spec §4.4）：字串來自真的 catalog
  it("擱置提示（英文）：滑到 +N 上寫出幾張擱置", () => {
    const { container } = render(<TasksTree data={data([proj({ parked: 2 })])} selected={null} onSelect={() => {}} t={t} />);
    expect(container.querySelector(".tree-n .pk")?.getAttribute("title")).toBe("2 parked");
  });
  it("擱置提示（中文）：滑到 +N 上寫出幾張擱置", async () => {
    await i18n.changeLanguage("zh-TW");
    const { container } = render(<TasksTree data={data([proj({ parked: 2 })])} selected={null} onSelect={() => {}} t={t} />);
    expect(container.querySelector(".tree-n .pk")?.getAttribute("title")).toBe("2 張擱置");
  });
  it("沒有擱置時沒有提示", () => {
    const { container } = render(<TasksTree data={data([proj({ parked: 0 })])} selected={null} onSelect={() => {}} t={t} />);
    expect(container.querySelector(".tree-n .pk")?.hasAttribute("title")).toBe(false);
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

// 未開待辦收成一行、預設收起（2026-10-19 spec §4.3）
describe("TasksTree：未開待辦收合", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); });
  afterEach(cleanup);
  const IDLE = [
    proj({ path: "/p/z", name: "z" }),
    proj({ path: "/p/n", name: "n", tasks_status: "absent", unfinished: 0, next_step: "" }),
    proj({ path: "/p/o", name: "o", tasks_status: "absent", unfinished: 0, next_step: "" }),
  ];
  const tree = (selected: string | null = null, asPage = false) =>
    render(<TasksTree data={data(IDLE)} selected={selected} onSelect={() => {}} t={t} asPage={asPage} />).container;

  it("預設收起：未開待辦的專案都不在", () => expect(names(tree())).toEqual(["z"]));
  it("收合鈕寫出個數", () => expect(toggle(tree())?.textContent).toBe(`${en.overview.notUsing}2`));
  it("點了展開：全部出現、順序照 payload", () => {
    const c = tree();
    fireEvent.click(toggle(c)!);
    expect(names(c)).toEqual(["z", "n", "o"]);
  });
  it("再點一次收起", () => {
    const c = tree();
    fireEvent.click(toggle(c)!);
    fireEvent.click(toggle(c)!);
    expect(names(c)).toEqual(["z"]);
  });
  it("展開時 aria-expanded 是 true", () => {
    const c = tree();
    fireEvent.click(toggle(c)!);
    expect(toggle(c)?.getAttribute("aria-expanded")).toBe("true");
  });
  it("選中的專案屬於未開待辦時，收起狀態也顯示它", () => expect(names(tree("/p/o"))).toEqual(["z", "o"]));
  it("沒有未開待辦時沒有收合鈕", () => {
    const { container } = render(<TasksTree data={data([IDLE[0]])} selected={null} onSelect={() => {}} t={t} />);
    expect(toggle(container)).toBeNull();
  });
  it("攤成一頁的樹一樣預設收起", () => expect(names(tree(null, true))).toEqual(["z"]));
});
