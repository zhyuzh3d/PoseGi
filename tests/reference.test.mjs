/* 渲染参考图:形状、居中裁切、投影换幅、以及"谁把它裁成那样"
 *
 * 2026-10-01 起交出去的**不是 3D 截图,而是一张彩色骨架图**(理由见 app/core/skeleton.js
 * 的头注释:Qwen-Image 2.1 那条路上参考图就是控制图,而它长什么样决定了被当成什么)。
 * 但尺寸口径一字未变,用户 2026-09-30 定的四句仍然逐句钉着:
 *   1. **交付给大模型的参考图是 9:16、高度 1024**;
 *   2. 它是**按画布 576×1080 取景**得到的(不是另开一次取景、也不是另渲一张);
 *   3. 裁切是**居中**的 —— 上下都裁掉一些,不是"保留顶部裁掉底部";
 *   4. 画布万一比 9:16 **宽**,要改成左右两侧各裁一条(同一个算法,两条分支)。
 *
 * 为什么值得单开一份:这一整条是**四段接力**(app.defaults.reference → app.js 的
 * captureReference → viewport.skeletonImage → utils.centerCrop / placeNdc 的算术),
 * 而中间任何一段漏传参数都不报错 —— 图照样出来,只是比例或位置不对,而 CHP 插件会用
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

/* ---------- 3) 投影换幅:骨架怎么落到参考图那块画布上 ----------
   参考图按画布 576×1080 取景,而屏幕上的相机是**另一个宽高比**。相机的 fov 是竖直的,
   横向随 aspect 走 ⇒ 同一世界点在 NDC 上的纵坐标不动、横坐标按 aspect 成反比缩放。
   于是"换成参考图那次取景"不需要碰相机:换算一次就够,而算出来的骨架与人偶是同一条射线。
   这一条错一点都看不出来 —— 骨架照画、位置全歪 —— 所以逐条钉住。 */
{
  const place = app.utils.placeNdc;
  const canvasAspect = reference.canvasWidth / reference.canvasHeight;
  const near = (got, want, message) => assert.ok(Math.abs(got - want) < 1e-9, `${message}(期望 ${want},得到 ${got})`);
  assert.equal(typeof place, "function", "换幅是纯算术,必须挂在 core/utils 上才测得到");

  /* 同一个宽高比 ⇒ 原样落进窗口:NDC 中心对中心、左上角对左上角 */
  assert.deepEqual(place({ x: 0, y: 0 }, 0.5, { windowWidth: 576, windowHeight: 1152 }),
    { x: 288, y: 576 }, "NDC 原点必须落在窗口正中");
  assert.deepEqual(place({ x: -1, y: 1 }, 0.5, { windowWidth: 576, windowHeight: 1152 }),
    { x: 0, y: 0 }, "NDC 左上角必须落在窗口左上角");
  assert.deepEqual(place({ x: 1, y: -1 }, 0.5, { windowWidth: 576, windowHeight: 1152 }),
    { x: 576, y: 1152 }, "NDC 右下角必须落在窗口右下角");

  /* **换幅只动横向**:纵向必须是同一个像素 —— 屏幕上的骨架与参考图因此上下对齐
     (两者用的是同一次取景,只是横向取景范围不同)。 */
  const square = place({ x: 0.2, y: 0.3 }, 1, {
    windowWidth: reference.canvasWidth, windowHeight: reference.canvasHeight, aspect: canvasAspect
  });
  const native = place({ x: 0.2, y: 0.3 }, canvasAspect, {
    windowWidth: reference.canvasWidth, windowHeight: reference.canvasHeight, aspect: canvasAspect
  });
  assert.equal(square.y, native.y, "换幅不该动纵向");
  near(square.y, 378, "纵向就是按窗口高度线性落下来的那一个像素");
  near(square.y, (0.5 - 0.3 * 0.5) * reference.canvasHeight, "纵向只与窗口高度有关");

  /* 横向按 from/to 的比值缩放:窗口更窄 ⇒ 同一个点被挤得更靠外。
     这一条正是"换幅"与"不换幅"的分界:不缩放的话这里会是 345.6。 */
  near(square.x, 396, "窗口宽高比 0.533、相机是 1 时,ndc.x 0.2 应落到 396");
  assert.ok(Math.abs(square.x - (0.2 * 0.5 + 0.5) * reference.canvasWidth) > 40,
    "没有换幅的话它会落在 345.6 左右 —— 那说明换幅这一段是空转");

  /* 偏移 = 居中裁掉的那部分。参考图的真实数字:576×1080 裁成 576×1024、上下各去掉 28 行。
     中心点因此落在 512 = 1024/2 —— "裁切保住了中心"这件事只用一条算术就看得见。 */
  const cropped = place({ x: 0, y: 0 }, 1, {
    windowWidth: reference.canvasWidth, windowHeight: reference.canvasHeight,
    aspect: canvasAspect, offsetX: 0, offsetY: 28
  });
  near(cropped.x, reference.width / 2, "裁完之后中心仍在成品正中");
  near(cropped.y, reference.height / 2, "裁完之后纵向中心也仍在成品正中");
  assert.equal(cropped.y * 2, reference.height, "上下对称 ⇒ 中心点正好是成品高度的一半");

  /* 尺寸不合法要当场说(与 centerCrop 同款:不返回一个 0 宽的落点) */
  assert.throws(() => place({ x: 0, y: 0 }, 1, { windowWidth: 0, windowHeight: 1080 }), /正数/);
  assert.throws(() => place({ x: 0, y: 0 }, 1, {}), /正数/);
}

