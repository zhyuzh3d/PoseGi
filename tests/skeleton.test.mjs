/* 彩色骨架渲染器:键位映射、缺骨头的处理、脸点阵、按画幅等比换算、以及"真的落了像素"
 *
 * 这一份钉的是**发给模型的那张控制图本身**,因为它有两类错误都**不报错**:
 *   1. 键位错位(把膝当成踝、把左手接到右边)⇒ 图照画、模型照收,只是姿势不对;
 *   2. 线宽/点半径写死成像素(没按画幅等比换算)⇒ 576 与 1152 画出来是两张不同的图,
 *      而参考图那条路的画布尺寸是可配的。
 * 所以这里断的是**具体数值与调用序列**,不是"函数没抛错"。
 *
 * 参数口径的出处:技能 `a1x-comfy-device` §4.11–§4.14 与 ~/Desktop/posegi-pose-control/
 * 结论.md(同一份配方先在 A1X 真机上验过:同一张骨架、同 seed、只换提示词,人物/服装/光线
 * 全变而姿势不变)。那份配方落在 /tmp/posegi_render/mkdwpose_from_segs.py 的 smallface 档上,
 * 这一份测试把它的每个常数逐个钉住 —— **不是"我觉得好看",是"与验过的那张一致"**。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* 记录型 2D 上下文:骨架渲染器只碰 canvas 的这几个方法,所以这里不需要真画布 ——
   而"落了哪些笔"恰好就是最该断的东西(颜色顺序、线宽、圆点半径、前后次序)。 */
function recorder() {
  const calls = [];
  const ctx = {};
  ctx.fillStyle = "";
  ctx.strokeStyle = "";
  ctx.lineWidth = 1;
  ctx.lineCap = "";
  ctx.lineJoin = "";
  ctx.globalAlpha = 1;
  ctx.setTransform = () => calls.push({ op: "setTransform" });
  ctx.clearRect = (x, y, w, h) => calls.push({ op: "clearRect", x, y, w, h });
  ctx.fillRect = (x, y, w, h) => calls.push({ op: "fillRect", x, y, w, h, fill: ctx.fillStyle });
  ctx.beginPath = () => calls.push({ op: "beginPath" });
  ctx.moveTo = (x, y) => calls.push({ op: "moveTo", x, y });
  ctx.lineTo = (x, y) => calls.push({ op: "lineTo", x, y });
  ctx.stroke = () => calls.push({ op: "stroke", stroke: ctx.strokeStyle, width: ctx.lineWidth });
  ctx.arc = (x, y, r) => calls.push({ op: "arc", x, y, r, fill: ctx.fillStyle });
  ctx.fill = () => calls.push({ op: "fill", fill: ctx.fillStyle });
  return { ctx, calls };
}

/* 骨架渲染器不认识 DOM 之外的东西,也不认识别的模块 —— 所以这里只给它一个
   `document.createElement("canvas")`,顺带把这条"零依赖"钉住(它要是开始要 i18n、
   要 rig,这里会当场红)。 */
const created = [];
globalThis.window = globalThis.window || {};
globalThis.window.posegi = globalThis.window.posegi || {};
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, "canvas", "骨架渲染器只该开画布");
    const canvas = { width: 0, height: 0, _rec: recorder() };
    canvas.getContext = () => canvas._rec.ctx;
    canvas.toDataURL = (mime) => "data:" + (mime || "image/png") + ";base64,AAAA";
    created.push(canvas);
    return canvas;
  }
};

new Function(fs.readFileSync(path.join(root, "app/core/skeleton.js"), "utf8"))();
const skeleton = globalThis.window.posegi.skeleton;

/* ---------- 一具对称的假骨架:每根骨头都朝一个不同的方向,错了看得出来 ----------
   坐标系就是画布像素(y 向下),与真实投影出来的一致。
   **左右两侧的每个点都特意错开**:肩原点在真机上是同一个点(都长在胸上),
   那样"左右接反"根本测不出来 —— 这里宁可让它偏一点,也要让映射错了当场红。 */
