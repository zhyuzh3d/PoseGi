/* 骨骼与姿态数据模型的纯逻辑测试
 *
 * 这些模块在浏览器里注册到 window.posegi,在 node 里用一个空 window 顶替即可加载,
 * 因此不需要任何测试框架与依赖。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = globalThis.window || {};
for (const file of ["app/core/namespace.js", "app/core/utils.js", "app/core/models.js",
  "app/assets/models/ikea.js", "app/core/rig.js"]) {
  const code = fs.readFileSync(path.join(root, file), "utf8");
  new Function(code)();
}

const app = globalThis.window.posegi;
const rig = app.rig;

assert.ok(rig, "rig 没有注册到 window.posegi");
/* 骨架的尺寸与朝向来自人物模型,所以先把模型装上再测 —— 不装的话整张关节表
   都是"原点上的零长节点",测出来的东西没有任何意义。 */
const CHARACTER = rig.applyModel(app.models.get("ikea"));
assert.ok(CHARACTER, "宜家人偶没有登记到 app.models");
/* 版本号:查"格式对不对"与"和 haminn.json 一致吗",不要写死一个具体数字 ——
   写死的话每完成一个任务(补丁位 +1)都要回来改测试,而它守不住任何东西。 */
const manifest = JSON.parse(fs.readFileSync(path.join(root, "haminn.json"), "utf8"));
assert.match(app.version, /^\d+\.\d+\.\d+$/, "app.version 必须是 x.y.z");
assert.equal(app.version, manifest.version.name, "app.version 与 haminn.json 的 version.name 不一致");

/* 关节表自洽:重名、父链顺序、骨骼尺寸 */
{
  const seen = new Set();
  for (const joint of rig.joints) {
    assert.ok(!seen.has(joint.name), `重名关节 ${joint.name}`);
    if (joint.parent) assert.ok(seen.has(joint.parent), `${joint.name} 的父关节 ${joint.parent} 排在其后`);
    if (joint.parent) assert.ok(seen.has(joint.parent), `${joint.name} 的父关节 ${joint.parent} 排在其后`);
    if (joint.pivot) assert.equal(joint.length, 0, `${joint.name} 是变换节点,不该有骨骼长度`);
    else {
      assert.ok(joint.length > 0, `${joint.name} 的骨骼长度必须是正数`);
      assert.ok(joint.radius > 0, `${joint.name} 的半径必须是正数`);
    }
    assert.equal(joint.offset.length, 3, `${joint.name} 的 offset 必须是三个分量`);
    assert.equal(joint.rest.length, 3, `${joint.name} 的 rest 必须是三个分量`);
    seen.add(joint.name);
  }
  assert.equal(rig.joints.length, 20, "人形骨架固定 20 个关节(19 个骨骼 + broot)");
}

/* 层级顶端:broot 是骨架顶层(父为空),hips 挂在它下面,bbox 在骨架之外 */
{
  const broot = rig.byName("broot");
  assert.ok(broot, "缺少骨架顶层 broot");
  assert.equal(broot.parent, "", "broot 必须是顶层节点");
  assert.ok(rig.isPivot("broot"), "broot 是纯变换节点");
  assert.equal(rig.byName("hips").parent, "broot", "hips 必须挂在 broot 下面");
  assert.equal(rig.bbox, "bbox");
  assert.equal(rig.byName("bbox"), null, "bbox 属于场景层,不在骨架表里");
  assert.deepEqual(rig.jointPositions(rig.defaultAngles()).broot.origin, { x: 0, y: 0, z: 0 }, "broot 落在原点");
}

/* 成对关节必须左右齐备 */
for (const name of rig.names()) {
  if (!rig.isPaired(name)) continue;
  const other = rig.mirrorName(name);
  assert.notEqual(other, name, `${name} 的镜像名应当是另一个关节`);
  assert.ok(rig.byName(other), `${name} 缺少镜像关节 ${other}`);
}

