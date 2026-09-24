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
 *   bridge     Hermit Bridge 是否就绪(开发模式同步时应当为真)
 */
(function (app) {
  "use strict";

  function checkNamespace() {
    var missing = [];
    [["utils", app.utils], ["i18n", app.i18n], ["runtime", app.runtime], ["rig", app.rig],
      ["platform.hermit", app.platform.hermit], ["services.store", app.services.store],
      ["services.providers", app.services.providers], ["services.imageEngine", app.services.imageEngine],
      ["components.ui", app.components.ui], ["components.viewport", app.components.viewport],
      ["components.gallery", app.components.gallery], ["components.settings", app.components.settings],
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

  async function checkBridge() {
    await app.platform.hermit.awaitReady(1200);
    var ready = app.platform.hermit.available();
    return { ok: ready, detail: ready ? "Hermit Bridge 已就绪" : "没有宿主 Bridge,当前是浏览器降级环境" };
  }

  async function run() {
    var report = { version: app.version, at: new Date().toISOString(), checks: {}, ok: true };
    report.checks.namespace = checkNamespace();
    report.checks.rig = checkRig();
    report.checks.three = checkThree();
    report.checks.webgl = checkWebgl();
    report.checks.bridge = await checkBridge();
    report.checks.engine = {
      ok: true,
      detail: app.i18n.text("生图链路尚未实现(框架阶段)", "Generation pipeline not implemented yet (framework stage)")
    };
    Object.keys(report.checks).forEach(function (name) {
      if (!report.checks[name].ok) report.ok = false;
    });
    window.__posegiSelfTest = report;
    return report;
  }

  app.features.selfTest = { run: run };
})(window.posegi);
