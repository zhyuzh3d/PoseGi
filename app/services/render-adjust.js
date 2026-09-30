/* 成图调色:有哪几个参数、各自什么行程、怎么变成一条滤镜、怎么画到画布上
 *
 * 责任:把"调色"这件事的**规则**收在一处 —— 参数表、形状收口、滤镜字符串、绘制。
 * 它不碰 DOM(画布是调用方传进来的),所以作品文档那边(services/store.js)也能用它收口,
 * 而不用反过来让服务层去依赖组件层。面板长什么样在 components/render-preview.js,
 * 它按这里的 KEYS / RANGE 生成 —— 谁都不许再自己列一遍参数。
 *
 * 约束:六个参数的**行程与标签与 HamDraw 的全屏看图调色面板逐项相同**(用户 2026-09-30
 *       要求「参照 HamDraw 的全屏渲染图查看界面的底部调色面板」)。同一个应用家族、同一台
 *       设备、同一套内核,两个面板长得不一样只会让人以为是两种东西。
 *
 * 为什么必须收成一处:这些值有三个消费者 —— 全屏看图(要绘制)、作品文档(要存要取)、
 *   面板(要滑杆)。三处各写一遍必然对不上,而"少一个滑杆 / 多一个参数 / 行程差一档"
 *   不会报任何错 —— 用户只能自己发现。
 *
 * 实现照搬 HamDraw 的 components/canvas.js(那一套已经在真机上跑过):
 *   颜色四项走 `context.filter`(亮度 / 对比度 / 饱和度 / 色相),
 *   梦幻辉光再用 screen 混合糊一遍,清晰度对像素做一次拉普拉斯锐化。
 *   为什么不退成"纯 CSS 滤镜"省掉画布:清晰度在 CSS 里没有对应物,
 *   只做四项就是一块缺角的面板;而缺角这件事恰恰最难被自己发现。
 * 唯一刻意偏离 HamDraw 的一处是**清晰度那一步的次序与缓存**(HamDraw 是每帧
 * 先颜色再逐像素锐化,这里改成先锐化、缓存、再把颜色压上去)——
 * 原因是用户 2026-09-30 报「调色滑竿很卡」,推导与代价见下面「清晰度那一遍」那一节。
 * 参数表与滤镜字符串仍然逐项相同,画面效果不变。
 *
 * 参数为什么存进**作品文档**而不是全局配置(用户 2026-09-30 要求):
 *   调色是"这张图我想要什么样子"的一部分,和姿态、视口、造型同一性质 ——
 *   换一件作品就该换一套调色,打开旧作品就该回来。HamDraw 存的是全局默认,
 *   这里不照抄那一半:他的原话是「调色参数也要保存到作品文档」。
 */