const BONES = {
  head: [[200, 130], [200, 70]],
  neck: [[200, 170], [200, 130]],
  "shoulder.R": [[198, 170], [150, 180]],
  "upperArm.R": [[150, 180], [140, 250]],
  "forearm.R": [[140, 250], [150, 320]],
  "shoulder.L": [[206, 170], [250, 180]],
  "upperArm.L": [[250, 180], [260, 250]],
  "forearm.L": [[260, 250], [250, 320]],
  "thigh.R": [[185, 300], [180, 380]],
  "shin.R": [[180, 380], [175, 460]],
  "thigh.L": [[215, 300], [220, 380]],
  "shin.L": [[220, 380], [225, 460]]
};
const names = Object.keys(BONES);
function segsOf(table) {
  return Object.keys(table).map((joint) => ({ joint, a: table[joint][0], b: table[joint][1] }));
}
const segs = segsOf(BONES);
const near = (got, want, message, tolerance = 1e-6) => {
  assert.ok(Math.abs(got - want) <= tolerance, `${message}(期望 ${want},得到 ${got})`);
};

/* ---------- 1) 调色板与连线:顺序本身是协议的一部分 ---------- */
{
  assert.equal(skeleton.palette.length, 18, "OpenPose 是 18 色");
  assert.deepEqual(skeleton.palette[0], [255, 0, 0], "第 0 条肢体必须是纯红(官方调色板第一个)");
  assert.deepEqual(skeleton.palette[17], [255, 0, 85],
    "调色板第 18 个颜色(17 条肢体用不到它,但它是官方调色板的一部分,不许被删掉一个)");
  assert.equal(skeleton.limbs.length, 17, "COCO-18 是 17 条连线");
  /* 连线两端必须是 0..17 的键位号 —— 抄错一个数字在这里就会红,而眼睛看不出来 */
  const used = {};
  skeleton.limbs.forEach(([a, b]) => {
    assert.ok(a >= 0 && a <= 17 && b >= 0 && b <= 17, `连线越界:${a}-${b}`);
    used[a] = used[b] = true;
  });
  ["0", "1", "2", "3", "8", "14", "17"].forEach((key) => assert.ok(used[key], `键位 ${key} 一条连线都没接`));
  assert.deepEqual(skeleton.limbs.slice(12), [[1, 0], [0, 14], [14, 16], [0, 15], [15, 17]],
    "头部那五条连线(颈→鼻、鼻→眼、眼→耳)的顺序与官方一致");
}

