/* 彩色骨架控制图(2026-10-01 定稿)
 *
 * 责任:"把一具投影骨架画成 Qwen 认得出是 pose 的那张图"。纯几何 + 纯绘制:
 * 不认识视口、不认识姿态数据、不碰姿态 —— 输入是几根骨头的屏幕投影,输出是一块画布。
 *
 * **为什么必须是这个长相**:Qwen-Image 2.1 那条路上,参考图就是控制图,而它
 * **长什么样决定了被当成什么**。实测(技能 `a1x-comfy-device` §4.11–§4.12):
 * 白底黑线会被认成"待临摹的线稿"⇒ 出图就是那张线稿的再渲染,提示词完全失效;
 * 素模灰度图 ⇒ 出图就是那个木头人偶。只有**黑底 + 每条肢体一个 OpenPose 颜色 +
 * 关节实心圆点 + 小尺度脸点阵**,模型才把它认成 **pose**,然后按提示词去生成
 * "一个真人摆这个姿势"。判据是**同一张骨架、同 seed、只换提示词** ——
 * 人物/服装/光线全变而姿势不变,那才叫姿势被控住了。
 *
 * 三处参数有来历,别凭手感改:
 *   · **脸必须是点阵,而且比官方小**。照官方尺度画 68 点会在头顶生成口罩/护目镜;
 *     **完全不画头更糟** —— 同一张控制图复跑会随机丢头。官方 0.62 倍、点半径 2.2
 *     (以 576 宽为基准换算)是实测唯一稳定的一档。
 *   · **线宽与点半径按 576 宽等比换算**,所以 576×1024 与 1152×2048 画出来是同一张图。
 *   · **背景纯黑**,不是主题纸色 —— 这不是审美选择,是"被认成 pose"的一部分。
 *
 * 坐标系:传进来的 segs 已经在**目标画布**的像素坐标里(取景与裁切由视口那侧做完),
 * 所以这里不做任何取景,只负责画。
 */
