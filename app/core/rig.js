/* 骨骼与姿态数据模型:纯数据与纯数学,不碰 DOM,不依赖 three.js
 *
 * 约定:
 *   - 每个关节的骨骼从关节点沿自身局部 +Y 方向延伸 length。
 *   - offset 是相对父关节原点的局部位移,写在父关节的局部坐标系里。
 *     链条关节的 offset 就是 [0, 父关节长度, 0];肩、髋这类分支挂在父关节侧面。
 *   - rest 是静止姿态下的局部欧拉角(度),即默认站姿。
 *   - 姿态 = { 关节名: { x: 度, y: 度, z: 度 } },只有角度,没有位置。
 *
 * 层级(自外向内):
 *   world(场景) → bbox(人物子空间,可整体搬运) → broot(骨架顶层,转身/挪位)
 *   → hips(骨盆) → spine / thigh.L / thigh.R → ...
 *   bbox 不在这张表里,它是场景层的容器;broot 是骨架顶层且没有可渲染的骨骼。
 *
 * 关节命名:成对的肢体一律用 .L / .R 后缀,L 是角色自身的左侧(世界 +X)。
 *         这样镜像、左右同步、左右互换才有唯一解。
 *
 * 单位:米。默认身高约 1.74m,髋关节离地 0.95m。
 * 渲染在 app/components/viewport.js,本文件只负责"姿态是什么"。
 */