/* 默认角度就是 rest;归一化丢弃陌生关节并收敛越界值 */
{
  const defaults = rig.defaultAngles();
  for (const joint of rig.joints) {
    /* rest 是模型给的原始值(四位小数),默认站姿统一过一遍归一化(保留一位小数) */
    assert.deepEqual(defaults[joint.name], {
      x: app.utils.normalizeAngle(joint.rest[0]),
      y: app.utils.normalizeAngle(joint.rest[1]),
      z: app.utils.normalizeAngle(joint.rest[2])
    });
  }
  const cleaned = rig.normalize({
    "upperArm.L": { x: 999, y: 0, z: 0 },
    "not.a.joint": { x: 10, y: 10, z: 10 }
  });
  /* 现在**每个关节都带自己的可转窗口**,越界写入会先绕回增量再被夹到窗口边界上,
     所以判据是"落在窗口内",不是"等于 180" —— 全局 ±180 那条路只剩陌生关节走。 */
  const upper = rig.byName("upperArm.L");
  const upperDelta = app.utils.normalizeAngle(cleaned["upperArm.L"].x - upper.rest[0]);
  assert.ok(
    upperDelta >= upper.limit.x[0] - 1e-9 && upperDelta <= upper.limit.x[1] + 1e-9,
    `越界角度应当收敛到该关节自己的窗口内,现在增量是 ${upperDelta}`
  );
  assert.equal(rig.clampJoint("not.a.joint", "x", 999), 180, "陌生关节沿用全局 ±180");
  assert.equal(cleaned["not.a.joint"], undefined, "陌生关节应当被丢弃");
  assert.deepEqual(cleaned.hips, defaults.hips, "没写到的关节保持默认站姿");
}

/* 镜像:左右互换、Ry 与 Rz 取反、Rx 保持,且两次镜像回到原样。
   注意模型的静止姿态在 y/z 上不是 0(宜家大腿的 rest z 是 -178.7 度),
   所以取反之后比的是"取反再归一化"的值,不能直接与另一侧原样相等。 */
{
  const source = rig.applyPreset(rig.defaultAngles(), "walk");
  const mirrored = rig.mirror(source);

  /* 交换:左侧的姿态落到右侧。预设只写了屈伸(x),所以这一条可以严格比 */
  assert.equal(mirrored["thigh.R"].x, source["thigh.L"].x, "镜像后左侧姿态应落到右侧");
  assert.equal(mirrored["upperArm.R"].x, source["upperArm.L"].x);
  /* 取反:y 与 z 通道 */
  for (const [left, right] of [["thigh.L", "thigh.R"], ["upperArm.L", "upperArm.R"], ["shoulder.L", "shoulder.R"]]) {
    for (const key of ["y", "z"]) {
      assert.equal(
        mirrored[right][key],
        app.utils.normalizeAngle(-source[left][key]),
        `${left} 的 ${key} 通道镜像后应当取反`
      );
    }
  }
  assert.deepEqual(mirrored.hips, source.hips, "非成对关节在镜像前后保持一致");
  assert.deepEqual(rig.mirror(mirrored), source, "镜像两次应当回到原姿态");

  const single = rig.mirror(rig.normalize({ "upperArm.L": { x: 30, y: 40, z: 50 } }));
  assert.deepEqual(single["upperArm.R"], { x: 30, y: -40, z: -50 });
}

