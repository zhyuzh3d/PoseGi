/* 成图调色:六个参数、收口、滤镜、绘制
 *
 * 2026-09-30 用户要求:「添加调色工具,参照 HamDraw 的全屏渲染图查看界面的底部调色面板,
 * 调色参数也要保存到作品文档」。
 *
 * 这个模块是"调色"这件事的**规则唯一出处**:参数表、行程、形状收口、滤镜字符串、绘制。
 * 三个消费者(全屏看图绘制 / 作品文档存取 / 面板滑杆)都读它,所以这里坏掉会同时坏三处,
 * 而三处的表现完全不同 —— 全屏看图是"调了没反应",作品文档是"存进去读不出来",
 * 面板是"少一个滑杆"。这一组测试把三件事都钉住。
 *
 * 行程那一组是**写死的数字**:它们与 HamDraw 的全屏调色面板逐项相同(用户要求"参照"),
 * 所以它们不是"随手定的默认值",而是跨仓库的契约。改了这里就必须同时改那边,
 * 而不是"反正能用"。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = globalThis.window || {};
new Function(fs.readFileSync(path.join(root, "app/core/namespace.js"), "utf8"))();

for (const file of ["app/core/utils.js", "app/services/render-adjust.js"]) {
  new Function(fs.readFileSync(path.join(root, file), "utf8"))();
}

const app = globalThis.window.posegi;
const adjust = app.services.renderAdjust;

/* 1) 参数表:六个滑杆,顺序与行程与 HamDraw 的面板一致。
      顺序也要钉 —— 面板是按 KEYS 生成的,顺序一变滑杆就换位置,
      而"亮度/对比度在最前面"这件事用户会当成固定版式。 */
{
  assert.deepEqual(adjust.KEYS,
    ["brightness", "contrast", "saturation", "hue", "glow", "clarity"],
    "六个参数与顺序要和 HamDraw 的面板一致");

  const HAMDRAW = {
    brightness: [40, 180, "%"], contrast: [40, 180, "%"], saturation: [0, 220, "%"],
    hue: [-180, 180, "°"], glow: [0, 100, "%"], clarity: [0, 100, "%"]
  };
  Object.keys(HAMDRAW).forEach((key) => {
    const range = adjust.RANGE[key];
    assert.ok(range, `少了 ${key} 的行程`);
    assert.equal(range.min, HAMDRAW[key][0], `${key} 的下限要与 HamDraw 面板一致`);
    assert.equal(range.max, HAMDRAW[key][1], `${key} 的上限要与 HamDraw 面板一致`);
    assert.equal(range.suffix, HAMDRAW[key][2], `${key} 的后缀要与 HamDraw 面板一致`);
    assert.ok(range.zh && range.en, `${key} 要同时有中英文标签(界面是双语的)`);
  });
  assert.equal(Object.keys(adjust.RANGE).length, adjust.KEYS.length,
    `RANGE 里不该有多余的键 —— 有滑杆没生成是「少一个」,有多余的就是「永远用不到的那一项」`);
  assert.equal(adjust.DEFAULTS.hue, 0, "色相的中性是 0 度,不是 100");
  assert.equal(adjust.DEFAULTS.brightness, 100, "其余五项的中性是 100");
  assert.equal(adjust.DEFAULTS.enabled, true, "调色开关默认是开");
  assert.equal(adjust.display("hue", -20), "-20°", "后缀跟着参数走");
  assert.equal(adjust.display("brightness", 120), "120%");
}

