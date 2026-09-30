/* 顶栏那行"当前文档标题":有标题就显示、没有就收回、跟着当前作品走
 *
 * 2026-09-30 用户要求:「顶部应用标题栏 版本号后面间隔一点，增加显示当前文档标题，
 * 超过可用宽度自动省略」。
 *
 * 这一组钉的是**界面那一半**:
 *   1. 有标题 ⇒ 文本就是它、整块在(hidden 为 false);
 *   2. 没有标题(空串 / 只有空白)⇒ 整块收回并清成空串 ——
 *      留着上一件的标题比不显示更坏:用户会以为现在正在编辑那一件;
 *   3. 入口里没有这个 span 时安静返回(组件找不到容器是 `if (!label) return`,
 *      不是崩溃 —— 这一条要真的走一遍,免得往后挪元素时变成启动就报错)。
 * "写不下就省略"那半边是纯 CSS,判在 tools/verify.mjs 的 4i,这里看不见。
 *
 * 标题的来源是 app.state.workTitle,由 store.applyToState 写入并广播 work:changed;
 * 这里不装 store,直接把状态摆好再调同步函数 —— 事件绑定那一条由 4i 静态守着。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = globalThis.window || {};
/* i18n 与 namespace 会碰 documentElement;editor 自己只碰 getElementById。
   `present` 控制那个 span"在不在",用来走一遍找不到容器的分支。 */
const label = { textContent: null, hidden: null };
let present = true;
globalThis.document = globalThis.document || {};
globalThis.document.documentElement = globalThis.document.documentElement || { dataset: {} };
globalThis.document.getElementById = (id) => (id === "app-title" && present ? label : null);

for (const file of ["app/core/namespace.js", "app/core/utils.js", "app/core/i18n.js",
  "app/features/editor.js"]) {
  new Function(fs.readFileSync(path.join(root, file), "utf8"))();
}

const app = globalThis.window.posegi;
const editor = app.features.editor;

/* ---------- 1) 有标题:文本就是它,整块在 ---------- */
{
  app.state.workTitle = "一个女孩举着雨伞";
  editor.syncWorkTitle();
  assert.equal(label.textContent, "一个女孩举着雨伞", "顶栏要显示当前文档的标题");
  assert.equal(label.hidden, false, "有标题时整块必须在(不是 hidden)");
}

/* ---------- 2) 没有标题:整块收回,并且不留上一件的标题 ---------- */
{
  app.state.workTitle = "";
  editor.syncWorkTitle();
  assert.equal(label.hidden, true, "没有作品时标题块必须收回(用户要求的是'增加显示',不是凭空占位)");
  assert.equal(label.textContent, "", "收回时文本要是空串,而不是没清掉的旧标题");
}

/* ---------- 3) 只有空白也算没有(标题栏里一段空白看起来像渲染坏了) ---------- */
{
  app.state.workTitle = "   ";
  editor.syncWorkTitle();
  assert.equal(label.hidden, true, "标题只有空白时应当当作没有");
  assert.equal(label.textContent, "", "trim 之后才写进去,不许留下几个空格");
}

/* ---------- 4) 改名 / 换作品走的是同一个函数 ---------- */
{
  app.state.workTitle = "甲";
  editor.syncWorkTitle();
  assert.equal(label.textContent, "甲");
  app.state.workTitle = "甲改名";
  editor.syncWorkTitle();
  assert.equal(label.textContent, "甲改名", "改标题之后顶栏要跟上");
  assert.equal(label.hidden, false);
}

/* ---------- 5) 入口里没有这个 span:安静返回,不许抛 ---------- */
{
  present = false;
  app.state.workTitle = "入口里没有这个元素";
  editor.syncWorkTitle();
  present = true;
  assert.ok(true, "找不到 #app-title 时 syncWorkTitle 必须安静返回");
}

/* ---------- 6) 状态里没有 workTitle 这个字段(极早期的记录):也是"没有标题" ---------- */
{
  delete app.state.workTitle;
  editor.syncWorkTitle();
  assert.equal(label.hidden, true, "字段缺失时按'没有标题'处理,而不是显示 undefined");
  assert.equal(label.textContent, "");
  app.state.workTitle = "";
}

console.log("topbar-title.test.mjs: ok (有标题就显示、空/空白/缺字段都收回、改名跟上、找不到容器不抛)");
