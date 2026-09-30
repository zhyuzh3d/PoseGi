/* 历史成图:每一张右上角那个叉(删掉这一张,槽位跟着空出来)
 *
 * 2026-09-30 用户要求:「渲染,历史成图,每个图片右上角提供一个删除按钮,删掉这个图片,
 * 不占用 12 个槽位」。
 *
 * 为什么它值得一组测试 —— 这一格里有两个按钮叠在一起,而它们**长得都对**:
 *   · 叉没接线:按下去有反馈、什么都不发生(不报错);
 *   · 叉被塞进缩略图那个 button 里(非法嵌套):点击被外层吞掉,按叉变成全屏看图;
 *   · 两个按钮接了同一个动作:按叉也全屏看图,或者按图直接删;
 *   · "不占 12 个槽位"被实现成"界面上藏起来":槽位还占着,生成到第 13 张才发现。
 * 四条都不报错。这一组用一个**替身网格**把 renderResults 真跑一遍、把两个 onclick
 * 都取出来分别按一遍,所以断言打在"按下去到底发生了什么"上。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = globalThis.window || {};
for (const file of ["app/core/namespace.js", "app/core/utils.js", "app/core/i18n.js",
  "app/core/models.js", "app/assets/models/ikea.js", "app/core/rig.js", "app/core/ik.js",
  "app/features/poser.js", "app/features/editor.js"]) {
  new Function(fs.readFileSync(path.join(root, file), "utf8"))();
}

const app = globalThis.window.posegi;
const editor = app.features.editor;
app.rig.applyModel(app.models.get("ikea"));

/* 替身:这一组只关心"按下去发生了什么",不关心弹窗长什么样。
   ui.action 的替身直接返回原处理器 —— 真那一个只是包一层"按下时禁用按钮"。 */
const seen = { opened: [], removed: [], toasts: [], events: [], asked: 0, answer: true };
app.components.ui = {
  action: (handler) => handler,
  confirm: async () => { seen.asked += 1; return seen.answer; },
  toast: (message) => { seen.toasts.push(message); },
  sheetOpen: () => false,
  openSheet: () => {}
};
app.components.renderPreview = { open: (item) => { seen.opened.push(item); } };
app.services.store = { removeResult: async (id) => { seen.removed.push(id); } };
app.events.on("results:changed", (detail) => { seen.events.push(detail); });

function gridWith(list) {
  /* 只实现 renderResults 用到的那三件事:querySelector / innerHTML / querySelectorAll。
     querySelectorAll 按选择器分别返回"缩略图"和"右上角那个叉"两组替身按钮 ——
     于是两个 onclick 可以分别取出来按一遍。 */
  const buttons = {};
  return {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (!buttons[selector]) {
        buttons[selector] = [];
        for (let index = 0; index < list.length; index += 1) {
          const id = list[index].id;
          const dataset = selector === "[data-result]" ? { result: id } : { deleteResult: id };
          buttons[selector].push({ dataset, onclick: null });
        }
      }
      return buttons[selector];
    },
    buttons
  };
}

const photo = (id, time) => ({ id, src: "blob:posegi/" + id, prompt: "一个女孩", createdAt: time });
const content = (grid) => ({ querySelector: (selector) => (selector === "#result-grid" ? grid : null) });

