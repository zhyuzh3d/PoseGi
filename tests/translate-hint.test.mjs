/* 译英在界面上**唯一的残留**:提示词输入框 label 上那一句
 * 「（请使用英文,或软件设置中增加翻译模型）」
 *
 * 2026-09-30 用户定稿:「如果模型需要翻译为英文,那么,如果配置了翻译模型,每次提交的时候
 * PoseGi 就自动使用这个翻译模型进行翻译,然后缓存备用避免下次同样内容重复调用模型翻译,
 * 把翻译结果直接发给生图模型使用;如果没有配置翻译模型,就在提示词输入框添加（请使用英文,
 * 或软件设置中增加翻译模型）。这样就可以去掉所有其他界面上的翻译按钮和输入框。」
 *
 * 这一组钉三件事,三件都曾经是"界面上看不出来"的坏法:
 *   1. **这一层只剩一句话** —— 没有输入框、没有按钮、没有 mount。它悄悄长回一个框不会报错,
 *      而那个框与"提交时自动翻译"是两条会打架的路径(用户手改的英文 vs 自动翻的英文,
 *      到底哪一份发出去,从画面上根本看不出来);
 *   2. **出现条件两条都成立才出**:机制不在(卡不用英文 / 英文界面)就不提;
 *      译英服务配好了也不提 —— 那时翻译是自动的,再喊一句"请使用英文"只会让人以为要手动做;
 *   3. **两种界面语言下都有那一句**,而且各自是各自的语言(切到英文只看到半句中文最像坏了)。
 *
 * 判据本身(relevant / ready 怎么算)不在这里 —— 归 tests/translate.test.mjs;
 * 提交那一刻自动翻那一路归 tests/image-engine.test.mjs。这里测的是**界面这一侧**。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = globalThis.window || {};
/* i18n 的 setLanguage 会写 documentElement.lang —— 给个壳就够;
   这一组要在**两种界面语言下**各走一遍。 */
globalThis.document = globalThis.document || {};
globalThis.document.documentElement = globalThis.document.documentElement || { dataset: {} };

for (const file of ["app/core/namespace.js", "app/core/utils.js", "app/core/i18n.js",
  "app/components/translate-hint.js"]) {
  new Function(fs.readFileSync(path.join(root, file), "utf8"))();
}

const app = globalThis.window.posegi;
const hint = app.components.translateHint;

/* 替身:译英服务。这一层只用到两个判据 —— relevant(机制在不在)、ready(服务配没配好)。 */
let relevantNow = true;
let readyNow = false;
app.services.translate = {
  relevant: () => relevantNow,
  ready: () => readyNow
};

/* ---------- 1) 这一层只剩一句话:没有输入框、没有按钮、没有 mount ---------- */
{
  assert.deepEqual(Object.keys(hint), ["labelHint"],
    "这一层只该导出 labelHint —— 多一个出口就是多一条会与自动翻译打架的路径");

  /* 抹掉注释再查:注释里正是要说明"这里曾经有输入框与按钮",那是历史,不是实现 */
  const source = fs.readFileSync(path.join(root, "app/components/translate-hint.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  for (const gone of ["input", "textarea", "button", "mount"]) {
    assert.equal(new RegExp(gone, "i").test(source), false,
      `translate-hint.js 里不该再有 ${gone} —— 译英的输入框与按钮都已经撤到提交那一步去了`);
  }

  const entry = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(entry.indexOf("./app/components/translate-hint.js") > 0,
    "入口要挂 translate-hint.js(少这一行,两个表单的 label 都拿不到那句提示)");
  assert.equal(entry.indexOf("translate-box.js"), -1,
    "入口里不许还挂着已被删掉的 translate-box.js");
}

/* ---------- 2) 出现条件:机制在 + 服务没配好,两条都成立才出 ---------- */
{
  relevantNow = true; readyNow = false;
  assert.ok(hint.labelHint().indexOf("请使用英文") > 0,
    "卡要英文 + 译英服务没配好 ⇒ label 上补一句「（请使用英文）」");
  assert.equal(hint.labelHint().charAt(0), "（",
    "提示要带括号、直接跟在 label 后面,不另起一段");
  assert.ok(hint.labelHint().indexOf("翻译模型") > 0,
    "还要告诉用户去哪儿解决 —— 只说「请使用英文」等于把问题丢回给他");

  readyNow = true;
  assert.equal(hint.labelHint(), "",
    "译英服务配好了 ⇒ 提交时会自动翻,label 不用再喊(否则每开一次弹窗都在催)");

  relevantNow = false; readyNow = false;
  assert.equal(hint.labelHint(), "", "卡不需要英文 ⇒ 整条机制都不在,label 更不该提");

  relevantNow = false; readyNow = true;
  assert.equal(hint.labelHint(), "", "机制不在 + 服务配好 ⇒ 同样不提");
}

/* ---------- 3) 两种界面语言下都有那一句,而且各自说各自的话 ---------- */
{
  relevantNow = true; readyNow = false;

  app.i18n.setLanguage("en");
  const en = hint.labelHint();
  assert.ok(/please use English/i.test(en), "英文界面下要给英文版提示(只留半句中文最像坏了)");
  assert.ok(/translation model/i.test(en), "英文版也要说清去哪儿解决");
  assert.equal(/[\u4e00-\u9fff]/.test(en), false, "英文界面下不许混着汉字");

  app.i18n.setLanguage("zh");
  const zh = hint.labelHint();
  assert.ok(zh.indexOf("请使用英文") > 0, "切回中文又该是中文那句");
  assert.notEqual(zh, en, "两种语言的提示不能是同一条文案");
}

console.log("translate-hint.test.mjs: ok (这一层只剩 labelHint 一句、"
  + "条件两条都成立才出、中英两版各说各的)");
