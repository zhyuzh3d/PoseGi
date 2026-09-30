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
 *   faceMask   正反着色的 shader 注入锚点是否还在、注入是否真的落上了
 *   engine     生图链路:模型卡 / 激活项 / 协议 / 分辨率与参考图强度是否自洽
 *   bridge     Haminn Bridge 是否就绪(开发模式同步时应当为真)
 */
(function (app) {
  "use strict";

  function checkNamespace() {
    var missing = [];
    [["utils", app.utils], ["i18n", app.i18n], ["runtime", app.runtime], ["rig", app.rig], ["ik", app.ik],
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

  /* 正反着色(viewport 的 shader 注入)为什么值得单列一条:
     它的注入点**全靠字符串匹配** —— three.js 里 chunk 一改名,replace 找不到锚点就
     原样返回:不报错、照样编译通过、只是颜色一点没变。这种静默失效没有任何报错可抓,
     只能自己守。所以查三件事:
       ① 两个锚点在 THREE.ShaderLib.physical 里还在不在;
       ② 编译过的源码里有没有我们那两行(没渲染过时查不到,那时不算失败);
       ③ 开关拨得动吗 —— 拨完立刻还原,不留副作用;
       ④ 几何上到底有没有烘出 aSide —— 漏了它,那一件会整块显示正面色(同样是静默失效)。
     顺带把 aSide 的覆盖面报出来。 */
  function checkFaceMask() {
    var viewport = app.components.viewport;
    var problems = [];
    var detail = "";
    var info = typeof viewport.maskInfo === "function" ? viewport.maskInfo() : null;
    var physical = window.THREE && window.THREE.ShaderLib ? window.THREE.ShaderLib.physical : null;

    if (!physical) {
      problems.push("拿不到 THREE.ShaderLib.physical");
    } else {
      if (physical.vertexShader.indexOf("#include <defaultnormal_vertex>") < 0) problems.push("顶点锚点 defaultnormal_vertex 不在了");
      if (physical.fragmentShader.indexOf("#include <encodings_fragment>") < 0) problems.push("片元锚点 encodings_fragment 不在了(three 是不是升到 r152+)");
    }

    if (!info) {
      problems.push("视口没有暴露正反着色");
    } else {
      if (!info.attached) problems.push("没有材质挂上正反着色");
      if (info.compiled) {
        if (info.vertex.indexOf("vSide = aSide") < 0) problems.push("顶点注入没落上");
        if (info.fragment.indexOf("uMaskFront, step(") < 0) problems.push("片元注入没落上");
      }
      if (!info.sided) problems.push("没有零件烘出 aSide,正反着色会整块是正面色");
      /* 三档循环:既要拨得动,也要**拨到预期的下一档**(档位算错时按钮会原地踏步) */
      var beforeMode = 0;
      if (typeof viewport.maskMode !== "function") {
        problems.push("视口没有暴露正反档位");
      } else {
        beforeMode = viewport.maskMode();
        var cycled = viewport.setFrontBackMask((beforeMode + 1) % 3);
        if (cycled === beforeMode) problems.push("正反着色拨不动");
        else if (cycled !== (beforeMode + 1) % 3) {
          problems.push("正反着色档位不对(期望 " + ((beforeMode + 1) % 3) + ",得到 " + cycled + ")");
        }
        viewport.setFrontBackMask(beforeMode);
      }
      detail = info.attached + " 处材质," + info.sided + " 件几何带 aSide,混色 "
        + Number(info.mix).toFixed(2) + ",档位 " + beforeMode
        + (info.compiled ? ",注入已编译" : ",尚未渲染故未查注入");
    }

    return { ok: problems.length === 0, detail: problems.length ? problems.join(";") : detail };
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
    report.checks.faceMask = checkFaceMask();
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
