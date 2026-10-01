/* 自检:把"这一版到底能不能跑"变成一组可读的事实
 *
 * 责任:检查环境与骨架完整性,结果挂到 window.__posegiSelfTest,供设备端页面状态读取。
 * 约束:只读不写,不发起生图请求,不弹窗打扰用户。
 *
 * 检查项:
 *   namespace  模块装配是否完整(各层该有的对象都在)
 *   rig        骨骼数据是否自洽(父关节先于子关节、角度在界内)
 *   three      内置 three.js 是否加载
 *   webgl      设备 WebGL 是否可用(决定 3D 视口能否显示)
 *   stageHit   画布是否真的能被点中(有透明层盖住时触摸会被吃掉)
 *   statusLine 状态行是否落在顶栏卡片下方并留出竖向间距
 *   skeleton   彩色骨架投影得全不全、真画一遍落没落像素、覆盖层吃不吃指针事件
 *   engine     生图链路:模型卡 / 激活项 / 协议 / 分辨率与参考图强度是否自洽
 *   bridge     Haminn Bridge 是否就绪(开发模式同步时应当为真)
 */
(function (app) {
  "use strict";

  function checkNamespace() {
    var missing = [];
    [["utils", app.utils], ["i18n", app.i18n], ["runtime", app.runtime], ["rig", app.rig], ["ik", app.ik],
      ["skeleton", app.skeleton],
      ["platform.haminn", app.platform.haminn], ["services.assets", app.services.assets],
      ["services.store", app.services.store],
      ["services.providers", app.services.providers], ["services.translate", app.services.translate],
      ["services.imageEngine", app.services.imageEngine],
      ["components.ui", app.components.ui], ["components.viewport", app.components.viewport],
      ["components.gallery", app.components.gallery], ["components.renderPreview", app.components.renderPreview],
      ["components.settings", app.components.settings],
      ["features.poser", app.features.poser], ["features.editor", app.features.editor]
    ].forEach(function (entry) {
      if (!entry[1]) missing.push(entry[0]);
    });
    return { ok: missing.length === 0, detail: missing.length ? "缺少 " + missing.join(", ") : app.rig.names().length + " 个关节已登记" };
  }

  function checkRig() {
    var seen = {};
    var problems = [];
    app.rig.joints.forEach(function (joint) {
      if (seen[joint.name]) problems.push("重名关节 " + joint.name);
      if (joint.parent && !seen[joint.parent]) problems.push(joint.name + " 的父关节 " + joint.parent + " 排在其后");
      if (!joint.pivot && !(joint.length > 0)) problems.push(joint.name + " 的骨骼长度不是正数");
      if (!joint.pivot && !(joint.radius > 0)) problems.push(joint.name + " 的半径不是正数");
      seen[joint.name] = true;
    });
    var angles = app.rig.normalize(app.rig.applyPreset(app.rig.defaultAngles(), "walk"));
    Object.keys(angles).forEach(function (name) {
      app.rig.angleKeys.forEach(function (key) {
        var value = angles[name][key];
        if (value < app.rig.limits.min || value > app.rig.limits.max) problems.push(name + "." + key + " 越界");
      });
    });
    return { ok: problems.length === 0, detail: problems.length ? problems.join(";") : app.rig.joints.length + " 个关节、父链与角度都自洽" };
  }

  function checkThree() {
    var loaded = typeof window.THREE !== "undefined";
    return { ok: loaded, detail: loaded ? "three.js r" + window.THREE.REVISION : "内置 three.js 没加载" };
  }

  function checkWebgl() {
    var available = app.components.viewport.available();
    return {
      ok: available,
      detail: available ? "WebGL 可用" : app.components.viewport.reason()
    };
  }

  /* "画布必须真的能被点中" —— 这一条守的是一整类 bug。
     只要有任何一个透明的全屏元素压在舞台上面(典型是"忘了处理 hidden 属性"的提示层),
     画布就收不到任何触摸:表现是"整个 3D 区域完全点不动",而且不报错、不白屏、截图也看不出来。
     真机上踩过一次:`.stage-fallback` 的 `display:grid` 盖过了浏览器默认的 `[hidden]{display:none}`,
     于是那个空提示层一直铺在画布上,把每一次触摸都吃掉(底部 dock 在舞台之外,照样能点,
     所以现象是"只有按钮有反应")。只有 elementFromPoint 能发现,测试点避开底部按钮条与提示行。 */
  function checkStageHit() {
    var canvas = document.querySelector("#stage-viewport canvas");
    if (!canvas) return { ok: false, detail: "舞台上没有画布" };
    var rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return { ok: false, detail: "画布尺寸为 0" };
    var probes = [[0.5, 0.2], [0.5, 0.45], [0.5, 0.7], [0.2, 0.4], [0.8, 0.4]];
    var blocked = [];
    probes.forEach(function (pair) {
      var x = Math.round(rect.left + rect.width * pair[0]);
      var y = Math.round(rect.top + rect.height * pair[1]);
      var element = document.elementFromPoint(x, y);
      if (element !== canvas && (!element || !canvas.contains(element))) {
        blocked.push(pair[0] + "," + pair[1] + " → " + (element ? element.tagName.toLowerCase() + (element.id ? "#" + element.id : "") : "null"));
      }
    });
    return {
      ok: blocked.length === 0,
      detail: blocked.length === 0
        ? "画布整块可点(" + probes.length + " 个采样点都直接命中 canvas)"
        : "有元素盖在画布上,触摸会被吃掉:" + blocked.join(";")
    };
  }

  /* 状态行必须在顶栏卡片**下方**、并且留出竖向间距
     (2026-09-25 用户要求:「放到顶部标题栏下面位置(留竖向间距)」)。
     顶栏是绝对定位的浮层,所以"看起来在下面"完全靠 CSS 里那个 top 的数值 ——
     数值改错只会表现为"提示跑到别处去了":不报错、不白屏、也不影响任何功能。
     量矩形最省事,顺手把间距报出来 —— 它同时就是"有没有留竖向间距"的答案。 */
  function checkStatusLine() {
    var line = document.getElementById("status-line");
    var card = document.querySelector(".topbar-card");
    if (!line || !card) return { ok: false, detail: "找不到状态行或顶栏卡片" };
    var lineRect = line.getBoundingClientRect();
    var cardRect = card.getBoundingClientRect();
    if (lineRect.width < 2) return { ok: false, detail: "状态行没有宽度,量不到位置" };
    var gap = Math.round(lineRect.top - cardRect.bottom);
    if (gap <= 0) {
      return {
        ok: false,
        detail: "状态行没在顶栏下方(行顶 " + Math.round(lineRect.top) + "px,卡片底 " + Math.round(cardRect.bottom) + "px)"
      };
    }
    return { ok: true, detail: "状态行在顶栏卡片下方 " + gap + "px,行宽 " + Math.round(lineRect.width) + "px" };
  }

  /* 彩色骨架为什么值得单列一条:它有**两处会静默失效**的地方,而失效之后画面照样出得来,
     只是"发给模型的那张图"不是它该有的样子 —— 那正是这一轮要修的故障本身。
       ① 投影断了:骨架投不出那 14 根骨头(或下游认不全 18 个键位),渲染器会退回
          "一张全黑图" —— 不报错、不白屏,模型收到的是一张没有姿势的黑图;
          (判据在 skeleton.keypoints:缺一根骨头就返回 null,那才是唯一的开关。)
       ② 覆盖层把舞台吃掉了:那一层若忘了 pointer-events: none,整块舞台点不动,
          而底部按钮在舞台之外照样能点 —— 与 stage-fallback 是同一个坑,
          而且它**没有任何行为特征**,只有量计算样式才看得出来。
     所以这里查三条事实,而不是"函数在不在":
       ① 投影真的出得全;
       ② 真画一遍**真的落下了像素**(数出来:几根肢体、几个关节点、几个脸点、几种肢体颜色);
       ③ 覆盖层挂上了、尺寸是正的、computedStyle 里指针事件是 none。
     顺带报出当前档位(它是页面状态里唯一会变的那一项)。 */
  function checkSkeleton() {
    var viewport = app.components.viewport;
    var renderer = app.skeleton;
    if (!renderer || typeof renderer.paint !== "function") {
      return { ok: false, detail: "没有挂上彩色骨架渲染器" };
    }
    if (typeof viewport.skeletonInfo !== "function") {
      return { ok: false, detail: "视口没有暴露骨架覆盖层" };
    }
    /* 视口本身就起不来时这一项跟着跳过:没有相机就没有投影,也没有那块画布。
       (webgl 那一条已经把这件事报出来了,这里再红一次只是噪声。) */
    if (!viewport.available()) {
      return { ok: true, detail: "3D 视口不可用,骨架这一项一并跳过(见 webgl)" };
    }

    var problems = [];
    var detail = "";
    var info = viewport.skeletonInfo();
    if (!info.segments) problems.push("投影不出骨架线段");
    else if (!info.bones) problems.push("投影出的骨头不全,渲染器认不出 18 个键位");

    /* 真画一遍:用**当前这具骨架的投影**画在离屏画布上,再数像素。
       不拿屏上那一层来查 —— 它平时是关着的,关了也不该算失败。 */
    var canvas = document.createElement("canvas");
    canvas.width = 576;
    canvas.height = 1024;
    var context = canvas.getContext("2d");
    var stats = renderer.paint(context, viewport.poseSegments({ width: 576, height: 1024 }),
      { width: 576, height: 1024 });
    if (!stats.drawn) {
      problems.push("画不出骨架(缺骨头就直接不画,也不会出半张图)");
    } else {
      var expected = renderer.limbs.length;
      if (stats.limbs !== expected) problems.push("肢体只画了 " + stats.limbs + " 根,应有 " + expected + " 根");
      if (stats.face !== 68) problems.push("脸点阵不是 68 点(收到 " + stats.face + ")");
      var palette = countPalette(context, 576, 1024, renderer.palette);
      if (palette < expected) problems.push("画面上只出现了 " + palette + " 种肢体颜色,应有 " + expected + " 种");
      detail = stats.limbs + " 根肢体 / " + stats.joints + " 个关节点 / " + stats.face + " 个脸点,"
        + palette + " 种颜色";
    }

    var overlay = document.querySelector(".stage-skeleton");
    if (!overlay) {
      problems.push("屏上没有骨架覆盖层");
    } else {
      if (!(overlay.width > 0 && overlay.height > 0)) problems.push("骨架覆盖层尺寸是 0");
      var style = window.getComputedStyle(overlay);
      /* 这一条是"还能不能拖关节"的机器判据:覆盖层必须完全不吃指针事件 */
      if (style.pointerEvents !== "none") problems.push("骨架覆盖层会吃掉指针事件,关节就拖不动了");
      detail += ",覆盖层 " + overlay.width + "×" + overlay.height + "(" + style.pointerEvents + ")";
    }
    detail += ",当前" + (viewport.skeletonMode() ? "显示中" : "关闭");

    return { ok: problems.length === 0, detail: problems.length ? problems.join(";") : detail };
  }

  /* 数一数画面上出现了几种**肢体颜色**:按色板逐个对色,而不是数"有没有非黑像素" ——
     后者在只画出一根线的时候也是绿的,断不出"整张图只画了一半"。
     对的是精确值:线宽有 18 像素,芯里那些像素就是 strokeStyle 原样写下去的字节
     (抗锯齿只影响边上那一圈细边)。 */
  function countPalette(context, width, height, palette) {
    var index = {};
    palette.forEach(function (color, at) {
      index[color[0] + "," + color[1] + "," + color[2]] = at + 1;
    });
    var seen = {};
    var data = context.getImageData(0, 0, width, height).data;
    for (var at = 0; at < data.length; at += 4) {
      var hit = index[data[at] + "," + data[at + 1] + "," + data[at + 2]];
      if (hit) seen[hit] = true;
    }
    return Object.keys(seen).length;
  }

  async function checkBridge() {
    await app.platform.haminn.awaitReady(1200);
    var ready = app.platform.haminn.available();
    return { ok: ready, detail: ready ? "Haminn Bridge 已就绪" : "没有宿主 Bridge,当前是浏览器降级环境" };
  }

  /* 生图链路:查的是"配置能不能落到一次真实调用上" —— 有卡、激活项指向其中一张、
     协议认识、CHP 卡带任务、分辨率是正数,以及图片资产层在不在。
     它**不发起任何请求**(自检不许弹窗、不许生图),所以只验装配与配置自洽。
     旧的这里是"尚未实现(框架阶段)"的占位;现在是真检查,失败能指出是哪一项。 */
  function checkEngine() {
    var providers = app.services.providers;
    var models = (app.config && app.config.models) || [];
    var active = providers.active();
    var ids = providers.protocols.map(function (item) { return item.id; });
    var problems = [];
    if (!models.length) problems.push("没有模型卡");
    if (!active) problems.push("没有激活的模型卡");
    else {
      if (ids.indexOf(active.protocol) < 0) problems.push("未知协议 " + active.protocol);
      if (active.protocol === "chp" && !active.task) problems.push("CHP 卡没有任务");
      /* 分辨率取**真正会发出去**的那条(见 providers.resolutionText):chp 卡上卡里存的
         那条只是"上次挑的",插件当前没有 9:16 档时它是空串 —— 那正是要报出来的事。 */
      if (!/^\d+x\d+$/.test(providers.resolutionText(active))) problems.push("这个场景没有可用的分辨率");
      if (!(Number(active.refStrength) > 0)) problems.push("参考图强度不是正数");
    }
    if (typeof app.services.assets.resolve !== "function") problems.push("图片资产层没装配");
    return {
      ok: problems.length === 0,
      detail: problems.length ? problems.join(";")
        : models.length + " 张模型卡,使用中:" + active.name + "(" + active.protocol + " / " + providers.resolutionText(active) + " / 强度 " + active.refStrength + ")"
    };
  }

  async function run() {
    var report = { version: app.version, at: new Date().toISOString(), checks: {}, ok: true };
    report.checks.namespace = checkNamespace();
    report.checks.rig = checkRig();
    report.checks.three = checkThree();
    report.checks.webgl = checkWebgl();
    report.checks.stageHit = checkStageHit();
    report.checks.statusLine = checkStatusLine();
    report.checks.skeleton = checkSkeleton();
    report.checks.engine = checkEngine();
    report.checks.bridge = await checkBridge();
    Object.keys(report.checks).forEach(function (name) {
      if (!report.checks[name].ok) report.ok = false;
    });
    window.__posegiSelfTest = report;
    return report;
  }

  app.features.selfTest = { run: run };
})(window.posegi);
