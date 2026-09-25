/* 反向运动学:把一个关节的起点拉到目标点上
 *
 * 责任:纯数学。输入姿态 + 效应器 + 目标点,输出改过哪些关节。不碰 DOM,不依赖 three.js。
 *
 * 为什么自己写:三个现成的 MIT 库要么只有 ESM、要么要打包、要么硬依赖 SkinnedMesh
 * (three.js 自带的 CCDIKSolver 直接读 mesh.skeleton.bones);把第三方源码改造成
 * 经典脚本又会违反 AGENTS.md 里"vendor 目录原样发行"的约定。CCD 本身只有几十行。
 *
 * 算法分两支:
 *   1) **恰好两节的肢体链**(大腿 + 小腿)走**闭式解**。见 solveTwoBone 的注释:
 *      两骨链的膝盖位置由余弦定理唯一确定,而 CCD 在"直腿"这个起点上是退化的
 *      (它的每一步都是"把末端指向目标",抬脚向前上时膝唯一合法的转动方向会让末端
 *      暂时远离目标,于是它一步都不迈,整条腿退化成绕髋摆动的直杆)。
 *   2) 其余(躯干、三节的胳膊)走 CCD:每一轮从最靠近根的那节开始,
 *      依次把"关节→效应器"这条向量转到"关节→目标"上;每转一次就重新做一遍前向运动学,
 *      后面的关节才知道自己现在在哪。单次单关节的转角有上限,所以结果不会突然翻折。
 *
 * 坐标系:全部在 bbox 局部空间里算 —— 与 rig.frames 的输出一致。
 *   世界空间到 bbox 空间的换算由视口负责(它是唯一知道相机与场景的人)。
 *
 * 换回欧拉角的推导:
 *   关节在 bbox 空间里的朝向 = 父朝向 · 局部旋转矩阵,记作 P·L。
 *   我们要的是"在 bbox 空间里再叠加一个 Δ",即 P·L' = Δ·P·L,于是
 *     L' = P⁻¹ · Δ · P · L
 *   再把 L' 用 rig.eulerFromMatrix 解回 (x, y, z)。取逆用转置即可,旋转矩阵是正交的。
 *
 * 约束:不使用可选链、空值合并与 ES Modules(旧 WebView 不支持)。
 */
