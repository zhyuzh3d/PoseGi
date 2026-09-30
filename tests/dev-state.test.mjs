/* 设备端验收通道(宿主合同 window.haminnDevState)
 *
 * 2026-09-30 查出来的缺陷:`haminn_get_page_state` 读的是
 * `window.haminnDevState.capture()` —— 名字由宿主合同定死(haminnapp 的
 * docs/webapp-authoring.md「普通 happ 可按以下固定合同提供自己的恢复机制」),
 * 而本仓一直只挂了 `window.posegiDevState`。于是设备端拿到的 appState 恒为 null,
 * 整套读数**从来没生效过,而且不报任何错** —— 每次真机验收都以为"读到了",其实没有。
 *
 * 这类错只能靠一条断言守着:名字对不上 = 通道不存在。app.js 不能在 node 里加载
 * (它一落盘就会去碰 document 并启动),所以这里判源码 —— 判的是**行为符号**
 * (挂钩子、别名、capture 里报哪几段),不是格式。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "app/app.js"), "utf8");

/* 1) 合同名必须在 —— 少一个字母,设备端就读不到任何东西 */
assert.match(source, /window\.haminnDevState\s*=\s*\{/,
  "宿主合同读的是 window.haminnDevState;只挂别的名字时设备端 appState 恒为 null,而且不报错");

/* 2) 旧名字只能是**同一个对象**的别名 —— 两份读数迟早各说各话 */
assert.doesNotMatch(source, /window\.posegiDevState\s*=\s*\{/,
  "window.posegiDevState 不许是第二个对象字面量;它只能是 haminnDevState 的别名");
assert.match(source, /window\.posegiDevState\s*=\s*window\.haminnDevState\s*;/,
  "旧名字要留着当别名(guid.md 与历次真机脚本都按 posegiDevState 读),且必须指向同一个对象");

/* 3) capture() 里那几条验收通道必须在。
      每一条都对应用户提过的一次要求:作品文档(姿态/视口/模型/造型)与毛玻璃压暗。
      它们消失的方式都很安静 —— 界面照常,只是"再也证明不了"。 */
assert.match(source, /document:\s*app\.state\.document\s*\?/,
  "capture() 要报作品文档那四样(pose/view/modelId/figure):它是「装回来没」的唯一读数");
assert.match(source, /glass:\s*function\s*\(/,
  "capture() 要报毛玻璃读数(--glass-veil 与解析后的 background):两层背景一旦被内核丢掉,面板会变全透明而源码里一个字都没错");

/* 4) 毛玻璃那条读数必须是**解析之后**的值,不是回读变量名 ——
      回读 --glass-veil 只能证明「变量被定义了」,证明不了「内核认这条 background」。
      所以钉的是**赋值形式**:`style` 必须来自一次 `getComputedStyle(…)` 调用
      (钉"这个词出现在注释里"是没用的 —— 注释里本来就有)。 */
assert.match(source, /var\s+style\s*=\s*window\.getComputedStyle\s*\(/,
  "毛玻璃读数要拿 getComputedStyle(元素) 的结果当 style:它答的才是「这台机器认不认」");
assert.match(source, /backgroundImage:\s*String\(style\.backgroundImage/,
  "backgroundImage 那一项要取自 computed style 的返回值 —— 报一个空串或回读变量都不算量过");

/* 5) 探针必须挑**真的玻璃面**。
      2026-09-30 第一次部署时探针挑的是 `.topbar` —— 那只是一条透明的定位容器
      (`background: transparent`、也没有 backdrop-filter),玻璃卡片是它里面的
      `.topbar-card`。于是读数报的是"透明背景",看上去像"压暗没生效",
      而 CSS 那边一点问题都没有。判据因此不是"有没有挑元素",而是
      **挑的元素在 CSS 里确实是一条毛玻璃规则**。 */
{
  const start = source.indexOf("glass: function (");
  const end = source.indexOf("\n    },", start);
  assert.ok(start >= 0 && end > start, "找不到 capture() 里的毛玻璃读数那一块");
  const block = source.slice(start, end);
  const probes = [...block.matchAll(/document\.querySelector\("(\.[A-Za-z0-9_-]+)"\)/g)].map((match) => match[1]);
  assert.ok(probes.length >= 2, "毛玻璃读数应当按优先级试几个候选玻璃面,只写一个太脆");

  /* **先剥注释再解析**。这里踩过一次:components.css 那段"弹窗改毛玻璃"的注释里
     本来就有逗号,于是 `split(",")` 把注释也当选择器切了 —— `.modal-sheet` 解析出来
     带着一整段中文注释当前缀,前缀匹配全落空,于是门禁把一条**真带 backdrop-filter**
     的规则误判成"透明容器"。注释不是选择器,剥掉它才是根因所在。 */
  const heads = new Set();
  for (const rel of ["styles/base.css", "styles/components.css", "styles/viewport.css"]) {
    const css = fs.readFileSync(path.join(root, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.match(/\.[^{}]+\{[^{}]*\}/g) || []) {
      if (!/backdrop-filter\s*:/.test(rule)) continue;
      rule.slice(0, rule.indexOf("{")).split(",").forEach((head) => heads.add(head.trim()));
    }
  }
  assert.ok(heads.size >= 5, `只解析到 ${heads.size} 条毛玻璃规则,这条检查可能已经失效`);

  /* **每一个候选**都要是毛玻璃面,不能只要求"其中有一个是" ——
     querySelector 取的是第一个存在的那个,而 `.topbar` 这类透明容器**永远存在**,
     于是优先级最高的那个一旦写错,后面的候选写得再对也轮不到它。 */
  const dud = probes.filter((selector) => ![...heads].some((head) =>
    head === selector || head.indexOf(selector + ":") === 0 || head.indexOf(selector + ".") === 0 || head.indexOf(selector + " ") === 0));
  assert.equal(dud.join(" / "), "", "毛玻璃读数的候选元素里有不带 backdrop-filter 的:" + dud.join(" / ") +
    " —— 它会读到透明的定位容器,读出来像「压暗没生效」");
}

console.log("dev-state.test.mjs: ok (宿主合同名 haminnDevState、旧名只是别名、"
  + "capture 报作品文档与毛玻璃读数、读数是解析后的值、探针挑的是真的玻璃面)");
