/* 全屏看图的两个手势算式:缩放与平移的边界
 *
 * 2026-09-30 用户要求:「渲染图全屏查看的时候,高度要默认充满窗口显示,支持拖动、双指放缩
 * (最小也要高度充满)」。
 *
 * 「高度充满」这件事有两半:一半在 CSS(components.css 的 .render-preview-stage canvas,
 * 由 tools/verify.mjs 的 4e 守着),另一半就是这里 —— **缩放下限是 1,而 1 就是高度充满应得的尺寸**。
 * 这两条算式原来都写在 onMove / clampOffset 里,而那两个函数要真 DOM、真指针事件才跑得起来,
 * 等于没有任何测试守着:把下限从 1 悄悄改成 0.5,界面上只是"能缩得比整高更小了",
 * 那与用户明确要的相反,却不会让任何东西变红。
 *
 * 这一组只测纯算式 —— 手势本身(谁先按下、两指中点怎么算)归真机验收。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = globalThis.window || {};
new Function(fs.readFileSync(path.join(root, "app/core/namespace.js"), "utf8"))();
for (const file of ["app/core/utils.js", "app/core/i18n.js",
  "app/services/render-adjust.js", "app/components/render-preview.js"]) {
  new Function(fs.readFileSync(path.join(root, file), "utf8"))();
}

const preview = globalThis.window.posegi.components.renderPreview;
const { zoomScale, panLimit } = preview;

/* 1) 缩放下限 = 1(高度充满),上限 8 */
{
  /* 同一段距离 ⇒ 倍数不动 */
  assert.equal(zoomScale(1, 100, 100), 1, "距离没变,倍数不该动");
  assert.equal(zoomScale(2.5, 100, 100), 2.5, "任意起始倍数都不该被这一条改动");

  /* 两指张开 ⇒ 变大 */
  assert.equal(zoomScale(1, 100, 200), 2, "张开一倍就是放大一倍");
  assert.equal(zoomScale(1, 100, 800), 8, "上限 8 倍:够看清毛孔就够了,再大只是握着抖");

  /* **下限那一条**:两指捏到很近、甚至捏过头,倍数都停在 1 —— 不许出现 0.5 那种"比整高还小" */
  assert.equal(zoomScale(1, 100, 50), 1, "捏到一半,倍数停在 1(最小也要高度充满)");
  assert.equal(zoomScale(1, 200, 1), 1, "两指几乎合拢也停在 1");
  assert.equal(zoomScale(1, 100, 0), 1, "捏到 0 也停在 1 —— 下限是硬的下限");
  assert.equal(zoomScale(4, 100, 1), 1, "从 4 倍一路捏回去,同样停在下限 1");

  /* 起始距离为 0 是把上膛的枪:`/ 0` 会得到 Infinity,再一夹就变成上限 8,
     手指根本没动却突然放到最大。基线距离在 beginGesture 里已经夹过 1,这里守的是万一。 */
  assert.equal(zoomScale(1, 0, 0), 1, "起始距离为 0 时不许除零(否则倍数会跳到上限)");
  assert.equal(zoomScale(3, 0, 50), 3, "起始距离为 0 时保持原倍数");
}

/* 2) 平移余量:scale=1 时纵向余量正好 0(这就是"最小也要高度充满"在数据上的样子) */
{
  /* 9:16 的竖图在 360×776 的舞台上高度充满:画布 776 高后宽约 436 —— 比舞台宽,所以**横向**可挪 */
  assert.equal(panLimit(776, 776, 1), 0, "刚好铺满的那一轴:余量为 0(压不动)");
  assert.equal(panLimit(436, 360, 1), 38, "溢出屏幕的那一轴:余量是溢出的一半(可以左右挪)");

  /* 比舞台矮/窄的一轴不许出现负余量 —— 负余量会把图推到屏幕外去 */
  assert.equal(panLimit(300, 776, 1), 0, "比舞台小的时候余量夹成 0,不许是负数");
  assert.equal(panLimit(300, 776, 0), 0);

  /* 放大之后两条轴都开始有余量 */
  assert.equal(panLimit(776, 776, 2), 388, "放大两倍,原来刚好铺满的那一轴也能挪了");
  assert.equal(panLimit(436, 360, 2), 256, "本来就是正余量的那一轴跟着变大");
}

console.log("preview.test.mjs: ok (缩放下限恒为 1 = 高度充满、上限 8、起始距离 0 不除零、"
  + "平移余量按显示面自己的尺寸算且不为负)");