(function (app) {
  "use strict";

  var ITERATIONS = 12;
  var MAX_STEP = 14 * Math.PI / 180;   /* 单次迭代单个关节最多转 14 度 */
  var TOLERANCE = 0.004;               /* 4mm 以内就算到位 */

  function subtract(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function cross(a, b) {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  }
  function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function lengthOf(v) { return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }
  function scale(v, k) { return { x: v.x * k, y: v.y * k, z: v.z * k }; }
  function unit(v) {
    var length = lengthOf(v);
    if (!(length > 1e-9)) return null;
    return { x: v.x / length, y: v.y / length, z: v.z / length };
  }
  /* v 在"垂直于 u 的平面"上的分量,已归一化;退化(v 与 u 共线)时返回 null */
  function perpendicular(v, u) {
    var projected = subtract(v, scale(u, dot(v, u)));
    return unit(projected);
  }

  function clamp(value, min, max) { return value < min ? min : (value > max ? max : value); }

  /* 关节自身的角度上限由 rig.clampJoint 一家说了算(它读关节表里的 limit,
     记的是"相对静止姿态的增量",而 rest 来自模型、可能是任意值)。
     这里不再另判一次 —— 两个地方各判一套,迟早各说各话。 */
  function clampChannel(joint, key, value) {
    return app.rig.clampJoint(joint.name, key, value);
  }

  function parentOrientation(name, computed) {
    var joint = app.rig.byName(name);
    var parent = joint && joint.parent ? app.rig.byName(joint.parent) : null;
    if (!parent) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    return computed[parent.name].orientation;
  }

  /* 把一个关节转到"让它下游的某一点落到目标上"。转轴取 (from × to),角度取满角
     (不像 CCD 那样每步只给 14 度),再解回欧拉角过一遍收口。
     snapped 必须是"当前 angles 的前向运动学",否则 origin 与角度不是同一时刻的。 */
  function aimJoint(angles, name, snapped, fromPoint, toPoint) {
    var joint = app.rig.byName(name);
    if (!joint) return;
    var origin = snapped[name].origin;
    var from = subtract(fromPoint, origin);
    var to = subtract(toPoint, origin);
    var fromLength = lengthOf(from);
    var toLength = lengthOf(to);
    if (fromLength < 1e-6 || toLength < 1e-6) return;
    var axis = cross(from, to);
    var axisLength = lengthOf(axis);
    if (axisLength < 1e-9) return;
    var angle = Math.acos(clamp(dot(from, to) / (fromLength * toLength), -1, 1));
    if (!(angle > 1e-9)) return;

    var orientation = parentOrientation(name, snapped);
    var delta = app.rig.axisAngleMatrix([axis.x / axisLength, axis.y / axisLength, axis.z / axisLength], angle);
    var inverse = app.rig.transpose(orientation);
    var local = app.rig.rotationMatrix(angles[name]);
    var updated = app.rig.matrixMultiply(inverse,
      app.rig.matrixMultiply(delta, app.rig.matrixMultiply(orientation, local)));
    var euler = app.rig.eulerFromMatrix(updated);
    angles[name] = {
      x: clampChannel(joint, "x", euler.x),
      y: clampChannel(joint, "y", euler.y),
      z: clampChannel(joint, "z", euler.z)
    };
  }

  /* 极点:屈这个关节时末端往哪挪 —— **反过来**的那一侧就是膝(或肘)该鼓出去的方向。
     人体上:屈膝时踝往后走、膝往前鼓;屈肘时腕往前走、肘往后鼓。
     这里不写死"膝朝前",而是按关节自己的窗口量一遍位移来定方向 —— 换模型、
     换关节命名都不会错。 */
  function flexionPole(hingeName, effectorName) {
    var hinge = app.rig.byName(hingeName);
    var range = hinge.limit ? hinge.limit.x : null;
    var sign = -1;
    if (range) sign = Math.abs(range[1]) > Math.abs(range[0]) ? 1 : -1;
    var rest = Number(hinge.rest[0]) || 0;
    var bent = app.rig.defaultAngles();
    bent[hingeName] = {
      x: app.rig.clampJoint(hingeName, "x", app.utils.normalizeAngle(rest + sign * 15)),
      y: bent[hingeName].y,
      z: bent[hingeName].z
    };
    if (Math.abs(app.utils.normalizeAngle(bent[hingeName].x - rest)) < 1e-6) return null;
    var base = app.rig.jointPositions(app.rig.defaultAngles())[effectorName].origin;
    var moved = app.rig.jointPositions(bent)[effectorName].origin;
    return unit({ x: base.x - moved.x, y: base.y - moved.y, z: base.z - moved.z });
  }

  /* ---- 解析式两骨 IK(肢体链只有两节时用它)----
   * 为什么必须有这一支:CCD 的每一步都是"把末端指向目标"。抬脚向前上方时,
   * 膝盖唯一合法的转动方向(往后弯)会让末端**先远离**目标,于是 CCD 一步都不肯迈,
   * 直接把小腿按在 0 度上 —— 整条腿退化成一根直杆绕髋摆动,表现是"拖脚踝往上,脚不动"。
   * 两骨链有闭式解,不需要靠迭代去碰运气:
   *   1) 记父骨长 L1、末段长 L2,求 d = |髋→目标|(夹到 [|L1−L2|, L1+L2] 内);
   *   2) 余弦定理给出父骨与"髋→目标"的夹角 α,以及膝角;
   *   3) 膝的位置 = 髋 + L1 × (沿"髋→目标"偏 α 角、且朝极点那一侧的方向);
   *   4) 转父关节把子关节原点送到膝上,转子关节把效应器送到目标上。
   * 第 4 步走的是同一套"转轴 + 解回欧拉角 + 收口",所以限位照旧是唯一收口点,
   * 这里不可能绕过它摆出反关节。迭代几轮只为收掉欧拉分解与限位夹取的残差。 */
  var TWO_BONE_PASSES = 8;

  function solveTwoBone(angles, chain, effector, target, tolerance, changed) {
    var parentName = chain[0];
    var hingeName = chain[1];
    var parent = app.rig.byName(parentName);
    var hinge = app.rig.byName(hingeName);
    var end = app.rig.byName(effector);
    /* 结构检查:必须真是"父 → 子 → 效应器"这样一条两节链,而且两段都得有长度。
       肩与上臂是**同原点**的(上臂相对肩的位移是 0),拖肘部时链是 [shoulder, upperArm],
       第一段长度为 0 —— 这种"退化两骨链"不是两骨问题,交给调用方退回 CCD。 */
    if (!parent || !hinge || !end) return false;
    if (hinge.parent !== parentName || end.parent !== hingeName) return false;

    var l1 = lengthOf({ x: hinge.offset[0], y: hinge.offset[1], z: hinge.offset[2] });
    var l2 = lengthOf({ x: end.offset[0], y: end.offset[1], z: end.offset[2] });
    if (!(l1 > 1e-6) || !(l2 > 1e-6)) return false;

    var pole = flexionPole(hingeName, effector);
    var applied = false;

    for (var pass = 0; pass < TWO_BONE_PASSES; pass += 1) {
      var snapped = app.rig.frames(angles);
      if (lengthOf(subtract(snapped[effector].origin, target)) < tolerance) break;

      var hip = snapped[parentName].origin;
      var toTarget = subtract(target, hip);
      var distance = lengthOf(toTarget);
      if (distance < 1e-6) break;
      var u = scale(toTarget, 1 / distance);
      var reach = clamp(distance, Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);

      var cosAlpha = clamp((l1 * l1 + reach * reach - l2 * l2) / (2 * l1 * reach), -1, 1);
      var alpha = Math.acos(cosAlpha);

      /* 膝该往哪边鼓:极点垂直于"髋→目标"的分量;极点与目标方向共线时退化成
         "当前膝相对这条线的偏移方向",再退化就用 hinge 轴与 u 的叉积(它一定垂直于 u)。 */
      var side = pole ? perpendicular(pole, u) : null;
      if (!side) side = perpendicular(subtract(snapped[hingeName].origin, hip), u);
      if (!side) {
        var hingeAxis = app.rig.matrixApply(
          parentOrientation(hingeName, snapped),
          app.rig.matrixApply(
            app.rig.rotationMatrix({ x: angles[hingeName].x, y: angles[hingeName].y, z: 0 }),
            [1, 0, 0]
          )
        );
        side = perpendicular({ x: hingeAxis[0], y: hingeAxis[1], z: hingeAxis[2] }, u);
      }
      if (!side) break;

      var kneeDirection = {
        x: u.x * Math.cos(alpha) + side.x * Math.sin(alpha),
        y: u.y * Math.cos(alpha) + side.y * Math.sin(alpha),
        z: u.z * Math.cos(alpha) + side.z * Math.sin(alpha)
      };
      var knee = {
        x: hip.x + kneeDirection.x * l1,
        y: hip.y + kneeDirection.y * l1,
        z: hip.z + kneeDirection.z * l1
      };

      aimJoint(angles, parentName, snapped, snapped[hingeName].origin, knee);
      changed[parentName] = angles[parentName];

      var after = app.rig.frames(angles);
      aimJoint(angles, hingeName, after, after[effector].origin, target);
      changed[hingeName] = angles[hingeName];
      applied = true;
    }
    return applied;
  }

  /* 求解。options:
   *   effector  要拉过去的关节名(拖动的是它的"起点")
   *   target    { x, y, z },bbox 局部空间
   *   chain     可选,要转动哪些关节(从根到末端)。默认取 rig.ikChain(effector)
   *   iterations / maxStep / tolerance  可选,覆盖默认值
   * 返回 { angles, changed }:angles 是归一化后的完整姿态,changed 只包含真正被改动的关节。 */
  function solve(pose, options) {
    var settings = options || {};
    var effector = String(settings.effector || "");
    var target = settings.target;
    var angles = app.rig.normalize(pose);
    var changed = {};

    if (!app.rig.byName(effector) || !target) return { angles: angles, changed: changed };
    var chain = settings.chain || app.rig.ikChain(effector);
    if (!chain.length) return { angles: angles, changed: changed };

    var iterations = Number(settings.iterations) > 0 ? Math.round(Number(settings.iterations)) : ITERATIONS;
    var maxStep = Number(settings.maxStep) > 0 ? Number(settings.maxStep) : MAX_STEP;
    var tolerance = Number(settings.tolerance) > 0 ? Number(settings.tolerance) : TOLERANCE;

    /* 恰好两节、且两段都有长度的肢体链(大腿 + 小腿)走解析式闭式解 —— CCD 在直腿
       起点上是退化的,只会把小腿按在 0 度,整条腿变成绕髋摆动的直杆。
       退化的两骨链(拖肘部时肩与上臂同原点)返回 false,照旧走下面的 CCD。
       见 solveTwoBone 的注释。 */
    if (chain.length === 2 && solveTwoBone(angles, chain, effector, target, tolerance, changed)) {
      return { angles: angles, changed: changed };
    }

    for (var pass = 0; pass < iterations; pass += 1) {
      var computed = app.rig.frames(angles);
      var error = lengthOf(subtract(computed[effector].origin, target));
      if (error < tolerance) break;

      for (var index = 0; index < chain.length; index += 1) {
        var name = chain[index];
        var joint = app.rig.byName(name);
        if (!joint) continue;

        /* 每转一个关节就重算一次前向运动学:链上剩余关节的位置都跟着变了 */
        var snapped = app.rig.frames(angles);
        var jointOrigin = snapped[name].origin;
        var from = subtract(snapped[effector].origin, jointOrigin);
        var to = subtract(target, jointOrigin);
        var fromLength = lengthOf(from);
        var toLength = lengthOf(to);
        if (fromLength < 1e-6 || toLength < 1e-6) continue;

        var axis = cross(from, to);
        var axisLength = lengthOf(axis);
        if (axisLength < 1e-9) continue;

        var raw = Math.acos(clamp(dot(from, to) / (fromLength * toLength), -1, 1));
        if (!(raw > 1e-6)) continue;
        var step = Math.min(raw, maxStep);

        var orientation = parentOrientation(name, snapped);
        var delta = app.rig.axisAngleMatrix([axis.x / axisLength, axis.y / axisLength, axis.z / axisLength], step);
        var inverse = app.rig.transpose(orientation);
        var local = app.rig.rotationMatrix(angles[name]);
        var updated = app.rig.matrixMultiply(inverse, app.rig.matrixMultiply(delta, app.rig.matrixMultiply(orientation, local)));
        var euler = app.rig.eulerFromMatrix(updated);

        angles[name] = {
          x: clampChannel(joint, "x", euler.x),
          y: clampChannel(joint, "y", euler.y),
          z: clampChannel(joint, "z", euler.z)
        };
        changed[name] = angles[name];
      }
    }

    return { angles: angles, changed: changed };
  }

  app.ik = {
    solve: solve,
    tolerance: function () { return TOLERANCE; },
    maxStep: function () { return MAX_STEP; }
  };
})(window.posegi);