/* 2) 收口:一项看不懂就换那**一项**,不是整份丢掉(调色没有"半份会更怪"这回事) */
{
  assert.equal(adjust.shape(null), null, "没有调色 ⇒ null");
  assert.equal(adjust.shape("调过的"), null, "不是对象 ⇒ null");
  assert.equal(adjust.shape([]), null, "数组也不是一份调色");

  const full = adjust.shape({ brightness: 120, contrast: 95, saturation: 140, hue: -20, glow: 30, clarity: 15, enabled: false });
  assert.deepEqual(full, { brightness: 120, contrast: 95, saturation: 140, hue: -20, glow: 30, clarity: 15, enabled: false },
    "六个值原样收下,enabled 的字面 false 也留着");

  assert.deepEqual(adjust.shape({ saturation: 140 }).saturation, 140);
  assert.equal(adjust.shape({ saturation: 140 }).brightness, 100, "缺的那几项补中性");
  assert.equal(adjust.shape({ brightness: null }).brightness, 100, "null 不是数 ⇒ 那一项回中性");
  assert.equal(adjust.shape({ brightness: true }).brightness, 100, "布尔不是数");
  assert.equal(adjust.shape({ brightness: [120] }).brightness, 100, "数组不是数");
  assert.equal(adjust.shape({ brightness: "120" }).brightness, 120, "数值字符串照样认");
  assert.equal(adjust.shape({ brightness: 999 }).brightness, 180, "超上界的收进上界");
  assert.equal(adjust.shape({ brightness: -5 }).brightness, 40, "超下界的收进下界");
  assert.equal(adjust.shape({ enabled: "false" }).enabled, true,
    `开关只认字面的 false —— 字符串 "false" 不是 false,判反了会让人看到一张没调色的图却找不到原因`);
  assert.equal(adjust.shape({ enabled: 0 }).enabled, true, "0 也不是 false");

  /* normalize 永远齐整(运行时拿它当"一份能用的参数") */
  assert.deepEqual(adjust.normalize(null), adjust.DEFAULTS, "空的那一份就是中性");
  assert.notEqual(adjust.normalize(null), adjust.DEFAULTS, "而且必须是拷贝,不能把默认值对象交出去");
  assert.deepEqual(adjust.normalize({ glow: 50 }).glow, 50);
  assert.equal(adjust.normalize({ glow: 50 }).brightness, 100);
}

/* 3) "有没有调色"的判定与"存不存" */
{
  const neutral = adjust.normalize(null);
  assert.equal(adjust.isNeutral(neutral), true, "全中性 = 没有调色");
  assert.equal(adjust.isNeutral(null), true, "没有那一份也是没有调色");
  assert.equal(adjust.isNeutral({ brightness: 100, contrast: 100, saturation: 100, hue: 0, glow: 0, clarity: 0 }), true);
  assert.equal(adjust.isNeutral({ brightness: 101 }), false, "动过一项就不是中性");

  assert.equal(adjust.stored(neutral), null, "没有调色就存 null —— 不是存一份全中性的对象");
  assert.equal(adjust.stored(null), null);
  assert.equal(adjust.stored({ enabled: false }), null,
    "开关关掉而滑杆全在中性 ⇒ 仍然是没有调色(画面与不调色一模一样)");
  const keep = adjust.stored({ brightness: 120, enabled: false });
  assert.equal(keep.brightness, 120, "有调色时开关关着也要整份存下来");
  assert.equal(keep.enabled, false, "否则用户再打开这件作品,开关会自己跳回开");
}

