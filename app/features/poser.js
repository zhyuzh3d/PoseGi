/* 摆姿编排:当前姿态是谁、怎么改、改完通知谁
 *
 * 责任:持有"当前姿态"这一唯一真相,并把每次改动广播给视口与界面。
 * 事件:pose:changed { angles, joint, source } / pose:selected { joint }
 * 约束:不碰 DOM,不碰 three.js;所有角度都经 app.rig 归一化。
 *
 * 现状:骨架。选中关节后的交互(点选、拖拽、滑杆)与撤销栈都还没做。
 */
(function (app) {
  "use strict";

  var angles = null;

  function init() {
    angles = app.rig.defaultAngles();
    app.state.selectedJoint = "";
    app.state.poseName = "";
    app.state.dirty = false;
    return angles;
  }

  function current() {
    if (!angles) init();
    return angles;
  }

  function changed(joint, source) {
    app.state.dirty = true;
    app.events.emit("pose:changed", { angles: current(), joint: String(joint || ""), source: String(source || "") });
  }

  function setJointAngle(name, key, value) {
    var joint = app.rig.byName(name);
    if (!joint) throw new Error("未知关节:" + String(name));
    if (app.rig.angleKeys.indexOf(key) < 0) throw new Error("未知旋转轴:" + String(key));
    current()[name][key] = app.utils.clamp(Number(value), app.rig.limits.min, app.rig.limits.max);
    current()[name][key] = app.utils.normalizeAngle(current()[name][key]);
    changed(name, "slider");
    return current()[name][key];
  }

  /* 一次改多个通道:拖拽一次要同时动屈伸与侧摆,分两次调用会多发一次事件与一次重绘 */
  function patchJoint(name, patch) {
    var joint = app.rig.byName(name);
    if (!joint) throw new Error("未知关节:" + String(name));
    var applied = {};
    app.rig.angleKeys.forEach(function (key) {
      if (!patch || patch[key] === undefined || patch[key] === null) return;
      current()[name][key] = app.utils.normalizeAngle(
        app.utils.clamp(Number(patch[key]), app.rig.limits.min, app.rig.limits.max)
      );
      applied[key] = current()[name][key];
    });
    if (Object.keys(applied).length) changed(name, "drag");
    return applied;
  }

  function selectJoint(name) {
    app.state.selectedJoint = name && app.rig.byName(name) ? String(name) : "";
    app.events.emit("pose:selected", { joint: app.state.selectedJoint });
    return app.state.selectedJoint;
  }

  function applyPreset(presetId) {
    angles = app.rig.applyPreset(current(), presetId);
    app.state.poseName = String(presetId || "");
    changed("", "preset");
    return angles;
  }

  function mirrorNow() {
    angles = app.rig.mirror(current());
    changed("", "mirror");
    return angles;
  }

  function resetNow() {
    angles = app.rig.defaultAngles();
    app.state.poseName = "stand";
    changed("", "reset");
    return angles;
  }

  function load(pose) {
    var record = app.rig.parse(pose);
    if (!record) throw new Error("姿态数据不合法");
    angles = record.angles;
    app.state.poseName = record.name;
    changed("", "load");
    return angles;
  }

  function save(name) {
    app.state.poseName = String(name || app.state.poseName || "").trim();
    if (!app.state.poseName) throw new Error("请先给姿态起个名字");
    return app.services.store.savePose({ name: app.state.poseName, angles: current() });
  }

  /* 撤销栈:与姿态改动同源,先留接口,实现见 README 的"目标能力" */
  function undo() { throw new Error("撤销尚未实现"); }
  function redo() { throw new Error("重做尚未实现"); }

  app.features.poser = {
    init: init,
    angles: current,
    setJointAngle: setJointAngle,
    patchJoint: patchJoint,
    selectJoint: selectJoint,
    applyPreset: applyPreset,
    mirror: mirrorNow,
    reset: resetNow,
    load: load,
    save: save,
    undo: undo,
    redo: redo
  };
})(window.posegi);