(function (app) {
  "use strict";

  var JOINTS = [
    /* 变换节点:没有可渲染的骨骼(pivot),只用来承载变换。
       参考系自外向内:world → bbox → broot → hips → 其余关节。
       bbox 不在本表里,它是场景层的容器(见 viewport.js);broot 是骨架顶层。 */
    { name: "broot", parent: "", offset: [0, 0, 0], rest: [0, 0, 0], length: 0, radius: 0, pivot: true, label: ["源点", "Body root"] },
    { name: "hips", parent: "broot", offset: [0, 0.95, 0], rest: [0, 0, 0], length: 0.16, radius: 0.105, shape: { sx: 1.06, sz: 0.76 }, label: ["骨盆", "Hips"] },
    { name: "spine", parent: "hips", offset: [0, 0.16, 0], rest: [0, 0, 0], length: 0.18, radius: 0.095, shape: { sx: 1.02, sz: 0.72 }, label: ["腰", "Spine"] },
    { name: "chest", parent: "spine", offset: [0, 0.18, 0], rest: [0, 0, 0], length: 0.16, radius: 0.09, shape: { sx: 1.22, sz: 0.70 }, label: ["胸", "Chest"] },
    { name: "neck", parent: "chest", offset: [0, 0.16, 0], rest: [0, 0, 0], length: 0.07, radius: 0.045, label: ["颈", "Neck"] },
    { name: "head", parent: "neck", offset: [0, 0.07, 0], rest: [0, 0, 0], length: 0.22, radius: 0.11, label: ["头", "Head"] },

    /* 肩的 offset 必须大于躯干半径 + 手臂半径,否则两条手臂会埋进躯干里,
       渲染出来在胸口糊成一坨横杠(真机踩到过)。躯干最宽处约 0.11,故取 ±0.16。 */
    { name: "shoulder.L", parent: "chest", offset: [0.17, 0.135, 0], rest: [0, 0, 180], length: 0.13, radius: 0.062, label: ["左肩", "Left shoulder"] },
    { name: "upperArm.L", parent: "shoulder.L", offset: [0, 0.13, 0], rest: [0, 0, 0], length: 0.28, radius: 0.05, label: ["左上臂", "Left upper arm"] },
    { name: "forearm.L", parent: "upperArm.L", offset: [0, 0.28, 0], rest: [0, 0, 0], length: 0.25, radius: 0.043, label: ["左前臂", "Left forearm"] },
    { name: "hand.L", parent: "forearm.L", offset: [0, 0.25, 0], rest: [0, 0, 0], length: 0.09, radius: 0.038, label: ["左手", "Left hand"] },

    { name: "shoulder.R", parent: "chest", offset: [-0.17, 0.135, 0], rest: [0, 0, 180], length: 0.13, radius: 0.062, label: ["右肩", "Right shoulder"] },
    { name: "upperArm.R", parent: "shoulder.R", offset: [0, 0.13, 0], rest: [0, 0, 0], length: 0.28, radius: 0.05, label: ["右上臂", "Right upper arm"] },
    { name: "forearm.R", parent: "upperArm.R", offset: [0, 0.28, 0], rest: [0, 0, 0], length: 0.25, radius: 0.043, label: ["右前臂", "Right forearm"] },
    { name: "hand.R", parent: "forearm.R", offset: [0, 0.25, 0], rest: [0, 0, 0], length: 0.09, radius: 0.038, label: ["右手", "Right hand"] },

    { name: "thigh.L", parent: "hips", offset: [0.09, 0, 0], rest: [0, 0, 180], length: 0.42, radius: 0.075, label: ["左大腿", "Left thigh"] },
    { name: "shin.L", parent: "thigh.L", offset: [0, 0.42, 0], rest: [0, 0, 0], length: 0.40, radius: 0.06, label: ["左小腿", "Left shin"] },
    { name: "foot.L", parent: "shin.L", offset: [0, 0.40, 0], rest: [90, 0, 0], length: 0.16, radius: 0.05, label: ["左脚", "Left foot"] },

    { name: "thigh.R", parent: "hips", offset: [-0.09, 0, 0], rest: [0, 0, 180], length: 0.42, radius: 0.075, label: ["右大腿", "Right thigh"] },
    { name: "shin.R", parent: "thigh.R", offset: [0, 0.42, 0], rest: [0, 0, 0], length: 0.40, radius: 0.06, label: ["右小腿", "Right shin"] },
    { name: "foot.R", parent: "shin.R", offset: [0, 0.40, 0], rest: [90, 0, 0], length: 0.16, radius: 0.05, label: ["右脚", "Right foot"] }
  ];

  var LIMITS = { min: -180, max: 180 };
  var ANGLE_KEYS = ["x", "y", "z"];
  var RIG_HEIGHT = 1.74;

  /* 预设姿态:只写与默认站姿不同的关节,应用时叠加在默认角度上。
     角度值按"角色左侧为 +X、面向 +Z"推得,渲染器就位后需要在设备上逐条目视确认。 */
  var PRESETS = [
    { id: "stand", label: ["站姿", "Stand"], patch: {} },
    {
      id: "tpose",
      label: ["T 字", "T pose"],
      patch: { "shoulder.L": { z: -90 }, "shoulder.R": { z: 90 } }
    },
    {
      id: "walk",
      label: ["行走", "Walk"],
      patch: {
        spine: { y: 6 },
        "thigh.L": { x: 25 }, "shin.L": { x: -20 },
        "thigh.R": { x: -25 }, "shin.R": { x: 35 },
        "shoulder.L": { x: -20 }, "shoulder.R": { x: 20 },
        "forearm.L": { x: 20 }, "forearm.R": { x: -15 }
      }
    },
    {
      id: "wave",
      label: ["举手", "Wave"],
      patch: {
        head: { z: -8 },
        "shoulder.L": { x: -130 }, "upperArm.L": { x: -20 }, "forearm.L": { z: -45 },
        "shoulder.R": { x: 12 }, "forearm.R": { x: -18 }
      }
    },
    {
      id: "sit",
      label: ["坐下", "Sit"],
      patch: {
        hips: { x: -6 }, spine: { x: 8 }, chest: { x: 6 },
        "thigh.L": { x: -88 }, "shin.L": { x: 85 }, "foot.L": { x: 8 },
        "thigh.R": { x: -88 }, "shin.R": { x: 85 }, "foot.R": { x: 8 },
        "shoulder.L": { x: -8 }, "shoulder.R": { x: -8 }
      }
    }
  ];

  var index = {};
  JOINTS.forEach(function (joint) { index[joint.name] = joint; });

  function byName(name) { return index[name] || null; }

  function names() { return JOINTS.map(function (joint) { return joint.name; }); }

  function isPaired(name) { return /\.(L|R)$/.test(String(name || "")); }

  /* 纯变换节点:没有可渲染的骨骼长度与半径 */
  function isPivot(name) {
    var joint = byName(name);
    return Boolean(joint && joint.pivot);
  }

  /* 参考系名字:bbox 是场景层容器,broot 是骨架顶层,其余为关节名,"world" 是世界 */
  var BBOX = "bbox";

  function mirrorName(name) {
    var value = String(name || "");
    if (/\.L$/.test(value)) return value.replace(/\.L$/, ".R");
    if (/\.R$/.test(value)) return value.replace(/\.R$/, ".L");
    return value;
  }

  function clampAngle(value) {
    var number = Number(value);
    if (!isFinite(number)) return 0;
    return app.utils.normalizeAngle(Math.min(LIMITS.max, Math.max(LIMITS.min, number)));
  }

  /* 默认站姿 = 每个关节的 rest 角度 */
  function defaultAngles() {
    var angles = {};
    JOINTS.forEach(function (joint) {
      angles[joint.name] = { x: joint.rest[0], y: joint.rest[1], z: joint.rest[2] };
    });
    return angles;
  }

  /* 归一化姿态:不认识的关节丢弃,越界角度收敛到 LIMITS */
  function normalize(angles) {
    var source = angles || {};
    var result = defaultAngles();
    JOINTS.forEach(function (joint) {
      var value = source[joint.name];
      if (!value) return;
      ANGLE_KEYS.forEach(function (key) {
        if (value[key] === undefined || value[key] === null) return;
        result[joint.name][key] = clampAngle(value[key]);
      });
    });
    return result;
  }

  /* 套用预设。
     预设是一整套姿态,所以从"默认站姿"起算,而不是叠在当前姿态上——
     否则先点 T 字再点行走,肩的 z=±90 会留下来,手臂一直横着。
     找不到这个预设时不动传入的姿态。 */
  function applyPreset(angles, presetId) {
    var preset = null;
    PRESETS.forEach(function (item) { if (item.id === presetId) preset = item; });
    if (!preset) return normalize(angles);
    var result = defaultAngles();
    Object.keys(preset.patch).forEach(function (name) {
      if (!index[name]) return;
      ANGLE_KEYS.forEach(function (key) {
        if (preset.patch[name][key] === undefined) return;
        result[name][key] = clampAngle(preset.patch[name][key]);
      });
    });
    return result;
  }

  /* 左右镜像:跨 X=0 平面反射后 Rx 保持、Ry 与 Rz 取反,关节名左右互换 */
  function mirror(angles) {
    var source = normalize(angles);
    var result = {};
    Object.keys(source).forEach(function (name) {
      var angle = source[name];
      result[mirrorName(name)] = { x: angle.x, y: clampAngle(-angle.y), z: clampAngle(-angle.z) };
    });
    return normalize(result);
  }

  /* ---- 3x3 旋转矩阵:行主序,作用于列向量,先绕 X,再绕 Y,最后绕 Z ---- */

  function rotationMatrix(angle) {
    var x = angle ? Number(angle.x) * Math.PI / 180 : 0;
    var y = angle ? Number(angle.y) * Math.PI / 180 : 0;
    var z = angle ? Number(angle.z) * Math.PI / 180 : 0;
    var cx = Math.cos(x), sx = Math.sin(x);
    var cy = Math.cos(y), sy = Math.sin(y);
    var cz = Math.cos(z), sz = Math.sin(z);
    var rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
    var ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
    var rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
    return multiply(rz, multiply(ry, rx));
  }

  function multiply(a, b) {
    var result = [];
    for (var row = 0; row < 3; row += 1) {
      for (var column = 0; column < 3; column += 1) {
        result[row * 3 + column] =
          a[row * 3] * b[column] + a[row * 3 + 1] * b[3 + column] + a[row * 3 + 2] * b[6 + column];
      }
    }
    return result;
  }

  function apply(matrix, vector) {
    return [
      matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
      matrix[3] * vector[0] + matrix[4] * vector[1] + matrix[5] * vector[2],
      matrix[6] * vector[0] + matrix[7] * vector[1] + matrix[8] * vector[2]
    ];
  }

  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }

  /* 某个关节的局部 +Y 在它自己父空间里的方向 */
  function localUp(angle) {
    var vector = apply(rotationMatrix(angle), [0, 1, 0]);
    return { x: vector[0], y: vector[1], z: vector[2] };
  }

  /* 前向运动学:每个关节在骨架局部空间的起点与末端,供取景、命中检测与测试使用。
     坐标系原点在 bbox 局部空间的原点(broot 所在处),bbox 的变换由场景层叠加。
     渲染不走这里:viewport 直接建 Object3D 层级,由矩阵乘法得到同样的结果。
     JOINTS 的顺序保证父关节先于子关节出现。 */
  function jointPositions(angles) {
    var pose = normalize(angles);
    var frames = {};
    JOINTS.forEach(function (joint) {
      var local = rotationMatrix(pose[joint.name]);
      var parent = joint.parent ? byName(joint.parent) : null;
      if (!parent) {
        frames[joint.name] = { origin: joint.offset.slice(), orientation: local };
        return;
      }
      var parentFrame = frames[parent.name];
      frames[joint.name] = {
        origin: add(parentFrame.origin, apply(parentFrame.orientation, joint.offset)),
        orientation: multiply(parentFrame.orientation, local)
      };
    });
    var positions = {};
    JOINTS.forEach(function (joint) {
      var frame = frames[joint.name];
      var tail = add(frame.origin, apply(frame.orientation, [0, joint.length, 0]));
      positions[joint.name] = {
        origin: { x: frame.origin[0], y: frame.origin[1], z: frame.origin[2] },
        tail: { x: tail[0], y: tail[1], z: tail[2] }
      };
    });
    return positions;
  }

  /* 姿态序列化格式;读写都经过 normalize,不认识的字段一律丢弃 */
  function serialize(pose) {
    var value = pose || {};
    return {
      schema: 1,
      name: String(value.name || ""),
      updatedAt: Number(value.updatedAt) || Date.now(),
      angles: normalize(value.angles)
    };
  }

  function parse(payload) {
    var value = typeof payload === "string" ? app.utils.parseJson(payload, null) : payload;
    if (!value || typeof value !== "object" || !value.angles) return null;
    return serialize(value);
  }

  app.rig = {
    joints: JOINTS,
    presets: PRESETS,
    limits: LIMITS,
    angleKeys: ANGLE_KEYS,
    height: RIG_HEIGHT,
    bbox: BBOX,
    byName: byName,
    names: names,
    isPaired: isPaired,
    isPivot: isPivot,
    mirrorName: mirrorName,
    defaultAngles: defaultAngles,
    normalize: normalize,
    applyPreset: applyPreset,
    mirror: mirror,
    rotationMatrix: rotationMatrix,
    localUp: localUp,
    jointPositions: jointPositions,
    serialize: serialize,
    parse: parse
  };
})(window.posegi);
