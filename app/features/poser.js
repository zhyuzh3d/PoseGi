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
    /* 收口交给 rig.clampJoint:它认得每个关节自己的可转范围(手腕 ±80、脚踝 -50..25),
       而且记的是"相对静止姿态"的增量 —— rest 来自模型,可能是任意值。 */
    current()[name][key] = app.rig.clampJoint(name, key, value);
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
      current()[name][key] = app.rig.clampJoint(name, key, patch[key]);
      applied[key] = current()[name][key];
    });
    if (Object.keys(applied).length) changed(name, "drag");
    return applied;
  }

  /* IK 一次会改一整条链上的若干关节(肩+上臂+前臂),同样一次事件通知完 */
  function patchJoints(map, source) {
    var applied = {};
    Object.keys(map || {}).forEach(function (name) {
      if (!app.rig.byName(name)) return;
      var value = map[name] || {};
      var angle = current()[name];
      var touched = false;
      app.rig.angleKeys.forEach(function (key) {
        if (value[key] === undefined || value[key] === null) return;
        angle[key] = app.rig.clampJoint(name, key, value[key]);
        touched = true;
      });
      if (touched) applied[name] = angle;
    });
    if (Object.keys(applied).length) changed("", source || "ik");
    return applied;
  }

  /* 选中哪个关节、以及选中的是它的"连接杆"还是"节点" —— 后者决定拖动是旋转还是移动 */
  function selectJoint(name, part) {
    app.state.selectedJoint = name && app.rig.byName(name) ? String(name) : "";
    app.state.selectedPart = part === "node" ? "node" : "bone";
    app.events.emit("pose:selected", { joint: app.state.selectedJoint, part: app.state.selectedPart });
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

  /* 回到默认站姿。silent 用于"换人物造型"这类要连骨架一起换的场景:
     中间那一次重绘是旧网格配新骨架,虽然只有一帧,但会闪一下;
     静默复位之后由调用方统一重画一次。 */
  function resetNow(silent) {
    angles = app.rig.defaultAngles();
    app.state.poseName = "stand";
    if (silent !== true) changed("", "reset");
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
    patchJoints: patchJoints,
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