(function (app) {
  "use strict";

  /* 顺序就是面板上滑杆的顺序(brightness/contrast 打头,与 HamDraw 一致)。
     KEYS 只列**滑杆**;面板上那个「调色效果」开关是 `enabled`,它没有行程,单列。 */
  var KEYS = ["brightness", "contrast", "saturation", "hue", "glow", "clarity"];

  /* 中性值。**整套都在中性上 = 没有调色**,见 stored() */
  var DEFAULTS = { brightness: 100, contrast: 100, saturation: 100, hue: 0, glow: 0, clarity: 0, enabled: true };

  /* 行程 / 后缀 / 标签。后缀给输出框用(`100%`、`0°`)。 */
  var RANGE = {
    brightness: { min: 40, max: 180, suffix: "%", zh: "亮度", en: "Brightness" },
    contrast: { min: 40, max: 180, suffix: "%", zh: "对比度", en: "Contrast" },
    saturation: { min: 0, max: 220, suffix: "%", zh: "饱和度", en: "Saturation" },
    hue: { min: -180, max: 180, suffix: "°", zh: "色相", en: "Hue" },
    glow: { min: 0, max: 100, suffix: "%", zh: "梦幻辉光", en: "Dream glow" },
    clarity: { min: 0, max: 100, suffix: "%", zh: "清晰度", en: "Sharpness" }
  };

  /* 一个参数在界面上怎么显示(滑杆旁边那个数字)。后缀的唯一出处在这里。 */
  function display(key, value) { return String(value) + String((RANGE[key] || {}).suffix || ""); }

  function clampKey(key, value) {
    var range = RANGE[key];
    return Math.min(range.max, Math.max(range.min, value));
  }

  /* ---------- 形状收口 ----------
   * 与 store 里姿态 / 视口那两条同一个规矩:只保证形状,并且**一个看不懂的值退回中性**,
   * 而不是整份丢掉 —— 调色没有"半份会更怪"这回事(某个滑杆坏了就把那一项当中性,
   * 别的照旧)。超出行程的收进行程:留着它只会让滑杆夹在自己头尾之间动不了,
   * 看起来像"这个滑杆坏了"。
   * `enabled` 只认字面的 false —— 别的(含缺失、字符串 "false")都当作开:
   * 它是"要不要压上去",判反了会让用户看到一张完全没调色的图却找不到原因。 */
  function shape(raw) {
    /* 数组要显式挡掉:`typeof []` 是 "object",放它进去会得到"一份全中性的调色" ——
       那看起来像"装上了",而记录里其实是个坏值(与 store 收口 works 列表同一个判据)。 */
    if (!raw || Object.prototype.toString.call(raw) !== "[object Object]") return null;
    var out = {};
    KEYS.forEach(function (key) {
      var value = app.utils.finiteNumber(raw[key]);
      out[key] = value === null ? DEFAULTS[key] : clampKey(key, value);
    });
    out.enabled = raw.enabled !== false;
    return out;
  }

  /* 运行时用的那一份:永远齐整(null / 脏值一律回中性) */
  function normalize(raw) { return shape(raw) || app.utils.copy(DEFAULTS); }

  /* 没有调色 = **六个滑杆全在中性**。
     为什么"调色开关被关掉"不算中性:那个开关是拿来左右对比的,用户把滑杆调到 120 再
     关掉它、下次打开时希望那 120 还在(他一开开关就该看见自己调过的样子)。
     反过来,六个滑杆本来就全在中性时,那个开关开着关着都一样 —— 整份不表达任何东西。 */
  function isNeutral(raw) {
    var settings = shape(raw);
    if (!settings) return true;
    return KEYS.every(function (key) { return settings[key] === DEFAULTS[key]; });
  }

  /* 要写进作品文档的那一份:**没有调色 ⇒ null**。
     不这么做的话每件作品都会揣着一个七字段全中性的对象,而它不表达任何东西。 */
  function stored(raw) {
    var value = shape(raw);
    if (!value || isNeutral(value)) return null;
    return value;
  }

  /* ---------- 滤镜 ---------- */

  /* 颜色四项。关掉调色开关时是 "none"(画出来的就是原图)。 */
  function colorFilter(value) {
    var settings = normalize(value);
    if (settings.enabled === false) return "none";
    return "brightness(" + settings.brightness + "%) contrast(" + settings.contrast +
      "%) saturate(" + settings.saturation + "%) hue-rotate(" + settings.hue + "deg)";
  }

  /* 辉光那一遍:在颜色之上再糊一遍、提亮一点、加一点饱和,用 screen 混上去。
     **没有辉光(或调色被关掉)时返回的就是颜色那一条** —— 不返回"blur(1px) brightness(108%)"
     那种看着像没做、其实把整幅提亮 8% 的东西。draw() 那边虽然有 glow > 0 的守卫,
     但一个在"不要辉光"时仍会改画面的函数就是把上了膛的枪:守卫少写一处就画错一张图。 */
  function glowFilter(value) {
    var settings = normalize(value);
    var glow = settings.enabled === false ? 0 : settings.glow;
    if (glow <= 0) return colorFilter(settings);
    return colorFilter(settings) + " blur(" + (1 + glow * 0.1) + "px) brightness(" +
      (108 + glow * 0.45) + "%) saturate(" + (105 + glow * 0.35) + "%)";
  }

  function sharpenAmount(value) {
    var settings = normalize(value);
    if (settings.enabled === false) return 0;
    return settings.clarity / 100 * 0.8;
  }

  /* ---------- 清晰度那一遍:唯一碰像素的一步,也是唯一要省的一步 ----------
   *
   * 2026-09-30 用户要求:「全屏查看渲染图界面的调色滑竿现在很卡,请想办法优化算法或机制」。
   * 卡在哪:颜色四项与辉光都是 `context.filter`,交给 GPU(每帧一次 drawImage,几毫秒);
   * 唯独清晰度是**逐像素的拉普拉斯** —— getImageData 取回整幅 → JS 双重循环 → putImageData
   * 写回。本机量过(576×1024 约 9ms、1024×1344 约 15ms,V8);手机内核更老、CPU 更慢,
   * 同一段要几十到上百毫秒,而拖滑杆时**每一帧**都要跑一遍。
   *
   * 拿不掉它(CSS 滤镜里没有卷积,画布 filter 也不认 url(#svg) 那种写法),那就让它
   * **别跟着别的参数一起重算**:
   *   · 拉普拉斯只跟"清晰度"有关 ⇒ 把它挪到颜色**之前**、对**原图**做一次,结果缓存起来;
   *     颜色四项与辉光压在它上面画 —— 拖亮度 / 对比度 / 饱和度 / 色相 / 辉光时,
   *     这一张缓存一个像素都不用重算。提速的全部来源就在这里。
   *   · 清晰度自己变了才重算,而且拖动期间先出**低分辨率草稿**(DRAFT_SCALE),
   *     手指停住之后再补一帧完整分辨率的(收尾由 components/render-preview.js 的 settle 定时器管)。
   *
   * **顺序从"先颜色再锐化"换成"先锐化再颜色",这是有代价的,不是随手改的。**
   * 亮度 / 对比度是逐通道的仿射映射、饱和度 / 色相是通道间的线性混合,两者都与拉普拉斯
   * 可交换 —— 唯一的差别出现在**被夹到 0/255 的那些点**上(两种顺序夹的地方不同),
   * 以及 Chrome 滤镜内部的浮点取整。中性调色(brightness/contrast/saturate 都是 100%、
   * hue-rotate 0deg)时两个顺序**逐字节相同**;有调色时也只差一两个色阶。
   * 设备端实测的逐像素对拍数字记在 tests/render-adjust.test.mjs 的注释里。
   */

  /* 拖动期间的草稿分辨率。0.6 是"看得出这一档在做什么、又明显更省"的那一档:
     0.6² ≈ 0.36,逐像素那一遍的成本降到三分之一强。它只用在清晰度那一帧上 ——
     颜色那一遍是 GPU 的,降它没有意义,只会平白让画面变糊。 */
  var DRAFT_SCALE = 0.6;

  /* 缓存只有一格:全屏看图同一时刻只显示一张图。键 = 图源 + 清晰度,
     **颜色四项与辉光刻意不进键** —— 它们压在锐化之后画,改它们不会让这一张失效。 */
  var CACHE = { key: "", canvas: null, passes: 0 };

  function createCanvas() {
    if (typeof document === "undefined" || !document.createElement) return null;
    return document.createElement("canvas");
  }

  function imageSize(image) {
    return {
      width: image.naturalWidth || image.width || 0,
      height: image.naturalHeight || image.height || 0
    };
  }

  function sourceKey(image) {
    var size = imageSize(image);
    return String(image.currentSrc || image.src || "") + "|" + size.width + "x" + size.height;
  }

  function clarityKey(image, settings) {
    return sourceKey(image) + "|" + settings.clarity + "|" + (settings.enabled === false ? "off" : "on");
  }

  /* 拉普拉斯锐化,**纯像素数学**:不认识画布,所以能直接用一堆字节测。
     公式与逐像素顺序与早先的实现一字不差:`center*(1+4a) - a*(四邻域和)`,
     四邻域取**原值**(output 是另开的,不就地盖)。边框一圈没有四邻域,原样留着。 */
  function laplacian(input, output, width, height, amount) {
    var stride = width * 4, center = 1 + amount * 4;
    for (var y = 1; y < height - 1; y += 1) {
      for (var x = 1; x < width - 1; x += 1) {
        var offset = y * stride + x * 4;
        for (var channel = 0; channel < 3; channel += 1) {
          output[offset + channel] = input[offset + channel] * center - amount *
            (input[offset - 4 + channel] + input[offset + 4 + channel] +
              input[offset - stride + channel] + input[offset + stride + channel]);
        }
      }
    }
    return output;
  }

  /* 就地把一张画布锐化掉。**必须 try/catch**:画布一旦被跨源图片污染,getImageData 会抛,
     而那不该让整幅图消失 —— 让它不锐就是了。返回"到底锐成了没有"。 */
  function sharpenCanvas(context, width, height, amount) {
    if (!amount) return true;
    var source;
    try { source = context.getImageData(0, 0, width, height); } catch (error) { return false; }
    var output = new Uint8ClampedArray(source.data);
    laplacian(source.data, output, width, height, amount);
    source.data.set(output);
    context.putImageData(source, 0, 0);
    /* 只有真跑了逐像素那一遍才 +1 —— 它是"这次改动到底省下了什么"的唯一读数,
       本地测试与设备端探针都读它(tests/render-adjust.test.mjs)。 */
    CACHE.passes += 1;
    return true;
  }

  /* 已经锐化好的那一张原图(带缓存的出路)。清晰度在中性时**原样返回图片本身**,
     一个像素都不碰 —— 那是最常见的日常(清晰度默认 0)。
     取像素失败 ⇒ null,调用方退回原图(不锐,但不消失)。 */
  function clarityBase(image, settings) {
    var size = imageSize(image);
    var key = clarityKey(image, settings);
    if (CACHE.key === key && CACHE.canvas &&
      CACHE.canvas.width === size.width && CACHE.canvas.height === size.height) return CACHE.canvas;
    var canvas = CACHE.canvas || (CACHE.canvas = createCanvas());
    if (!canvas) return null;
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;
    var context = canvas.getContext("2d");
    if (!context) return null;
    context.clearRect(0, 0, size.width, size.height);
    context.drawImage(image, 0, 0, size.width, size.height);
    if (!sharpenCanvas(context, size.width, size.height, sharpenAmount(settings))) {
      CACHE.key = "";
      return null;
    }
    CACHE.key = key;
    return canvas;
  }

  /* 把一张已经解码好的图按这组参数画到画布上。画布按**图片自己的像素**建,
     缩放交给外面的 CSS 变换 —— 放大时是画布在放大,不是重画一遍。
     options.draft:拖动滑杆期间的那一帧。**只有"这一帧真的要跑像素过程"时才降分辨率** ——
     缓存里已经有这一档清晰度时,连草稿都不必(那一帧本来就是 GPU 的事)。 */
  function draw(canvas, image, value, options) {
    if (!canvas || !image) return false;
    var size = imageSize(image);
    if (!size.width || !size.height) return false;
    var settings = normalize(value);
    var amount = sharpenAmount(settings);
    var draft = Boolean(options && options.draft) && amount > 0 &&
      CACHE.key !== clarityKey(image, settings);
    var scale = draft ? DRAFT_SCALE : 1;
    var drawWidth = Math.max(1, Math.round(size.width * scale));
    var drawHeight = Math.max(1, Math.round(size.height * scale));
    if (canvas.width !== drawWidth) canvas.width = drawWidth;
    if (canvas.height !== drawHeight) canvas.height = drawHeight;
    var context = canvas.getContext("2d");
    if (!context) return false;
    /* 底图:清晰度中性就是原图;有清晰度就是缓存里那张"已经锐化好的";草稿帧直接拿原图,
       锐化在低分辨率画布上就地做一遍(草稿不进缓存 —— 它不能冒充完整分辨率那一张)。 */
    var base = amount && !draft ? (clarityBase(image, settings) || image) : image;
    context.clearRect(0, 0, drawWidth, drawHeight);
    context.filter = colorFilter(settings);
    context.drawImage(base, 0, 0, drawWidth, drawHeight);
    context.filter = "none";
    if (draft) sharpenCanvas(context, drawWidth, drawHeight, amount);
    if (settings.enabled !== false && settings.glow > 0) {
      context.save();
      context.globalCompositeOperation = "screen";
      context.globalAlpha = Math.min(0.62, settings.glow / 150);
      context.filter = glowFilter(settings);
      context.drawImage(image, 0, 0, drawWidth, drawHeight);
      context.restore();
    }
    return true;
  }

  app.services.renderAdjust = {
    KEYS: KEYS,
    RANGE: RANGE,
    DEFAULTS: DEFAULTS,
    display: display,
    shape: shape,
    normalize: normalize,
    stored: stored,
    isNeutral: isNeutral,
    colorFilter: colorFilter,
    glowFilter: glowFilter,
    sharpenAmount: sharpenAmount,
    draw: draw,
    internals: {
      clampKey: clampKey,
      laplacian: laplacian,
      DRAFT_SCALE: DRAFT_SCALE,
      /* 逐像素那一遍跑了几次 —— "调色滑竿为什么卡"这件事的唯一读数。
         forget() 只是把缓存忘掉(测试之间互不干扰),不动计数。 */
      pixelPasses: function () { return CACHE.passes; },
      forget: function () { CACHE.key = ""; CACHE.canvas = null; }
    }
  };
})(window.posegi);