(function (app) {
  "use strict";

  /* OpenPose 18 色调色板。顺序有意义:第 i 条肢体取第 i 个颜色,而肢体表的顺序
     与官方 COCO-18 连线一致,所以整张图与官方 DWPose 控制图同源。 */
  var PALETTE = [
    [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0],
    [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255],
    [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255],
    [255, 0, 255], [255, 0, 170], [255, 0, 85]
  ];

  /* COCO-18 连线。`a` 是关节原点、`b` 是骨杆末端。 */
  var LIMBS = [
    [1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7],
    [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13],
    [1, 0], [0, 14], [14, 16], [0, 15], [15, 17]
  ];

  /* 键位 0..13 各自的出处:`[骨头名, "a" | "b"]`。
     一次直接查表,而不是"每根骨头贡献一个端点"—— 膝与踝都取自各自的骨头末端,
     写成后者就必然要把大腿末端与小腿末端混成一个,那是错的。
     14..17(眼/耳)与 0(鼻)不在这里:它们由 head 那根骨头推出来,见 landmarks()。 */
  var CARRIERS = [
    null,
    ["neck", "b"], ["shoulder.R", "a"], ["upperArm.R", "b"], ["forearm.R", "b"],
    ["shoulder.L", "a"], ["upperArm.L", "b"], ["forearm.L", "b"],
    ["thigh.R", "a"], ["thigh.R", "b"], ["shin.R", "b"],
    ["thigh.L", "a"], ["thigh.L", "b"], ["shin.L", "b"]
  ];

  /* 这 12 根骨头缺任何一根就不画。半张骨架会被模型认成"这个人少了一条腿",
     比不画更坏 —— 所以宁可返回"没画",也不出一张残图。 */
  var REQUIRED_BONES = ["neck", "head", "shoulder.R", "upperArm.R", "forearm.R",
    "shoulder.L", "upperArm.L", "forearm.L", "thigh.R", "shin.R", "thigh.L", "shin.L"];

  /* 这三个数以 576 宽为基准,按画幅等比换算。 */
  var BASE_WIDTH = 576;
  var LIMB_HALF = 9;
  var JOINT_RADIUS = 13;
  var FACE_SCALE = 0.62;
  var FACE_DOT_RADIUS = 2.2;
  var FACE_MIN_FLATTEN = 0.30;

  function num(value, fallback) {
    var parsed = Number(value);
    return isFinite(parsed) ? parsed : fallback;
  }

  /* segs(每一项 { joint, a, b })按骨头名归档。a/b 都是 [x, y]。 */
  function collect(segs) {
    var by = {};
    (segs || []).forEach(function (seg) {
      if (!seg || !seg.joint || !seg.a || !seg.b) return;
      by[String(seg.joint)] = {
        a: [num(seg.a[0], 0), num(seg.a[1], 0)],
        b: [num(seg.b[0], 0), num(seg.b[1], 0)]
      };
    });
    return by;
  }

  /* 投影骨架 → COCO-18 的 18 个键位(数组,下标即键位号)。
     缺骨头返回 null —— 调用方据此画一张空白黑图,而不是画半个人。 */
  function keypoints(segs) {
    var by = collect(segs);
    for (var index = 0; index < REQUIRED_BONES.length; index += 1) {
      if (!by[REQUIRED_BONES[index]]) return null;
    }

    var kp = [];
    for (var slot = 1; slot < CARRIERS.length; slot += 1) {
      var carrier = CARRIERS[slot];
      kp[slot] = by[carrier[0]][carrier[1]].slice();
    }

    /* 头这一段:由 neck → 头顶推出鼻/眼/耳。
       `uy > 0` = 头顶朝下,说明这根骨头被翻过来了,翻回去再推(否则五官会长到脖子下面)。 */
    var neck = kp[1], headTop = by.head.b;
    var dx = headTop[0] - neck[0], dy = headTop[1] - neck[1];
    var length = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / length, uy = dy / length;
    if (uy > 0) { ux = -ux; uy = -uy; }
    var sideX = -uy, sideY = ux;
    var headWidth = 0.78 * length;
    var eyeLineX = neck[0] + ux * length * 0.34;
    var eyeLineY = neck[1] + uy * length * 0.34;

    kp[0] = [neck[0] + ux * length * 0.46, neck[1] + uy * length * 0.46];
    kp[14] = [eyeLineX - sideX * headWidth * 0.22, eyeLineY - sideY * headWidth * 0.22];
    kp[15] = [eyeLineX + sideX * headWidth * 0.22, eyeLineY + sideY * headWidth * 0.22];
    kp[16] = [eyeLineX - sideX * headWidth * 0.50, eyeLineY - sideY * headWidth * 0.50];
    kp[17] = [eyeLineX + sideX * headWidth * 0.50, eyeLineY + sideY * headWidth * 0.50];
    return kp;
  }

  /* 68 点人脸:由鼻/眼/耳推出下巴轮廓、眉、鼻梁与鼻翼、双眼、内外唇。
     排布照 DWPose 那份,但整体缩到 `scale` 倍 —— 那是有头有脸与戴口罩之间的那条线。
     侧脸按 |cos(方位角)| 压窄、最小 0.30:完全侧过去时脸不该缩成一条线。 */
  function facePoints(kp, azimuth, scale) {
    var factor = num(scale, FACE_SCALE);
    var radians = num(azimuth, 0) * Math.PI / 180;
    var right = kp[14], left = kp[15];
    var eyeHalf = Math.abs(left[0] - right[0]) / 2 || 1;
    var width = eyeHalf * 4.2 * Math.max(FACE_MIN_FLATTEN, Math.abs(Math.cos(radians))) * factor;
    var height = width * 1.35;
    var cx = (right[0] + left[0]) / 2;
    var cy = (right[1] + left[1]) / 2 + height * 0.18;
    var points = [];
    var i, t, sign;

    /* 0-16 下巴轮廓:从左鬓角经下巴到右鬓角 */
    for (i = 0; i < 17; i += 1) {
      t = Math.PI * i / 16;
      points.push([cx + width / 2 * Math.cos(t), cy + height / 2 * Math.sin(t) - height * 0.02]);
    }
    /* 17-26 双眉 */
    for (sign = -1; sign <= 1; sign += 2) {
      for (i = 0; i < 5; i += 1) {
        points.push([cx + sign * (eyeHalf * 1.15 + eyeHalf * (i / 4)), cy - height * 0.26]);
      }
    }
    /* 27-30 鼻梁、31-35 鼻翼与鼻孔 */
    for (i = 0; i < 4; i += 1) {
      points.push([cx, cy - height * 0.16 + height * 0.20 * (i / 3)]);
    }
    points.push([cx - width * 0.10, cy + height * 0.04]);
    points.push([cx - width * 0.06, cy + height * 0.08]);
    points.push([cx, cy + height * 0.09]);
    points.push([cx + width * 0.06, cy + height * 0.08]);
    points.push([cx + width * 0.10, cy + height * 0.04]);
    /* 36-47 双眼各 6 点 */
    for (sign = -1; sign <= 1; sign += 2) {
      for (i = 0; i < 6; i += 1) {
        t = -Math.PI / 2 + 2 * Math.PI * i / 6;
        points.push([cx + sign * eyeHalf + eyeHalf * 0.72 * Math.cos(t),
          cy - height * 0.13 + height * 0.045 * Math.sin(t)]);
      }
    }
    /* 48-59 外唇、60-67 内唇 */
    for (i = 0; i < 12; i += 1) {
      t = 2 * Math.PI * i / 12;
      points.push([cx + width * 0.22 * Math.cos(t), cy + height * 0.20 + height * 0.075 * Math.sin(t)]);
    }
    for (i = 0; i < 8; i += 1) {
      t = 2 * Math.PI * i / 8;
      points.push([cx + width * 0.13 * Math.cos(t), cy + height * 0.20 + height * 0.042 * Math.sin(t)]);
    }
    return points;
  }

  function css(color) {
    return "rgb(" + color[0] + "," + color[1] + "," + color[2] + ")";
  }

  /* 按画幅算出这一张的线宽 / 点半径。测试与自检读它,免得两边各抄一套换算。 */
  function metrics(width) {
    var unit = Math.max(64, num(width, BASE_WIDTH)) / BASE_WIDTH;
    return {
      unit: unit,
      half: Math.max(3, Math.round(LIMB_HALF * unit)),
      joint: Math.max(4, Math.round(JOINT_RADIUS * unit)),
      dot: Math.max(1, Math.round(FACE_DOT_RADIUS * unit))
    };
  }

  /* 画出这张控制图。options:
   *   width / height  目标画布像素(= 参考图的尺寸)
   *   azimuth         相机方位角(度),只用来把侧脸压窄
   *   face            画不画脸点阵,默认画
   *   scale           脸点阵的整体缩放,默认 0.62
   *   background      底色,默认纯黑;显式给 null 就是**透明底** ——
   *                   屏上那层覆盖 canvas 用它:底下是实时 3D 视口,不能拿黑底把人偶盖掉。
   * 返回画了几根肢体、几个关节点、几个脸点、以及"到底画没画" ——
   * 自检与测试据此判断东西真的落上去了,而不是只看"函数没抛错"。 */
  function paint(context, segs, options) {
    var config = options || {};
    var width = Math.max(64, Math.round(num(config.width, BASE_WIDTH)));
    var height = Math.max(64, Math.round(num(config.height, 1024)));
    var size = metrics(width);
    var background = config.background === undefined ? [0, 0, 0] : config.background;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    /* 先无条件清一遍:覆盖层每帧重画,不清就会把上一帧的骨痕留在屏幕上
       (透明底也要清,黑底那次填充会紧随其后盖满,所以结果不变)。 */
    context.clearRect(0, 0, width, height);
    if (background) {
      context.fillStyle = css(background);
      context.fillRect(0, 0, width, height);
    }

    var kp = keypoints(segs);
    if (!kp) return { drawn: false, limbs: 0, joints: 0, face: 0 };

    var limbs = 0, joints = 0;
    context.lineCap = "butt";
    context.lineJoin = "round";
    LIMBS.forEach(function (pair, index) {
      var color = css(PALETTE[index % PALETTE.length]);
      var from = kp[pair[0]], to = kp[pair[1]];
      if (!from || !to) return;
      context.strokeStyle = color;
      context.lineWidth = size.half * 2;
      context.beginPath();
      context.moveTo(from[0], from[1]);
      context.lineTo(to[0], to[1]);
      context.stroke();
      limbs += 1;
      [from, to].forEach(function (point) {
        context.fillStyle = color;
        context.beginPath();
        context.arc(point[0], point[1], size.joint, 0, Math.PI * 2);
        context.fill();
        joints += 1;
      });
    });

    var face = 0;
    if (config.face !== false) {
      context.fillStyle = "#ffffff";
      facePoints(kp, config.azimuth, config.scale).forEach(function (point) {
        context.beginPath();
        context.arc(point[0], point[1], size.dot, 0, Math.PI * 2);
        context.fill();
        face += 1;
      });
    }
    return { drawn: true, limbs: limbs, joints: joints, face: face };
  }

  /* 同上,但自己开一块画布。生图那条路要的就是它 ——
     返回值的形状与视口的 captureAt 一致,所以 image-engine 那侧一个字都不用改。 */
  function image(segs, options) {
    var config = options || {};
    var width = Math.max(64, Math.round(num(config.width, BASE_WIDTH)));
    var height = Math.max(64, Math.round(num(config.height, 1024)));
    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    var stats = paint(canvas.getContext("2d"), segs, {
      width: width, height: height, azimuth: config.azimuth,
      face: config.face, scale: config.scale, background: config.background
    });
    var mime = config.mime === "image/jpeg" ? "image/jpeg" : "image/png";
    var dataUrl = mime === "image/jpeg"
      ? canvas.toDataURL(mime, num(config.quality, 0.92))
      : canvas.toDataURL("image/png");
    return {
      dataUrl: dataUrl,
      imageBase64: dataUrl.replace(/^data:[^,]+,/, ""),
      mime: mime,
      width: width,
      height: height,
      stats: stats
    };
  }

  app.skeleton = {
    palette: PALETTE,
    limbs: LIMBS,
    carriers: CARRIERS,
    requiredBones: REQUIRED_BONES,
    keypoints: keypoints,
    facePoints: facePoints,
    metrics: metrics,
    paint: paint,
    image: image,
    /* 那几个数各自的出处,给测试与自检读 */
    layout: {
      baseWidth: BASE_WIDTH,
      limbHalf: LIMB_HALF,
      jointRadius: JOINT_RADIUS,
      faceScale: FACE_SCALE,
      faceDotRadius: FACE_DOT_RADIUS,
      faceMinFlatten: FACE_MIN_FLATTEN
    }
  };
})(window.posegi);