/* 4) 滤镜字符串 —— 它是"参数到底有没有作用到画面上"的唯一出口 */
{
  const neutral = adjust.colorFilter(adjust.normalize(null));
  assert.equal(neutral, "brightness(100%) contrast(100%) saturate(100%) hue-rotate(0deg)",
    "中性那一份画出来就是原图(四个 100%/0 的滤镜等于没滤)");

  const filter = adjust.colorFilter({ brightness: 120, contrast: 95, saturation: 140, hue: -20 });
  assert.equal(filter, "brightness(120%) contrast(95%) saturate(140%) hue-rotate(-20deg)",
    "四个数要一个不落地进到滤镜里");
  assert.equal(adjust.colorFilter({ brightness: 120, enabled: false }), "none",
    "调色开关关掉 ⇒ 滤镜是 none(画出来的就是原图)");

  /* 辉光:在颜色之上再糊一遍提亮一点,用 screen 混上去 */
  const glow = adjust.glowFilter({ brightness: 120, glow: 50 });
  assert.match(glow, /^brightness\(120%\) contrast\(100%\) saturate\(100%\) hue-rotate\(0deg\) blur\(/,
    "辉光那一遍要**先**做颜色(否则两层颜色的结果与只做一层不同)");
  assert.match(glow, /blur\(6px\)/, "50% 的辉光对应 6px 的模糊(1 + 50*0.1)");
  assert.match(glow, /brightness\(130\.5%\)/, "辉光同时提亮(108 + 50*0.45)");
  /* 没有辉光时它必须**什么都不加**:draw() 那边虽然有 glow > 0 的守卫,
     但一个在"不要辉光"时仍会改画面的函数就是把上了膛的枪(守卫少写一处就画错一张图)。 */
  assert.equal(adjust.glowFilter({ brightness: 120, glow: 0 }), adjust.colorFilter({ brightness: 120 }),
    "辉光为 0 ⇒ 就只是颜色那一条,不许悄悄加 brightness");
  assert.equal(adjust.glowFilter({ brightness: 120, glow: 50, enabled: false }), "none",
    "调色被关掉 ⇒ none(与 colorFilter 同一个答案)");

  assert.equal(adjust.sharpenAmount({ clarity: 0 }), 0, "清晰度 0 ⇒ 不做锐化(省钱的那条路)");
  assert.equal(adjust.sharpenAmount({ clarity: 100 }), 0.8, "清晰度 100 ⇒ 0.8 的强度");
  assert.equal(adjust.sharpenAmount({ clarity: 100, enabled: false }), 0, "关掉调色 ⇒ 不锐化");
}

/* 5) 绘制:画布按图片自己的像素建,颜色那一遍带滤镜,辉光那一遍用 screen 混。
      用替身画布把**每一次调用**记下来 —— 只断言"函数被调过"是不够的:
      滤镜设错、辉光忘了开 screen、画布没按原尺寸建,都会画出一张"看着还行但不对"的图。 */
{
  const calls = [];
  const context = {
    filter: "none", globalAlpha: 1, globalCompositeOperation: "source-over",
    clearRect: (...args) => calls.push({ op: "clearRect", args }),
    drawImage: (...args) => calls.push({
      op: "drawImage", args, filter: context.filter,
      blend: context.globalCompositeOperation, alpha: context.globalAlpha
    }),
    save: () => calls.push({ op: "save" }),
    restore: () => calls.push({ op: "restore" }),
    /* 替身故意抛错:跨源图片污染过的画布上 getImageData 就是这个行为,
       它必须被吞掉(让它不锐就是了),不能让整幅图消失。 */
    getImageData: () => { throw new Error("tainted canvas"); },
    putImageData: () => calls.push({ op: "putImageData" })
  };
  const canvas = { width: 300, height: 150, hidden: false, getContext: () => context };
  const image = { naturalWidth: 768, naturalHeight: 1344 };

  assert.equal(adjust.draw(canvas, image, { brightness: 120, glow: 40 }), true, "画得出来");
  assert.equal(canvas.width, 768, "画布要按图片自己的像素建(放大交给 CSS 变换)");
  assert.equal(canvas.height, 1344);
  assert.equal(calls[0].op, "clearRect", "先清底");
  assert.deepEqual(calls[0].args, [0, 0, 768, 1344]);

  const first = calls.filter((item) => item.op === "drawImage")[0];
  assert.ok(first, "必须真的 drawImage 一次");
  assert.deepEqual(first.args.slice(1), [0, 0, 768, 1344], "画的尺寸就是原图尺寸");
  assert.equal(first.filter, "brightness(120%) contrast(100%) saturate(100%) hue-rotate(0deg)",
    "颜色那一遍要带着滤镜画");
  assert.equal(first.blend, "source-over", "第一遍是正常叠加");

  const second = calls.filter((item) => item.op === "drawImage")[1];
  assert.ok(second, "辉光那一遍也得画");
  assert.equal(second.blend, "screen", "辉光的混法是 screen(不是默认的 source-over)");
  assert.equal(second.alpha, Math.min(0.62, 40 / 150), "辉光的强度按 0-62% 走");
  assert.match(second.filter, /blur\(5px\)/, "40% 的辉光对应 5px 的模糊");
  assert.ok(calls.some((item) => item.op === "save") && calls.some((item) => item.op === "restore"),
    "混之前要 save / 之后要 restore,否则 blend 与 alpha 会漏给下一次绘制");

  /* 中性那一份:画一次,而且不带辉光那一遍 */
  calls.length = 0;
  assert.equal(adjust.draw(canvas, image, adjust.normalize(null)), true);
  assert.equal(calls.filter((item) => item.op === "drawImage").length, 1,
    "没有调色时只画一遍(辉光为 0 就不该多画一遍)");
  assert.equal(calls.filter((item) => item.op === "drawImage")[0].filter,
    "brightness(100%) contrast(100%) saturate(100%) hue-rotate(0deg)");

  /* 锐化那条路被污染挡住时不该抛出去 */
  calls.length = 0;
  assert.equal(adjust.draw(canvas, image, { clarity: 80 }), true, "getImageData 抛错也要能画完");
  assert.equal(calls.filter((item) => item.op === "drawImage").length, 1);

  /* 图片还没解码好:什么都不做,也**不要**把画布改成 0x0 */
  calls.length = 0;
  const empty = { width: 300, height: 150, getContext: () => context };
  assert.equal(adjust.draw(empty, { naturalWidth: 0, naturalHeight: 0 }, null), false, "没有像素就不画");
  assert.equal(empty.width, 300, "没解码好时不许把画布尺寸改掉");
  assert.equal(calls.length, 0, "更不该往画布上画任何东西");
  assert.equal(adjust.draw(canvas, null, null), false, "没有图片就不画");
  assert.equal(adjust.draw(null, image, null), false, "没有画布就不画");
}

/* 第 6、7 两节都要一个 document 替身:缓存里那张与原图无关的锐化结果是一张**离屏画布**,
   它得靠 document.createElement 建出来。替身只提供"能建画布 + 能存取像素"这两件事,
   与浏览器无关的那部分(缓存键、草稿分辨率)才是这两节要钉的东西。 */
function installCanvasFactory() {
  globalThis.document = {
    createElement: () => {
      const canvas = { width: 4, height: 4, ops: [] };
      const context = {
        filter: "none",
        clearRect: (...args) => canvas.ops.push({ op: "clearRect", args }),
        drawImage: (...args) => canvas.ops.push({ op: "drawImage", args, on: canvas }),
        /* 真实一点:返回一块确定的花纹,让拉普拉斯那一遍真的有东西可算 */
        getImageData: (x, y, w, h) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < data.length; i += 4) {
            data[i] = (i * 7) & 255; data[i + 1] = (i * 11) & 255;
            data[i + 2] = (i * 13) & 255; data[i + 3] = 255;
          }
          canvas.ops.push({ op: "getImageData", args: [x, y, w, h] });
          return { data, width: w, height: h };
        },
        putImageData: (image) => canvas.ops.push({ op: "putImageData", image })
      };
      canvas.getContext = () => context;
      return canvas;
    }
  };
}

