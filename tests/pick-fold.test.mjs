/* 选取弹窗:点选一个对象之后,下面那张关节列表收成一个小三角
 *
 * 2026-09-30 用户要求:「选取工具弹窗,改为点选对象后下面的列表折叠为一个小三角
 * (整个弹窗高度变小,只留下顶部按钮和滑竿,尽可能少遮挡画布)」。
 *
 * 为什么它值得一组测试:这条要求的全部内容都在**画出来的那一段 HTML** 上 ——
 *   · `hidden` 属性少写一处,收起的列表照样铺满一屏(网格是 display:grid,
 *     作者样式会盖过浏览器对 [hidden] 的默认处理);
 *   · 三角少画一次(比如只在展开时才画),收起之后**再也翻不回来**(弹窗背后那层
 *     backdrop 是"点一下就关掉弹窗"的,开着的时候点不到空白处取消选中);
 *   · `aria-expanded` 与方向图标跟着状态走,画面上是"箭头指着错的方向"。
 * 这三条全都不报错。而且状态必须活在模块里:面板每次选中变化都整块重画 innerHTML,
 * 状态挂在 DOM 上就会在下一次重画时丢掉(收起来之后自己又摊开)。
 *
 * 这一组用一个**替身面板**把 renderJointPanel 真跑一遍(它只用到 getElementById /
 * innerHTML / querySelectorAll 三件事),所以断言打在最终产物上,而不是打在源码字符串上。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = globalThis.window || {};
/* poser 与人物模型都要装上:面板上那三条滑杆的当前值是从它们那里读的
   (axisDelta → poser.angles() → rig 的表),没装的话 renderJointPanel 会当场抛 ——
   那正是"这一层真的跑到最终产物上、而不是只读源码字符串"的证明。 */
for (const file of ["app/core/namespace.js", "app/core/utils.js", "app/core/i18n.js",
  "app/core/models.js", "app/assets/models/ikea.js", "app/core/rig.js", "app/core/ik.js",
  "app/features/poser.js", "app/features/editor.js"]) {
  new Function(fs.readFileSync(path.join(root, file), "utf8"))();
}

const app = globalThis.window.posegi;
const editor = app.features.editor;
/* 骨架的尺寸与静止姿态来自人物模型 —— 不装的话整张角度表都是零 */
app.rig.applyModel(app.models.get("ikea"));

/* 替身面板:只要"能装 innerHTML、querySelectorAll 返回空表"就够 ——
   renderJointPanel 里那句 querySelectorAll 是用来挂 onclick 的,这里不需要它们跑。 */
const panel = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null };
globalThis.document = { getElementById: (id) => (id === "joint-panel" ? panel : null) };

function paint(folded, name) {
  editor.pickListFolded(folded);
  editor.renderJointPanel(name === undefined ? "hips" : name);
  return panel.innerHTML;
}

/* 1) 折叠状态:一条规则、一个持有者 */
{
  assert.equal(editor.pickListFolded(), false, "一进来是摊开的(还没点过任何对象)");
  assert.equal(editor.pickListFolded("hips"), true, "点了一个关节 ⇒ 收起");
  assert.equal(editor.pickListFolded(), true, "不带参数就是读 —— 读回来必须是刚写进去的那一份");
  assert.equal(editor.pickListFolded(!editor.pickListFolded()), false, "点三角再翻一次 ⇒ 摊开");
  assert.equal(editor.pickListFolded(""), false, "选中被清空 ⇒ 摊开(那时列表是唯一能做的事,收起来等于没入口)");
  assert.equal(editor.pickListFolded(null), false, "null 同上");
  assert.equal(editor.pickListFolded(0), false, "0 也是「没有选中」");
}

/* 2) 收起来那一段:网格带 hidden、三角朝下、aria-expanded=false */
{
  const html = paint(true);
  assert.match(html, /data-pick-toggle/, "三角必须画出来 —— 它是唯一能把列表翻回来的入口");
  assert.match(html, /aria-expanded="false"/, "收起时 aria-expanded 要是 false");
  assert.match(html, /fa-caret-down/, "收起时箭头朝下(指着「下面有东西可以拉出来」)");
  assert.match(html, /<div class="pick-grid" hidden>/,
    "收起时网格必须带 hidden 属性 —— 少了它,display:grid 会盖过浏览器默认的 [hidden]{display:none},列表照样铺满一屏");
  assert.equal(/<div class="pick-grid">/.test(html), false, "收起来的时候不许再画出一个不带 hidden 的网格");
  assert.match(html, /data-joint="/, "收起来只是藏起来:关节格子还在,翻回来不必重算数据");
  assert.match(html, /data-walk="parent"/, "顶上的三个按钮收起来也必须在(用户要的是「只留下顶部按钮和滑竿」)");
  assert.match(html, /data-axis="/, "滑杆也要留着(它是收起来之后唯一还能调的东西)");
}

/* 3) 摊开那一段:网格不带 hidden、三角朝上 */
{
  const html = paint(false);
  assert.match(html, /data-pick-toggle/, "摊开时三角也在(再点一下就能收起来)");
  assert.match(html, /aria-expanded="true"/, "摊开时 aria-expanded 要是 true");
  assert.match(html, /fa-caret-up/, "摊开时箭头朝上");
  assert.match(html, /<div class="pick-grid">/, "摊开时网格不带 hidden");
  assert.equal(/class="pick-grid" hidden/.test(html), false, "摊开时不许留着 hidden");
}

/* 4) 没有选中的关节时:三个按钮还在,列表照常(那正是"从列表里挑一个"的场景) */
{
  const html = paint(false, "");
  assert.match(html, /data-walk="parent"/, "没选中时三个方向按钮仍在");
  assert.match(html, /<div class="pick-grid">/, "没选中时必须摊开 —— 否则没有入口去选第一个关节");
  assert.equal(/joint-head/.test(html), false, "没选中就没有关节名那一行");
}

/* 5) 状态活在模块里,不挂在 DOM 上(面板每次重画都会换一整段 innerHTML) */
{
  editor.pickListFolded(true);
  editor.renderJointPanel("hips");
  editor.renderJointPanel("hips");
  assert.equal(editor.pickListFolded(), true, "重画两次之后仍然是收起的");
  assert.match(panel.innerHTML, /hidden/, "第二次画出来也必须是收起的");
  editor.pickListFolded(false);
}

console.log("pick-fold.test.mjs: ok (点选后收起、三角两态都在、收起时网格带 hidden、"
  + "没选中必须摊开、状态不随重画丢掉)");