/* 1) 画出来的那一段:每一格都是"缩略图 + 右上角的叉" */
{
  const list = [photo("r1", 1790000000000), photo("r2", 1790000100000)];
  app.state.results = list;
  const grid = gridWith(list);
  editor.renderResults(content(grid));

  assert.equal((grid.innerHTML.match(/class="result-cell"/g) || []).length, 2,
    "每一张成图外面要套一格 .result-cell(叉靠它定位在右上角)");
  assert.equal((grid.innerHTML.match(/class="result-thumb"/g) || []).length, 2, "两张缩略图");
  assert.equal((grid.innerHTML.match(/data-delete-result="/g) || []).length, 2, "两个删除钮");
  for (const item of list) {
    assert.ok(grid.innerHTML.includes('data-delete-result="' + item.id + '"'),
      `第 ${item.id} 张的删除钮要带着它自己的 id —— 带错了删的就是别人那张`);
    assert.ok(grid.innerHTML.includes('data-result="' + item.id + '"'), "缩略图带着自己的 id");
  }
  const cell = /<div class="result-cell">([\s\S]*?)<\/div>/.exec(grid.innerHTML);
  assert.ok(cell, "门禁失效:找不到 .result-cell 那一段");
  assert.match(cell[1], /<\/button>\s*<button class="result-delete"/,
    "叉必须是缩略图的**兄弟**(缩略图自己是个 button,里面再嵌一个 button 是非法结构)");
}

/* 2) 按缩略图 = 全屏看图 */
{
  const list = [photo("r1", 1790000000000), photo("r2", 1790000100000)];
  app.state.results = list;
  const grid = gridWith(list);
  editor.renderResults(content(grid));
  const thumbs = grid.querySelectorAll("[data-result]");
  assert.equal(typeof thumbs[0].onclick, "function", "缩略图必须挂了处理器");
  thumbs[1].onclick();
  assert.deepEqual(seen.opened, [list[1]], "点第二张 ⇒ 开的就是第二张");
  assert.deepEqual(seen.removed, [], "点图不许顺手把图删了");
  assert.equal(seen.asked, 0, "点图不需要问任何事");
}

/* 3) 按叉 = 先问一句,再从作品里摘掉(不是藏起来) */
{
  seen.opened = []; seen.removed = []; seen.toasts = []; seen.events = []; seen.asked = 0; seen.answer = true;
  const list = [photo("r1", 1790000000000), photo("r2", 1790000100000)];
  app.state.results = list;
  const grid = gridWith(list);
  editor.renderResults(content(grid));

  const crosses = grid.querySelectorAll("[data-delete-result]");
  assert.equal(typeof crosses[0].onclick, "function", "叉必须挂了处理器(没挂 = 按下去什么都不发生)");
  await crosses[0].onclick();

  assert.equal(seen.asked, 1, "删之前要问一句 —— 成图是本地唯一的一份");
  assert.deepEqual(seen.removed, ["r1"],
    "要真的走 store.removeResult(从作品里摘掉、顺手清理媒体字节)—— 界面上藏起来的话槽位还占着");
  assert.deepEqual(seen.opened, [], "按叉绝不该变成全屏看图");
  assert.deepEqual(seen.events, [{ id: "r1" }], "删完要报 results:changed(网格与计数都靠它重画)");
  assert.equal(seen.toasts.length, 1, "删完要说一声");
  assert.equal(app.state.results.length, 2, "这一层不许自己动状态 —— 摘掉是 store 的事");
}

/* 4) 在弹出的确认里点了取消 ⇒ 什么都不发生(只少问这一句都不算数) */
{
  seen.opened = []; seen.removed = []; seen.toasts = []; seen.events = []; seen.asked = 0; seen.answer = false;
  const list = [photo("r9", 1790000000000)];
  app.state.results = list;
  const grid = gridWith(list);
  editor.renderResults(content(grid));
  const result = await grid.querySelectorAll("[data-delete-result]")[0].onclick();

  assert.equal(seen.asked, 1, "取消之前当然要先问");
  assert.deepEqual(seen.removed, [], "取消之后一张都不许删");
  assert.deepEqual(seen.events, [], "没删就不许报 results:changed");
  assert.equal(result, false, "取消要如实返回 false(接在它后面的人靠这个判据)");
}

/* 5) 一张成图都没有:只有一句空提示,没有任何叉 */
{
  app.state.results = [];
  const grid = gridWith([]);
  editor.renderResults(content(grid));
  assert.match(grid.innerHTML, /empty-hint/, "没有成图时给一句空提示");
  assert.equal(/result-delete/.test(grid.innerHTML), false, "空的时候不该冒出删除钮");
  assert.equal(grid.querySelectorAll("[data-delete-result]").length, 0);
}

/* 6) 认不出的 id:问都不问就返回(它已经不在了,再弹一个确认框是噪音) */
{
  seen.asked = 0; seen.removed = [];
  app.state.results = [photo("r1", 1790000000000)];
  const result = await editor.removeResult("r-not-here");
  assert.equal(result, false, "找不到的那一张返回 false");
  assert.equal(seen.asked, 0, "找不到就不该问");
  assert.deepEqual(seen.removed, [], "更不该去删");
}

console.log("result-delete.test.mjs: ok (一格 = 缩略图 + 兄弟叉、按图看、按叉问过再删、"
  + "取消不删、空网格没有叉、认不出的 id 不惊动任何人)");