/* 6) 清晰度那一遍:拖别的滑杆时**一次都不许跑**。
      2026-09-30 用户要求:「全屏查看渲染图界面的调色滑竿现在很卡,请想办法优化算法或机制」。
      这就是那条要求的判据本身 —— 不是"感觉快了",而是"改颜色时逐像素那一遍跑了几次"。
      为什么它必须由测试钉住:缓存键一旦被谁顺手加上 brightness,画面**看起来一模一样**
      (对,结果仍然正确),只是每一帧又变回一百毫秒级的重算,而没有任何东西会变红。 */
{
  installCanvasFactory();

  const surface = { width: 1, height: 1, getContext: undefined, ops: [] };
  const surfaceContext = {
    filter: "none", globalAlpha: 1, globalCompositeOperation: "source-over",
    clearRect: () => {}, save: () => {}, restore: () => {},
    drawImage: (...args) => surface.ops.push({ op: "drawImage", base: args[0], args }),
    getImageData: (...args) => ({ data: new Uint8ClampedArray(args[2] * args[3] * 4), width: args[2], height: args[3] }),
    putImageData: () => {}
  };
  surface.getContext = () => surfaceContext;
  const photo = { naturalWidth: 768, naturalHeight: 1344, src: "blob:posegi/one" };

  const passes = () => adjust.internals.pixelPasses();
  adjust.internals.forget();

  /* 第一帧(有清晰度)要把那一遍跑掉,并且底图从此变成"缓存里那张已经锐化好的" */
  let before = passes();
  assert.equal(adjust.draw(surface, photo, { clarity: 50 }), true);
  assert.equal(passes() - before, 1, "第一次带着清晰度画:逐像素那一遍必须跑");
  const firstBase = surface.ops[0].base;
  assert.notEqual(firstBase, photo, "有清晰度时画的第一遍必须是锐化好的那一张,不是原图");

  /* **这一条就是"滑杆不卡"**:接着拖动颜色四项与辉光,一个像素都不该再算 */
  before = passes();
  for (let step = 0; step < 12; step += 1) {
    surface.ops.length = 0;
    adjust.draw(surface, photo, { clarity: 50, brightness: 100 + step, contrast: 90 + step, glow: step });
    assert.equal(surface.ops[0].base, firstBase, "缓存命中时画的还是那一张,不许退回去画原图");
  }
  assert.equal(passes() - before, 0,
    "拖动亮度 / 对比度 / 饱和度 / 色相 / 辉光时,逐像素那一遍一次都不该跑 —— 缓存键里只许有清晰度");

  /* 清晰度自己变了 ⇒ 必须重算 */
  before = passes();
  adjust.draw(surface, photo, { clarity: 51, brightness: 120 });
  assert.equal(passes() - before, 1, "清晰度变了要重算");
  before = passes();
  adjust.draw(surface, photo, { clarity: 51, brightness: 130 });
  assert.equal(passes() - before, 0, "换回同一个清晰度,缓存仍然命中");

  /* 缓存只有一格:换过一档再换回来,就得重算(这是**故意**的,不是漏了) */
  adjust.draw(surface, photo, { clarity: 52 });
  before = passes();
  adjust.draw(surface, photo, { clarity: 51 });
  assert.equal(passes() - before, 1, "缓存只有一格:被后一档挤掉之后,再回来要重算");

  /* 清晰度在中性:一个像素都不碰,底图就是原图本身 */
  adjust.internals.forget();
  before = passes();
  surface.ops.length = 0;
  adjust.draw(surface, photo, adjust.normalize(null));
  assert.equal(passes() - before, 0, "清晰度 0 ⇒ 逐像素那一遍根本不该被调用");
  assert.equal(surface.ops[0].base, photo, "清晰度 0 ⇒ 画的底图就是原图本身");

  /* 换了一张图:缓存必须失效(键里有图源) */
  adjust.draw(surface, photo, { clarity: 50 });
  before = passes();
  adjust.draw(surface, { naturalWidth: 768, naturalHeight: 1344, src: "blob:posegi/two" }, { clarity: 50 });
  assert.equal(passes() - before, 1, "换了图源 ⇒ 缓存失效,必须重算(否则会把上一张的像素画上去)");

  /* 调色被关掉 ⇒ 不锐化,也不该去建缓存 */
  adjust.internals.forget();
  before = passes();
  adjust.draw(surface, photo, { clarity: 80, enabled: false });
  assert.equal(passes() - before, 0, "调色开关关掉 ⇒ 清晰度也不该生效");
}