/* ---------- 2) 键位映射:膝取自大腿末端、踝取自小腿末端 ---------- */
{
  const kp = skeleton.keypoints(segs);
  assert.ok(kp, "这具骨架是齐的,应当投影得出来");
  assert.equal(kp.length, 18, "COCO-18 一共 18 个键位");

  const expect = {
    1: [200, 130], 2: [198, 170], 3: [140, 250], 4: [150, 320],
    5: [206, 170], 6: [260, 250], 7: [250, 320],
    8: [185, 300], 9: [180, 380], 10: [175, 460],
    11: [215, 300], 12: [220, 380], 13: [225, 460]
  };
  Object.keys(expect).forEach((slot) => {
    assert.deepEqual(kp[Number(slot)], expect[slot], `键位 ${slot} 取错了骨头`);
  });

  /* 膝与踝最容易写错:两者都在腿上,但**膝取大腿末端、踝取小腿末端**。
     所以这个夹具里那两个点必须真的不同 —— 否则上面两条断言等于什么都没说。 */
  assert.deepEqual(kp[9], BONES["thigh.R"][1], "右膝 = 右大腿末端");
  assert.deepEqual(kp[10], BONES["shin.R"][1], "右踝 = 右小腿末端");
  assert.notDeepEqual(kp[9], kp[10], "膝与踝必须落在不同位置,否则上面两条是空转");

  /* 头那一段:由 颈→头顶 推出鼻/眼/耳。头顶在颈的**上方**(y 更小)。 */
  near(kp[0][0], 200, "鼻在颈的正上方");
  near(kp[0][1], 130 - 60 * 0.46, "鼻落在 颈→头顶 的 46% 处");
  near(kp[14][0], 200 - 0.78 * 60 * 0.22, "右眼在眼线左侧");
  near(kp[15][0], 200 + 0.78 * 60 * 0.22, "左眼在眼线右侧");
  near(kp[14][1], 130 - 60 * 0.34, "眼线落在 34% 处");
  near(kp[16][0], 200 - 0.78 * 60 * 0.50, "右耳比眼更靠外");
  near(kp[17][0], 200 + 0.78 * 60 * 0.50, "左耳比眼更靠外");

  /* 骨头被翻过来(头顶跑到颈的**下方**)⇒ 五官要翻回去,不能长到脖子下面。
     这条是真实会发生的:高踢腿、倒立、镜头从下往上看都可能让投影翻向。 */
  const flipped = skeleton.keypoints(segsOf(Object.assign({}, BONES, { head: [[200, 130], [200, 190]] })));
  near(flipped[0][1], 130 - 60 * 0.46, "翻转之后鼻仍在上方");
  near(flipped[14][1], 130 - 60 * 0.34, "翻转之后眼仍在鼻的同一侧上方");
}

/* ---------- 3) 缺骨头 ⇒ 什么都不画(宁可是空白黑图,也不出半个人) ---------- */
{
  skeleton.requiredBones.forEach((bone) => {
    const missing = segs.filter((seg) => seg.joint !== bone);
    assert.equal(skeleton.keypoints(missing), null, `少了 ${bone} 还照样出图 —— 那会画出半个人`);
  });
  assert.ok(skeleton.requiredBones.indexOf("shin.L") >= 0, "小腿必须是要件之一");
  /* 反过来:多一根不相干的骨头不该有影响(手、脚不在骨架里,但投影层可能多给) */
  const extra = segs.concat([{ joint: "hand.R", a: [150, 320], b: [150, 360] }]);
  assert.deepEqual(skeleton.keypoints(extra), skeleton.keypoints(segs), "多余的骨头不该改变键位");
}

/* ---------- 4) 脸点阵:68 点,侧脸按 |cos| 压窄,最小 0.30 ---------- */
{
  const kp = skeleton.keypoints(segs);
  const front = skeleton.facePoints(kp, 0, 1);
  const side = skeleton.facePoints(kp, 90, 1);
  const back = skeleton.facePoints(kp, 180, 1);
  assert.equal(front.length, 68, "DWPose 的脸是 68 点");
  assert.equal(side.length, 68, "侧脸也是 68 点");

  /* 下巴那 17 点(0-16)的横向跨度就是脸宽 */
  const span = (points) => {
    const xs = points.slice(0, 17).map((point) => point[0]);
    return Math.max(...xs) - Math.min(...xs);
  };
  near(span(side) / span(front), 0.30, "完全侧过去要压到 30%(最小压扁系数)", 1e-6);
  near(span(back) / span(front), 1, "转半圈回到正面,脸宽要还原");
  assert.ok(span(skeleton.facePoints(kp, 60, 1)) < span(front), "斜一点就该比正面窄");
  /* 缩放系数是**整体**缩的:0.62 那一档是有头有脸与戴口罩之间的那条线(真机验过) */
  near(span(skeleton.facePoints(kp, 0, 0.62)), span(front) * 0.62, "0.62 档要真的把脸整体缩小");
}