/* 每个关节的可转范围都必须落在人体结构里,而且左右必须严格镜像。
   这是"摆不出反关节 pose"的唯一防线 —— 姿态写入全走 clampJoint,它读的就是这张表。
   四条契约:
     1) 纯变换节点(broot)三个通道零宽,转不动;
     2) 其余每个关节都要写满 x / y / z,不写就是全局 ±180(那种"没检查到"的关节);
     3) 成对关节的 limit 必须满足"x 一致、y 与 z 取反"(与 mirror 同一套规则),
        否则会出现"一条腿能往左跨、另一条不能";
     4) 单侧通道必须是单侧窗口:膝的 x 上界、肘的 x 下界都不许越过 0。
   (2026-09-25 逐关节实测出的通道语义:x 屈伸 / y 绕骨轴自转 / z 侧摆,
     四肢的 +z 朝角色左侧走,躯干与头的 +z 朝角色右侧倒 —— 详见 rig.js 文件头。) */
{
  const keys = ["x", "y", "z"];
  for (const joint of rig.joints) {
    assert.ok(joint.limit, `${joint.name} 缺少可转范围(等于放弃了它自己的反关节防线)`);
    for (const key of keys) {
      const range = joint.limit[key];
      assert.ok(Array.isArray(range) && range.length === 2, `${joint.name}.${key} 的范围格式不对`);
      assert.ok(range[1] >= range[0], `${joint.name}.${key} 的上下界反了`);
      assert.ok(range[0] >= rig.limits.min && range[1] <= rig.limits.max,
        `${joint.name}.${key} 超出了全局 ±180`);
    }
    if (joint.pivot) {
      for (const key of keys) {
        assert.deepEqual(joint.limit[key], [0, 0], `${joint.name} 是纯变换节点,必须三个通道零宽`);
      }
    }
  }
  /* broot 的零宽窗口是真的锁得住,不是写着好看 */
  for (const key of keys) {
    assert.equal(rig.clampJoint("broot", key, 90), 0, `broot.${key} 竟然能转`);
  }

  for (const name of rig.names()) {
    if (!rig.isPaired(name)) continue;
    const left = rig.byName(name);
    const right = rig.byName(rig.mirrorName(name));
    for (const key of keys) {
      /* 镜像规则:y 与 z 取反(上下界跟着交换),x 原样 */
      const expected = left.limit[key]
        .map(function (value) { return key === "x" ? value : -value; })
        .sort(function (a, b) { return a - b; });
      assert.deepEqual(right.limit[key], expected,
        `${right.name}.${key} 的窗口与 ${left.name} 不镜像(外展会被写成内收)`);
    }
  }

  /* 反关节的唯一入口:膝、肘 */
  for (const side of ["L", "R"]) {
    assert.equal(rig.byName(`shin.${side}`).limit.x[1], 0,
      `膝 ${side} 的 x 上界必须是 0,否则膝盖能往反方向折`);
    assert.equal(rig.byName(`forearm.${side}`).limit.x[0], 0,
      `肘 ${side} 的 x 下界必须是 0,否则小臂能往后折`);
  }
  /* 骨盆是全身的转向盘:y 必须能转满一圈(用户定的"人物整体旋转靠转 hips") */
  assert.deepEqual(rig.byName("hips").limit.y, [-180, 180], "髋的 y 通道必须允许整圈转身");
}

/* 反关节的**几何**验证:数字上"膝的 x 上界是 0"成立,不等于绕这个世界观转出来的
   骨末端真的往后退 —— 通道语义是实测出来的结论,所以这里也实测一遍:
     膝:大腿保持静止姿态,小腿的 x 在整个窗口里扫一遍,踝**永远不许跑到膝的前方**;
     肘:上臂保持静止姿态,前臂的 x 在窗口里扫一遍,腕**永远不许跑到肘的后方**。
   (容差 1cm:静止姿态下小臂本身有 3 度的前倾 —— 模型就这样,不是我们能改的。) */
{
  for (const side of ["L", "R"]) {
    /* 踝不许跑到膝前方:膝→踝 的 +Z 分量越小越好(负 = 小腿在后,正常屈膝) */
    let worstAnkle = -Infinity;
    /* 腕不许跑到肘后方:肘→腕 的 +Z 分量 */
    let worstWrist = -Infinity;
    for (let step = 0; step <= 20; step += 1) {
      const shin = rig.byName(`shin.${side}`);
      const kneeRange = shin.limit.x;
      const kneeDelta = kneeRange[0] + (kneeRange[1] - kneeRange[0]) * step / 20;
      const kneePose = rig.defaultAngles();
      kneePose[`shin.${side}`].x = rig.clampJoint(`shin.${side}`, "x",
        app.utils.normalizeAngle(shin.rest[0] + kneeDelta));
      const kneePoints = rig.jointPositions(kneePose);
      worstAnkle = Math.max(worstAnkle,
        kneePoints[`shin.${side}`].tail.z - kneePoints[`thigh.${side}`].tail.z);

      const forearm = rig.byName(`forearm.${side}`);
      const elbowRange = forearm.limit.x;
      const elbowDelta = elbowRange[0] + (elbowRange[1] - elbowRange[0]) * step / 20;
      const elbowPose = rig.defaultAngles();
      elbowPose[`forearm.${side}`].x = rig.clampJoint(`forearm.${side}`, "x",
        app.utils.normalizeAngle(forearm.rest[0] + elbowDelta));
      const elbowPoints = rig.jointPositions(elbowPose);
      worstWrist = Math.max(worstWrist,
        elbowPoints[`upperArm.${side}`].tail.z - elbowPoints[`forearm.${side}`].tail.z);
    }
    assert.ok(worstAnkle < 0.01,
      `${side} 侧膝在允许范围内把踝转到了膝前方 ${worstAnkle.toFixed(3)}m —— 那就是膝反张`);
    assert.ok(worstWrist < 0.01,
      `${side} 侧肘在允许范围内把腕转到了肘后方 ${worstWrist.toFixed(3)}m —— 那就是肘反张`);
  }
}