/* 7) 草稿帧:拖动清晰度滑杆期间画布只有 DRAFT_SCALE 那么大,而且**不进缓存**。
      手指停住之后补的那一帧由 components/render-preview.js 的 settle 定时器触发,
      这里只管"降分辨率"这半边:草稿要是把缓存填上了,收尾那一帧就会拿低分辨率的
      结果冒充完整分辨率 —— 界面上再也回不到清晰,而没有任何东西会报错。 */
{
  installCanvasFactory();

  const surface = { width: 1, height: 1, ops: [], getContext: undefined };
  const context = {
    filter: "none", globalAlpha: 1, globalCompositeOperation: "source-over",
    clearRect: () => {}, save: () => {}, restore: () => {},
    drawImage: (...args) => surface.ops.push({ op: "drawImage", args }),
    getImageData: (...args) => ({ data: new Uint8ClampedArray(args[2] * args[3] * 4), width: args[2], height: args[3] }),
    putImageData: () => {}
  };
  surface.getContext = () => context;
  const photo = { naturalWidth: 768, naturalHeight: 1344, src: "blob:posegi/one" };
  const SCALE = adjust.internals.DRAFT_SCALE;
  assert.ok(SCALE > 0 && SCALE < 1, "草稿分辨率必须在 0 与 1 之间");
  const passes = () => adjust.internals.pixelPasses();

  adjust.internals.forget();
  let before = passes();
  adjust.draw(surface, photo, { clarity: 50 }, { draft: true });
  assert.equal(surface.width, Math.round(768 * SCALE), "草稿帧的画布按 DRAFT_SCALE 缩小");
  assert.equal(surface.height, Math.round(1344 * SCALE));
  assert.equal(passes() - before, 1, "草稿帧仍然要把那一遍跑掉(只是在小画布上)");

  before = passes();
  adjust.draw(surface, photo, { clarity: 50 });
  assert.equal(passes() - before, 1, "草稿**不进缓存** ⇒ 收尾那一帧必须重算一次");
  assert.equal(surface.width, 768, "收尾那一帧回到完整分辨率");
  assert.equal(surface.height, 1344);

  /* 缓存已经热了就不必再降分辨率:该省的那一遍本来就不跑 */
  before = passes();
  surface.width = 5; surface.height = 5;                    /* 故意先改成错的尺寸 */
  adjust.draw(surface, photo, { clarity: 50, brightness: 130 }, { draft: true });
  assert.equal(surface.width, 768, "缓存命中时草稿是白降 —— 颜色那一遍是 GPU 的,画布要保持完整分辨率");
  assert.equal(surface.height, 1344);
  assert.equal(passes() - before, 0);

  /* 没有清晰度 ⇒ 没有可省的那一遍 ⇒ 草稿照旧是完整分辨率 */
  adjust.internals.forget();
  surface.width = 5; surface.height = 5;
  adjust.draw(surface, photo, { brightness: 130 }, { draft: true });
  assert.equal(surface.width, 768, "清晰度中性时草稿帧不该被降分辨率(降了只是白糊一下)");
  assert.equal(surface.height, 1344);
}