/* ---------- 5) 每张图的线宽/点半径都按画幅换算:576 与 1152 画出来是同一张 ---------- */
{
  assert.deepEqual(skeleton.metrics(576), { unit: 1, half: 9, joint: 13, dot: 2 });
  assert.deepEqual(skeleton.metrics(1152), { unit: 2, half: 18, joint: 26, dot: 4 });
  /* 小画幅不许细到看不见:三个量各有下限(真机上是 576,下限是给缩略图那种尺寸兜底) */
  const tiny = skeleton.metrics(64);
  assert.equal(tiny.half, 3, "线宽下限是 3(半宽)");
  assert.equal(tiny.joint, 4, "关节点半径下限是 4");
  assert.equal(tiny.dot, 1, "脸点半径下限是 1");

  /* 配方里那几个数一个都不许飘(它们的出处见文件头) */
  assert.deepEqual(skeleton.layout, {
    baseWidth: 576, limbHalf: 9, jointRadius: 13,
    faceScale: 0.62, faceDotRadius: 2.2, faceMinFlatten: 0.30
  });
}

/* ---------- 6) 真的落了笔:背景、17 条肢体、34 个关节点、68 个脸点,次序也对 ---------- */
{
  const { ctx, calls } = recorder();
  const stats = skeleton.paint(ctx, segs, { width: 576, height: 1024 });
  assert.deepEqual(stats, { drawn: true, limbs: 17, joints: 34, face: 68 },
    "画了几笔要如实报出来(自检读的就是它)");

  const fill = calls.filter((call) => call.op === "fillRect");
  assert.equal(fill.length, 1, "底色只铺一次");
  assert.deepEqual([fill[0].x, fill[0].y, fill[0].w, fill[0].h], [0, 0, 576, 1024], "底色要铺满整张画布");
  assert.equal(fill[0].fill, "rgb(0,0,0)", "背景必须是纯黑 —— 这不是审美选择,而是「被认成 pose」的一部分");

  const strokes = calls.filter((call) => call.op === "stroke");
  assert.equal(strokes.length, 17, "17 条肢体一条都不能少");
  assert.equal(strokes[0].width, 18, "576 宽时线宽 18(半宽 9)");
  assert.equal(strokes[0].stroke, "rgb(255,0,0)", "第 0 条肢体用调色板第 0 个颜色");
  assert.equal(strokes[16].stroke, "rgb(255,0,170)", "最后一条肢体用调色板第 16 个颜色");
  assert.deepEqual(strokes.map((call) => call.stroke),
    skeleton.palette.slice(0, 17).map((color) => `rgb(${color[0]},${color[1]},${color[2]})`),
    "颜色与连线的对应关系必须逐个对得上(错一个就是腿接到手臂的颜色上)");

  const arcs = calls.filter((call) => call.op === "arc");
  assert.equal(arcs.length, 34 + 68, "34 个关节点 + 68 个脸点");
  const jointDots = arcs.slice(0, 34);
  const faceDots = arcs.slice(34);
  assert.ok(jointDots.every((call) => call.r === 13), "关节圆点半径 13");
  assert.ok(jointDots.every((call) => call.fill !== "#ffffff"), "关节点要用自己那根肢体的颜色");
  assert.ok(faceDots.every((call) => call.fill === "#ffffff"), "脸点阵一律纯白");
  assert.ok(faceDots.every((call) => call.r === 2), "脸点半径 2.2 取整后是 2(576 宽)");
  /* 次序有意义:脸点必须画在肢体之后,否则脖颈那条线会压在脸上 */
  const lastStrokeAt = calls.map((call) => call.op).lastIndexOf("stroke");
  const firstFaceAt = calls.findIndex((call) => call.op === "arc" && call.fill === "#ffffff");
  assert.ok(firstFaceAt > lastStrokeAt, "脸点阵要画在肢体之后");

  /* 任何一笔都不许落到画布外面(坐标算错时最容易表现为"整体偏出去") */
  const points = calls.filter((call) => call.op === "moveTo" || call.op === "lineTo");
  assert.ok(points.every((call) => call.x >= 0 && call.x <= 576 && call.y >= 0 && call.y <= 1024),
    "这一具骨架整整齐齐落在画布里");
}

