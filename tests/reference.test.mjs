/* 渲染参考图:形状、居中裁切、以及"谁把它裁成那样"
 *
 * 用户 2026-09-30 定的口径一共四句,这一组逐句钉住:
 *   1. **交付给大模型的参考图是 9:16、高度 1024**;
 *   2. 它是**画布那张图**裁出来的(不是重新取景、不是另渲一张);
 *   3. 裁切是**居中**的 —— 上下都裁掉一些,不是"保留顶部裁掉底部";
 *   4. 画布万一比 9:16 **宽**,要改成左右两侧各裁一条(同一个算法,两条分支)。
 *
 * 为什么值得单开一份:这一整条是**三段接力**(app.defaults.reference → app.js 的
 * captureReference → viewport.captureAt 的 frame → utils.centerCrop 的算术),
 * 而中间任何一段漏传参数都不报错 —— 图照样出来,只是比例不对,而 CHP 插件会用
 * `stretched_reference` 把那张图顶回来(真机实测过)。所以最后两条断言打的是
 * **段与段之间的接口**,不是任何一段自己。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = globalThis.window || {};
for (const file of ["app/core/namespace.js", "app/core/i18n.js", "app/core/utils.js",
  "app/services/providers.js", "app/services/render-adjust.js", "app/services/store.js"]) {
  new Function(fs.readFileSync(path.join(root, file), "utf8"))();
}

const app = globalThis.window.posegi;
const reference = app.defaults.reference;

/* 比例判据**借 providers 那一份**,不在这里另抄一个容差:
   两处各判一次的结果就是哪天改了一处、另一处开始说另一套话。 */
function ratioMatches(width, height) {
  return app.services.providers.internals.ratioMatches(width + "x" + height);
}

/* ---------- 1) 交出去的那张图:9:16、高度 1024 ---------- */
{
  assert.equal(app.defaults.ratio, "9:16", "宽高比锁死 9:16,而且只有一个出处");
  ["canvasWidth", "canvasHeight", "width", "height"].forEach((key) => {
    assert.ok(Number(reference[key]) > 0, `reference.${key} 必须是正数`);
  });
  assert.equal(reference.height, 1024, "最终交给大模型的参考图高度必须是 1024");
  assert.equal(reference.width, 576, "576x1024 是精确的 9:16;换别的宽度要连高度一起算");
  assert.ok(ratioMatches(reference.width, reference.height),
    `交出去的参考图必须正好是 ${app.defaults.ratio},收到 ${reference.width}x${reference.height}`);

  /* 画布本身**比 9:16 略高**:留出来的那点余量正是"居中裁"要吃掉的部分。
     写成 canvasHeight <= height 的话裁切那一段就变成空操作,而没人会察觉。 */
  assert.ok(reference.canvasHeight > reference.height,
    "画布必须比成品高一点,否则裁切无从发生(这一段就白测了)");
  assert.equal(reference.canvasWidth, reference.width, "横向不留余量:余量给竖向,好让裁切落在上下两条");
}

/* ---------- 2) 居中裁切:两条边各裁一半 ---------- */
{
  const crop = app.utils.centerCrop;
  assert.equal(typeof crop, "function", "居中裁切是纯算术,必须挂在 core/utils 上才测得到");

  const vertical = crop(reference.canvasWidth, reference.canvasHeight, reference.width, reference.height);
  assert.equal(vertical.outWidth, reference.width, "输出尺寸就是请求的那一对(宽)");
  assert.equal(vertical.outHeight, reference.height, "输出尺寸就是请求的那一对(高)");
  assert.equal(vertical.width, reference.width, "横向没有余量,取满");
  assert.equal(vertical.height, reference.height, "取景框的高度就是成品高度");
  /* **这条是"居中"与本轮推翻的"保留顶部"之间唯一的分界**:上下两条要一样宽。
     改成 y = 0 就说明退回"裁掉底部"了 —— 而那时这条断言会红。 */
  assert.equal(vertical.y, 28, `画布 ${reference.canvasHeight} 裁到 ${reference.height},上边应去掉 28 行`);
  assert.equal(vertical.y + vertical.height + vertical.y, reference.canvasHeight,
    "上下裁掉的量必须相等(居中),不是只裁下面");

  /* 画布换成横向富余(比 9:16 宽)⇒ 改裁左右,上下不动 */
  const horizontal = crop(1200, 1024, 576, 1024);
  assert.equal(horizontal.y, 0, "画布与目标同高,竖向不该再有裁切");
  assert.ok(horizontal.x > 0, `画布比 9:16 宽时要裁左右,收到 x=${horizontal.x}`);
  assert.equal(horizontal.x * 2 + horizontal.width, 1200, "左右两侧裁掉的量必须相等(居中)");
  assert.ok(ratioMatches(horizontal.width, horizontal.height),
    `裁出来的框必须仍是 ${app.defaults.ratio},收到 ${horizontal.width}x${horizontal.height}`);

  /* 画布与目标同比 ⇒ 一整张,哪边都不裁(不能凭空切掉一条) */
  const same = crop(576, 1024, 576, 1024);
  assert.deepEqual([same.x, same.y, same.width, same.height], [0, 0, 576, 1024], "同比例时原样取整张");

  /* 奇数差固定给上/左:同一个输入永远同一个输出,否则这条断言就没法写 */
  assert.equal(crop(576, 1025, 576, 1024).y, 1, "多出来的那一行固定给上边");
  assert.equal(crop(577, 1024, 576, 1024).x, 1, "多出来的那一列固定给左边");

  /* 尺寸不合法要当场说,而不是返回一个 0 宽度的框(那会画出一张空白图) */
  assert.throws(() => crop(0, 1080, 576, 1024), /正数/);
  assert.throws(() => crop(576, 1080, 0, 1024), /正数/);
}

/* ---------- 3) 段与段之间的接口 ----------
   三段各自都对、接口漏传参数,是这一整类问题的标准死法:图照样出得来,只是没裁过。
   所以这里读的是**真正传下去的表达式**,不是默认值自己。 */
{
  const appSource = fs.readFileSync(path.join(root, "app/app.js"), "utf8");
  assert.match(appSource, /frame:\s*\{\s*width:\s*reference\.width,\s*height:\s*reference\.height\s*\}/,
    "app.js 必须把 reference 的 width/height 当 frame 传下去,否则裁切整段是空转");
  assert.match(appSource, /captureAt\(reference\.canvasWidth,\s*reference\.canvasHeight,/,
    "画布尺寸要按 reference 渲,不能用成品的尺寸去渲(那样就没有可裁的余量了)");
  assert.match(appSource, /capture:\s*captureReference/,
    "生图链路接到的是 captureReference;接回旧函数就等于绕过裁切");

  const viewportSource = fs.readFileSync(path.join(root, "app/components/viewport.js"), "utf8");
  assert.match(viewportSource, /frame\s*=\s*options\.frame;/,
    "captureAt 要从 options 里取 frame");
  assert.match(viewportSource, /app\.utils\.centerCrop\(/, "裁切走的是 core 的那一份算术");
  /* 返回的尺寸必须是**裁完之后**的:调用方(与设备自检)拿它当"最终发给模型的是什么" */
  assert.match(viewportSource, /outputWidth\s*=\s*box\.outWidth;/, "返回值要报裁完之后的宽");
  assert.match(viewportSource, /outputHeight\s*=\s*box\.outHeight;/, "返回值要报裁完之后的高");
}

console.log("reference.test.mjs: ok (9:16 与高度 1024、居中裁上下、横向富余改裁左右、"
  + "奇数差固定给上/左、非法尺寸当场拒、三段接口的传参)");