/* 8) 拉普拉斯那一遍的**像素数学**:纯函数,可以直接手算对。
      它是"清晰度"唯一真正改变画面的地方,顺序在 draw() 里被挪过一次(先锐化后颜色),
      所以这条算式本身必须钉死 —— 挪动顺序时最容易被顺手改坏的就是它。 */
{
  const laplacian = adjust.internals.laplacian;

  /* 3×3 只有正中一个内点。四邻域全是 0 ⇒ 输出 = 中心 × (1+4a) */
  const one = new Uint8ClampedArray(3 * 3 * 4);
  for (let i = 3; i < one.length; i += 4) one[i] = 255;
  one[1 * 12 + 4] = 100;                                   /* 中心 R = 100 */
  const outOne = laplacian(one, new Uint8ClampedArray(one), 3, 3, 0.1);
  assert.equal(outOne[1 * 12 + 4], 140, "中心像素 = 100 × (1 + 4×0.1)");
  assert.equal(outOne[1 * 12 + 5], 0, "邻域为 0 的通道不该被凭空点亮");
  assert.equal(outOne[1 * 12 + 7], 255, "alpha 一个字节都不许动");

  /* 左邻域给 50 ⇒ 再减去 0.1 × 50 */
  const two = new Uint8ClampedArray(one);
  two[1 * 12] = 50;                                        /* 左侧邻居 R = 50 */
  const outTwo = laplacian(two, new Uint8ClampedArray(two), 3, 3, 0.1);
  assert.equal(outTwo[1 * 12 + 4], 135, "每多一个亮邻居就往下减 0.1 × 它的值");

  /* 4×4:内部有四个点,彼此相邻 —— 这一条专门钉"四邻域取的是**原值**"。
     只用一个内点的 3×3 看不出这件事:把 input 换成 output(就地盖)它会照样绿,
     而就地盖会让画面沿扫描方向**逐点被前面算过的值带偏**(左边那条被提亮过的边走样),
     手机上看起来是"锐化方向不对/右侧发灰",却仍然很像"就是锐化的样子"。 */
  const grid = (rows) => {
    const size = rows.length;
    const data = new Uint8ClampedArray(size * size * 4);
    rows.forEach((row, y) => row.forEach((value, x) => {
      data[(y * size + x) * 4] = value;
      data[(y * size + x) * 4 + 3] = 255;
    }));
    return data;
  };
  const four = grid([
    [0, 0, 0, 0],
    [0, 90, 60, 0],
    [0, 60, 90, 0],
    [0, 0, 0, 0]
  ]);
  const outFour = laplacian(four, new Uint8ClampedArray(four), 4, 4, 0.1);
  const at = (data, side, x, y) => data[(y * side + x) * 4];
  assert.equal(at(outFour, 4, 1, 1), 114,
    "90×1.4 − 0.1×(上 0 + 下 60 + 左 0 + 右 60)");
  assert.equal(at(outFour, 4, 2, 1), 66,
    "60×1.4 − 0.1×(0 + 90 + 90 + 0):左边那个邻居必须取**原值** 90,不是它刚算出来的 114");
  assert.equal(at(outFour, 4, 1, 2), 66, "上下对称,数字要对得上");
  assert.equal(at(outFour, 4, 2, 2), 114);

  /* 强锐化把中心推到 255 以上 ⇒ 夹到 255(Uint8ClampedArray 的行为,不是我们的分支) */
  const outHard = laplacian(one, new Uint8ClampedArray(one), 3, 3, 0.5);
  assert.equal(outHard[1 * 12 + 4], 255, "算到 300 就夹成 255");

  /* 边框一圈没有四邻域 ⇒ 原样留着(改了它就是"边缘一圈被悄悄提亮") */
  const edge = new Uint8ClampedArray(3 * 3 * 4);
  for (let i = 0; i < edge.length; i += 1) edge[i] = (i * 3) & 255;
  const outEdge = laplacian(edge, new Uint8ClampedArray(edge), 3, 3, 0.4);
  for (let x = 0; x < 3; x += 1) {
    assert.equal(outEdge[x * 4], edge[x * 4], "顶边不该被改");
    assert.equal(outEdge[2 * 12 + x * 4], edge[2 * 12 + x * 4], "底边不该被改");
  }
  for (let y = 0; y < 3; y += 1) {
    assert.equal(outEdge[y * 12], edge[y * 12], "左边不该被改");
    assert.equal(outEdge[y * 12 + 8], edge[y * 12 + 8], "右边不该被改");
  }

  /* 强度为 0 ⇒ 逐字节等同输入(它是"没调色"那条路,不许有一点点锐化) */
  const outZero = laplacian(edge, new Uint8ClampedArray(edge), 3, 3, 0);
  assert.deepEqual([...outZero], [...edge], "强度 0 时输出必须逐字节等于输入");
}

console.log("render-adjust.test.mjs: ok (六个参数与行程照 HamDraw、一项坏只坏一项、"
  + "中性不落盘、滤镜四个数全进、辉光走 screen、画布按原尺寸、污染不抛错、"
  + "拖颜色时逐像素那一遍一次都不跑、草稿不进缓存、拉普拉斯逐像素对得上)");