/* ---------- 7) 透明底与"不画"这两条出路 ---------- */
{
  const transparent = recorder();
  const stats = skeleton.paint(transparent.ctx, segs, { width: 576, height: 1024, background: null });
  assert.equal(stats.drawn, true, "透明底照样要把骨架画出来");
  const ops = transparent.calls.map((call) => call.op);
  assert.equal(ops.filter((op) => op === "clearRect").length, 1, "透明底要先擦干净(上一帧的骨痕不能留)");
  assert.ok(ops.indexOf("fillRect") < 0, "透明底不许铺黑 —— 屏上那层底下是实时人偶");

  const blank = recorder();
  const empty = skeleton.paint(blank.ctx, segs.filter((seg) => seg.joint !== "neck"), { width: 576, height: 1024 });
  assert.deepEqual(empty, { drawn: false, limbs: 0, joints: 0, face: 0 }, "缺骨头 ⇒ 明说没画");
  assert.ok(blank.calls.map((call) => call.op).indexOf("stroke") < 0, "缺骨头就不许落任何一笔");
  assert.deepEqual(blank.calls.filter((call) => call.op === "fillRect")[0].fill, "rgb(0,0,0)",
    "缺骨头时那张图仍然是纯黑(不是透明):模型收到一张没有姿势的黑图,而不是一堵墙");
}

/* ---------- 8) image():自己开画布,返回值形状与 viewport.captureAt 一致 ---------- */
{
  const before = created.length;
  const image = skeleton.image(segs, { width: 1152, height: 2048, azimuth: 0 });
  assert.equal(created.length, before + 1, "应当自己开一块画布");
  const canvas = created[created.length - 1];
  assert.deepEqual([canvas.width, canvas.height], [1152, 2048], "画布尺寸 = 请求的尺寸");
  assert.deepEqual([image.width, image.height], [1152, 2048], "返回的尺寸要如实报出来");
  assert.equal(image.mime, "image/png", "默认无损 PNG(骨线是硬边,JPEG 会糊出一圈灰)");
  assert.match(image.dataUrl, /^data:image\/png;base64,/);
  assert.equal(image.imageBase64, "AAAA", "imageBase64 是 dataUrl 去掉前缀的那一段");
  assert.deepEqual(image.stats, { drawn: true, limbs: 17, joints: 34, face: 68 }, "顺手把画了什么报出来");

  /* 同一个姿势在两档画幅上画出来必须是**同一张图**:线宽与点半径都跟着等比走 */
  const strokes = canvas._rec.calls.filter((call) => call.op === "stroke");
  assert.equal(strokes[0].width, 36, "1152 宽时线宽 36 = 576 宽那一张的两倍");
  assert.equal(canvas._rec.calls.filter((call) => call.op === "arc")[0].r, 26, "关节点半径也翻倍");
  assert.equal(canvas._rec.calls.filter((call) => call.op === "arc")[34].r, 4, "脸点半径也翻倍");
  assert.deepEqual(canvas._rec.calls.filter((call) => call.op === "fillRect")[0].fill, "rgb(0,0,0)",
    "两档画幅的底色都是纯黑(黑底是配方的一部分,不跟着主题走)");

  const jpeg = skeleton.image(segs, { width: 576, height: 1024, mime: "image/jpeg", quality: 0.9 });
  assert.equal(jpeg.mime, "image/jpeg", "显式要 JPEG 时才给 JPEG");
}

console.log("skeleton.test.mjs: ok (18 色/17 连线、18 个键位逐点对上、缺骨头当场不画、"
  + "68 点脸与 0.30 侧脸下限、按画幅等比换算、落笔的次序与颜色、透明底、image 的返回形状)");
