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
  /* 任取一个垂直于 u 的单位向量。三个候选轴里至少有两个与 u 不共线,所以必有一个可用。
     只用在"膝盖恰好压在轴上、方位无从谈起"的退化时刻 —— 那种情况下两侧等价,
     取哪一侧都行(调用方还会两个都试一遍)。 */
  function anyPerpendicular(u) {
    return perpendicular({ x: 1, y: 0, z: 0 }, u)
      || perpendicular({ x: 0, y: 0, z: 1 }, u)
      || perpendicular({ x: 0, y: 1, z: 0 }, u);
  }
  /* 某个关节的"左右轴"在 bbox 空间的方向 —— 3x3 行主序朝向矩阵的第一列。
     膝与肘只能在矢状面里弯,而这个轴正是矢状面的法线,所以它决定"往哪边鼓"。
     **关键在于它取的是一个 IK 不会去动的关节**(骨盆):拿"当前膝位"当参考时,
     膝一旦顶到关节极限就偏离交圆,那个偏差会一步步把方位推向侧方(实测递推拖动
     累积出 225mm 的侧偏);骨盆不会被 IK 改动,方位因此是稳的。 */
  function lateralAxis(name, snapped) {
    var frame = name ? snapped[name] : null;
    if (!frame || !frame.orientation) return { x: 1, y: 0, z: 0 };
    var m = frame.orientation;
    return unit({ x: m[0], y: m[3], z: m[6] }) || { x: 1, y: 0, z: 0 };
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

  /* ---- 两骨链的"膝盖朝哪边"这个自由度 ----
   *
   * 余弦定理只定下"膝到髋 = l1",没定膝盖落在"绕髋→目标轴的那一圈"的哪个方位上。
   * 那一圈是个圆:圆心在轴上距髋 l1·cosα,半径 r = l1·sinα。
   * **轴上互为 180° 的两个膝位,恰好一个让膝处于合法屈位,另一个是反关节。**
   *
   * 曾经的做法是拿一个"极点方向"去挑:用静止姿态(后来又改成当前姿态)屈一下膝、
   * 看踝往哪挪、取反,当作"膝该鼓出去的方向"。它在直觉上成立,但数学上是个近似:
   * **踝的位移方向只在腿接近伸直时才垂直于腿**;腿弯到 60° 以上,这个方向就与
   * "膝该朝哪"脱钩了。真机上表现为拖脚到髋正前方时膝盖猛地翻到另一侧
   * (实测膝位移跳变 460mm、末端残差 524mm、膝角被夹到 0.5°、整条腿锁死)。
   *
   * 现在不猜方向:**两个候选膝位都解一遍,取末端残差小的那个**。合法的那个膝角在
   * 允许窗口内、末端能到目标;非法的那个膝角越界被 clamp、整条腿被拉直、差出几十厘米。
   * 判据只依赖"解出来好不好",不含任何符号约定,也不假设人物朝向哪边。
   *
   * 初始方位仍取"当前膝盖实际所在的那一侧"(膝相对交圆圆心的垂直分量),这样连续拖动
   * 时先试的那个通常就是对的,膝位随手指连续移动,不会在两个等价解之间来回挑。 */

  /* 按一个给定的膝位解一次两骨链,返回末端残差与试算后的姿态。
     不改传入的 angles —— 调用方会先试"当前膝盖所在的这一侧",不行才试另一侧。 */
  function aimTwoBone(angles, parentName, hingeName, effector, snapped, knee, target) {
    var trial = {};
    for (var key in angles) {
      if (Object.prototype.hasOwnProperty.call(angles, key)) trial[key] = angles[key];
    }
    aimJoint(trial, parentName, snapped, snapped[hingeName].origin, knee);
    var mid = app.rig.frames(trial);
    aimJoint(trial, hingeName, mid, mid[effector].origin, target);
    var landed = app.rig.frames(trial)[effector].origin;
    return { error: lengthOf(subtract(landed, target)), angles: trial };
  }

  /* ---- 解析式两骨 IK(肢体链只有两节时用它)----
   * 为什么必须有这一支:CCD 的每一步都是"把末端指向目标"。抬脚向前上方时,
   * 膝盖唯一合法的转动方向(往后弯)会让末端**先远离**目标,于是 CCD 一步都不肯迈,
   * 直接把小腿按在 0 度上 —— 整条腿退化成一根直杆绕髋摆动,表现是"拖脚踝往上,脚不动"。
   * 两骨链有闭式解,不需要靠迭代去碰运气:
   *   1) 记父骨长 L1、末段长 L2,求 d = |髋→目标|(夹到 [|L1−L2|, L1+L2] 内);
   *   2) 余弦定理给出父骨与"髋→目标"的夹角 α,以及膝角;
   *   3) 膝的位置 = 髋 + L1 × (沿"髋→目标"偏 α 角、且在**合法屈位**那一侧的方向);
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
      var cosA = Math.cos(alpha);
      var sinA = Math.sin(alpha);

      /* 两个候选膝位:方位取"矢状面内、垂直于目标方向"的两个方向(一个屈、一个反张),
         再靠下面的试算挑出合法的那个。矢状面用**骨盆的左右轴**来定,不用"当前膝在哪"或
         "大腿朝哪" —— 后两者会在拖脚时退化成浮点噪声:**脚往前下方拖时,"髋→目标"方向与
         大腿方向常常几乎共线**,它们的垂直分量就只剩噪声,膝盖于是撇向侧方、甚至整条腿
         解不出来(实测:以大腿方向为参考,"抬脚往前上"这个最基本的动作差了 270mm)。
         骨盆不被 IK 改动,它给的矢状面是稳的。另外大腿顶到 120° 上限时膝到不了交圆上,
         拿膝位当参考还会把这个偏差一步步累积成 225mm 的侧偏 —— 膝本该始终待在矢状面里。 */
      var pelvis = parent.parent ? app.rig.byName(parent.parent) : null;
      var side = unit(cross(u, lateralAxis(pelvis ? pelvis.name : "", snapped)))
        || anyPerpendicular(u);
      if (!side) break;
      /* 让"先试的那一侧"就是**当前膝盖真正待着的那一侧** —— 拖动时它必须先被试到,
         否则会从当前姿态跳到另一个等价解上。 */
      var circleCenter = {
        x: hip.x + u.x * l1 * cosA,
        y: hip.y + u.y * l1 * cosA,
        z: hip.z + u.z * l1 * cosA
      };
      if (dot(subtract(snapped[hingeName].origin, circleCenter), side) < 0) {
        side = scale(side, -1);
      }

      /* 先解"当前这一侧",**只有它明显解不到时才允许翻到另一侧**。这道门槛就是
         "从当前状态开始算"的落点:膝盖的方位由当前姿态占住,不会被另一侧的等价解抢走。
         判据用比例(另一侧必须好过一半)而不是绝对差 —— 这样"两侧都被限位挡住"时
         保持当前侧不翻,只有"当前侧真的不行、另一侧行得通"才切过去。
         对照:手臂走 CCD,每步最多转 14°,天然从当前状态出发,所以从来没有这个问题
         —— 真机上"只有脚跳、手不跳"就是这个差别。 */
      var best = aimTwoBone(angles, parentName, hingeName, effector, snapped, {
        x: hip.x + l1 * (u.x * cosA + side.x * sinA),
        y: hip.y + l1 * (u.y * cosA + side.y * sinA),
        z: hip.z + l1 * (u.z * cosA + side.z * sinA)
      }, target);
      if (best.error > 0.015) {
        var other = aimTwoBone(angles, parentName, hingeName, effector, snapped, {
          x: hip.x + l1 * (u.x * cosA - side.x * sinA),
          y: hip.y + l1 * (u.y * cosA - side.y * sinA),
          z: hip.z + l1 * (u.z * cosA - side.z * sinA)
        }, target);
        if (other.error < best.error * 0.5) best = other;
      }
      angles[parentName] = best.angles[parentName];
      angles[hingeName] = best.angles[hingeName];
      changed[parentName] = angles[parentName];
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