/* 预设:叠加在默认姿态上,不改动入参。
   预设写的是**相对 rest 的增量**(各个模型的 rest 完全不同),所以这里量的是
   "相对静止姿态转了多少",不是绝对角度 —— 宜家的肩 rest 是 -166.1 度。 */
{
  const before = rig.defaultAngles();
  const frozen = JSON.parse(JSON.stringify(before));
  const tpose = rig.applyPreset(before, "tpose");
  const relative = (name, key) => app.utils.normalizeAngle(tpose[name][key] - before[name][key]);
  assert.deepEqual(before, frozen, "applyPreset 不得改动原姿态");
  /* T 字要外展 90 度。这 90 度**拆在肩与上臂两节上**(肩的上限只有 60),
     所以不能只量肩那一节 —— 量的是两节的和。 */
  const abduction = relative("shoulder.L", "z") + relative("upperArm.L", "z");
  assert.ok(Math.abs(abduction - 90) < 1e-6, `T 字的左臂应当外展 90 度,现在 ${abduction}`);
  assert.ok(relative("shoulder.L", "z") <= rig.byName("shoulder.L").limit.z[1] + 1e-9,
    "T 字把肩转出了它自己的窗口,预设会被 limit 夹掉一半");
  const abductionR = relative("shoulder.R", "z") + relative("upperArm.R", "z");
  assert.ok(Math.abs(abductionR + 90) < 1e-6, `T 字的右臂应当反向开 90 度,现在 ${abductionR}`);
  assert.deepEqual(rig.applyPreset(before, "no-such-preset"), frozen, "未知预设等同于默认姿态");
}

/* 左右对称:成对关节的偏移与骨长必须镜像。
   真机踩到过躯干把手臂吃掉(肩偏移比髋半径还小),所以顺带守住"肩必须落在
   躯干轮廓之外"这条 —— 现在的轮廓来自模型自己的零件,只能按"肩的横向偏移
   大于髋的横向偏移"来判,不能再用程序化时代的 radius × sx。 */
{
  const shoulderL = rig.byName("shoulder.L");
  const shoulderR = rig.byName("shoulder.R");
  assert.ok(shoulderL.offset[0] > 0, "左肩应当在 +X 侧");
  assert.ok(shoulderR.offset[0] < 0, "右肩应当在 -X 侧");
  /* 偏移与骨长是从模型网格量出来的,而网格本身不是严格镜像:
     实测左右肩横向偏移差 0.045mm、纵向差 0.26mm(与上臂骨长的 0.26mm 差同源)。
     所以这里给 1mm 容差 —— 1e-6 只有网格完全镜像时才可能满足,那是永远修不好的假红。
     真正要守的是下面那条"肩必须明显在髋之外"。 */
  assert.ok(Math.abs(Math.abs(shoulderL.offset[0]) - Math.abs(shoulderR.offset[0])) < 0.001,
    "左右肩的横向偏移必须对称(容差 1mm,网格不是严格镜像)");
  assert.ok(shoulderL.offset[0] > rig.byName("hips").offset[0] + 0.1, "肩的横向偏移应当明显大于髋(否则手臂会被躯干吃掉)");

  for (const name of rig.names()) {
    if (!rig.isPaired(name)) continue;
    const other = rig.byName(rig.mirrorName(name));
    const delta = Math.abs(rig.byName(name).length - other.length);
    /* 模型左右两侧的骨长不会完全相等(网格本身就不严格对称),给 5mm 或 5% 的容差 */
    assert.ok(delta < Math.max(0.005, other.length * 0.05), `${name} 与 ${other.name} 的骨长差太多(${delta.toFixed(4)}m)`);
    assert.ok(Math.abs(rig.byName(name).offset[1] - other.offset[1]) < 0.005, `${name} 与 ${other.name} 的纵向偏移应当基本一致`);
  }
}