/* ---------- 4) 段与段之间的接口 ----------
   四段各自都对、接口漏传参数,是这一整类问题的标准死法:图照样出得来,只是没裁过。
   所以这里读的是**真正传下去的表达式**,不是默认值自己。 */
{
  const appSource = fs.readFileSync(path.join(root, "app/app.js"), "utf8");
  assert.match(appSource, /skeletonImage\(reference\.canvasWidth,\s*reference\.canvasHeight,/,
    "app.js 要按 reference 的画布尺寸取景 —— 拿成品尺寸取景就没有可裁的余量了");
  assert.match(appSource, /frame:\s*\{\s*width:\s*reference\.width,\s*height:\s*reference\.height\s*\}/,
    "app.js 必须把 reference 的 width/height 当 frame 传下去,否则裁切整段是空转");
  assert.match(appSource, /capture:\s*captureReference/,
    "生图链路接到的是 captureReference;接回旧函数就等于绕过裁切与骨架");

  const viewportSource = fs.readFileSync(path.join(root, "app/components/viewport.js"), "utf8");
  assert.match(viewportSource, /app\.utils\.centerCrop\(/, "裁切走的是 core 的那一份算术");
  assert.match(viewportSource, /offsetX = box\.x;/, "横向裁掉的量要真的从落点上减掉");
  assert.match(viewportSource, /offsetY = box\.y;/, "纵向裁掉的量要真的从落点上减掉");
  assert.match(viewportSource, /app\.skeleton\.image\(poseSegments\(/,
    "参考图必须由骨架渲染器画(而且要拿投影出来的线段)—— 退回截图等于这一整条作废");
  assert.match(viewportSource, /width:\s*outWidth,\s*height:\s*outHeight,/,
    "交给骨架渲染器的是**裁完之后**的尺寸,不是取景窗口的尺寸");

  /* 投影换幅走的是 core 那一份算术。少了它,骨架会按屏幕的宽高比落在参考图上 ——
     画面照样出得来,只是人偶与骨线错开(这一条正是那件事的机器判据)。 */
  const placeSource = fs.readFileSync(path.join(root, "app/components/viewport.js"), "utf8");
  assert.match(placeSource, /app\.utils\.placeNdc\(/, "换幅走的是 core 的那一份算术");

  /* 另一半:截图那条路(captureStage)仍然按 frame 取景并报"裁完之后"的尺寸。
     它与参考图是同一套取景口径,只是交出去的是人偶的渲染图。 */
  assert.match(viewportSource, /frame\s*=\s*options\.frame;/, "captureAt 要从 options 里取 frame");
  assert.match(viewportSource, /outputWidth\s*=\s*box\.outWidth;/, "返回值要报裁完之后的宽");
  assert.match(viewportSource, /outputHeight\s*=\s*box\.outHeight;/, "返回值要报裁完之后的高");
}

console.log("reference.test.mjs: ok (9:16 与高度 1024、居中裁上下、横向富余改裁左右、"
  + "奇数差固定给上/左、非法尺寸当场拒、投影换幅只动横向且裁完保住中心、四段接口的传参)");