/* 预设是一整套姿态:从默认站姿起算,不能被上一个预设或当前姿态污染。
   (真机实测踩到过:先点 T 字再点行走,肩的 z=±90 会留下来,手臂一直横着。) */
{
  const fromStand = rig.applyPreset(rig.defaultAngles(), "walk");
  const afterTpose = rig.applyPreset(rig.applyPreset(rig.defaultAngles(), "tpose"), "walk");
  assert.deepEqual(afterTpose, fromStand, "先摆 T 字再套行走,结果必须与直接套行走一致");
  assert.equal(afterTpose["shoulder.L"].z, app.utils.normalizeAngle(rig.byName("shoulder.L").rest[2]), "肩的角度不该被上一个预设残留下来");
  assert.equal(afterTpose["shoulder.R"].z, app.utils.normalizeAngle(rig.byName("shoulder.R").rest[2]), "左右两侧都不该残留");
}

/* 旋转矩阵正交,局部 +Y 方向可判定 */
{
  const matrix = rig.rotationMatrix({ x: 20, y: -35, z: 47 });
  for (let row = 0; row < 3; row += 1) {
    const length = Math.hypot(matrix[row * 3], matrix[row * 3 + 1], matrix[row * 3 + 2]);
    assert.ok(Math.abs(length - 1) < 1e-9, `第 ${row} 行不是单位向量`);
  }
  const up = rig.localUp({ x: 0, y: 0, z: 0 });
  assert.ok(Math.abs(up.x) < 1e-9 && Math.abs(up.y - 1) < 1e-9 && Math.abs(up.z) < 1e-9, "零角度时局部 +Y 就是世界 +Y");
  const down = rig.localUp({ x: 0, y: 0, z: 180 });
  assert.ok(Math.abs(down.y + 1) < 1e-9, "绕 Z 转 180 度后骨骼应指向正下方");
}

/* 前向运动学:站姿的量级必须对得上。
   数值全部来自宜家人偶自己的骨架(身高统一缩放到 1.7400m,脚底 y=0),
   所以这里量的是"模型转换得对不对",不是"我们的数字写没写对"。 */
{
  const positions = rig.jointPositions(rig.defaultAngles());
  assert.ok(Math.abs(positions.hips.origin.y - 0.9158) < 0.005, `髋关节离地 ${positions.hips.origin.y.toFixed(4)}m,与模型不符`);
  assert.ok(Math.abs(positions.head.tail.y - rig.height) < 0.01, `头顶 ${positions.head.tail.y.toFixed(4)}m 应当约等于骨架总高 ${rig.height}`);
  assert.ok(positions["foot.L"].tail.y < 0.05, "脚掌末端应当贴地");
  assert.ok(positions["foot.L"].tail.z > 0.05, "脚尖应当朝前(世界 +Z)");
  assert.ok(positions["hand.L"].tail.y < 0.95, "站姿下左手指向地面");
  assert.ok(positions["shoulder.L"].origin.y > positions["hips"].origin.y, "肩必须在髋之上");
  const raised = rig.jointPositions(rig.applyPreset(rig.defaultAngles(), "wave"));
  assert.ok(raised["hand.L"].tail.y > positions["hand.L"].tail.y, "举手预设应当把左手抬起来");
}

/* 序列化:往返一致,脏数据被拒 */
{
  const record = rig.serialize({ name: "pose-a", angles: { "upperArm.L": { x: 10 } } });
  assert.equal(record.schema, 1);
  assert.equal(record.name, "pose-a");
  const again = rig.parse(JSON.stringify(record));
  assert.deepEqual(again.angles, record.angles, "序列化往返应当一致");
  assert.equal(rig.parse("not json"), null);
  assert.equal(rig.parse({}), null);
}

console.log("rig.test.mjs: ok");
