/* IK 与骨架工具的纯逻辑测试
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
  "app/assets/models/ikea.js", "app/core/rig.js", "app/core/ik.js"]) {
  const code = fs.readFileSync(path.join(root, file), "utf8");
  new Function(code)();
}

const app = globalThis.window.posegi;
const rig = app.rig;
const ik = app.ik;

assert.ok(ik, "ik 没有注册到 window.posegi");
/* 骨架的尺寸与朝向来自人物模型,先装上再测 */
rig.applyModel(app.models.get("ikea"));

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/* 欧拉角反解必须是 rotationMatrix 的逆:任意角度往返一致 */
{
  const samples = [
    { x: 0, y: 0, z: 0 },
    { x: 20, y: -35, z: 47 },
    { x: -120, y: 40, z: 178 },
    { x: 90, y: 0, z: -90 },
    { x: 15, y: -70, z: -160 }
  ];
  for (const sample of samples) {
    const back = rig.eulerFromMatrix(rig.rotationMatrix(sample));
    for (const key of ["x", "y", "z"]) {
      const delta = Math.abs(app.utils.normalizeAngle(back[key] - sample[key]));
      assert.ok(delta < 1e-6, `欧拉角往返失败 ${JSON.stringify(sample)} → ${key} 差 ${delta}`);
    }
  }
}

/* 绕轴旋转矩阵:与 rig.rotationMatrix 同一套手性,并且正交 */
{
  const matrix = rig.axisAngleMatrix([1, 0, 0], Math.PI / 2);
  const mapped = rig.matrixApply(matrix, [0, 1, 0]);
  assert.ok(Math.abs(mapped[2] - 1) < 1e-9, "绕 +X 转 90 度应当把 +Y 送到 +Z(与脚下的脚掌同向)");
  const mirrored = rig.matrixApply(matrix, [0, 0, 1]);
  assert.ok(Math.abs(mirrored[1] + 1) < 1e-9, "同一只手性下 +Z 应当送到 -Y");
  const back = rig.matrixMultiply(rig.transpose(matrix), matrix);
  for (let index = 0; index < 9; index += 1) {
    const expected = index % 4 === 0 ? 1 : 0;
    assert.ok(Math.abs(back[index] - expected) < 1e-12, "转置乘以自己应当是单位矩阵");
  }
}

/* 关节把手与零件网格是两码事。
 * 手/脚:腕球、踝球负责"把这条胳膊/腿拉过去"(IK),而手掌、脚掌这一整块零件
 * 抓住时负责"转角度"。这两半混成一个判定,真机上就表现为"点手点不动、点脚点不动"。
 * 零件几何来自模型(尺寸也来自模型),所以这里只守"谁抓谁"这一个纯逻辑。 */
{
  const ballJoints = rig.joints.filter((joint) => joint.node);
  assert.ok(ballJoints.length >= 8, "肩、肘、腕、髋、膝、踝都应当有可抓的球");
  for (const joint of ballJoints) {
    /* 把手球一律由视口按同一个基准尺寸画,不再逐个放大 ——
       球是"选中才现"的操作提示,不靠尺寸区分谁大谁小;
       能不能点中由屏幕容差(NODE_GRAB_PX)负责,与球的大小无关。 */
    assert.equal(joint.nodeScale, undefined, `${joint.name} 不该再带 nodeScale`);
    /* 把手球一律画在**关节原点**上,命中锚点也取原点。
       所以没有任何关节该带"球心偏移"补偿 —— 模型自带的那颗球(肩)也必须校正到
       原点上,这条由下面那段"直接量球块质心"守着。 */
    assert.equal(joint.nodeOffset, undefined,
      `${joint.name} 的把手球心必须在关节原点上,不该有偏移补偿`);
  }
  /* broot 是纯变换节点,不承载姿态:它自己既不旋转、也不移动 ——
     视口按 isPivot 把拖它改判成"搬运 bbox",人物的整体旋转归 hips
     (转 hips 会带动脊柱与双腿,等于绕骨盆转一圈)。 */
  assert.ok(rig.isPivot("broot"), "broot 必须是纯变换节点,视口据此把拖动改判成搬运");
  assert.ok(rig.byName("broot").node, "broot 的搬运把手要参与屏幕容差(它落在脚底中心,不给就会被踝球抢走)");
  assert.equal(rig.byName("broot").grab, undefined, "broot 不该声明抓取语义");
  for (const name of rig.names()) {
    const chain = rig.ikChain(name);
    assert.ok(chain.indexOf("broot") < 0, `${name} 的 IK 链里不该出现 broot`);
    assert.ok(chain.indexOf("hips") < 0, `${name} 的 IK 链里不该出现 hips`);
  }
  /* 用模型自带那颗球当把手的关节(肩):那件网格本身就是一颗球,而**球心必须落在
     关节原点上** —— 视口与命中的锚点取的就是关节原点,球心一偏锚点跟着偏,
     表现成"看着点在球上却掉进空地"。
     2026-09-25 实测过一次:模型那颗球心偏出 **47.4mm**,换算到设备上约 23px,
     而屏幕容差(NODE_GRAB_PX)当时只有 33px ⇒ 球的外半边点不到。骨架按人体测量学
     校正后球心归零(球块质心 0.0mm),rig 里那份偏移补偿已删 —— 这里改成直接量。 */
  {
    const ikea = app.models.get("ikea");
    for (const side of ["L", "R"]) {
      const shoulder = rig.byName(`shoulder.${side}`);
      assert.equal(shoulder.nodeFrom, "model", `肩 ${side} 的把手球应当用模型自带的那颗`);
      const part = ikea.parts[shoulder.name];
      assert.ok(part && part.pos, `${shoulder.name} 在模型里必须有对应零件`);
      const bytes = app.utils.base64ToBytes(part.pos);
      /* 顶点是 3 个 float32 一组。个数由**字节数**定,不去信 part.n ——
         这个字段的语义在 models.js 里被当成浮点数用过,别让测试跟着一起错。 */
      const count = bytes.byteLength / 12;
      const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      const ball = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < count; i += 1) {
        ball.x += floats[i * 3];
        ball.y += floats[i * 3 + 1];
        ball.z += floats[i * 3 + 2];
      }
      ball.x /= count; ball.y /= count; ball.z /= count;
      /* 顶点写在关节局部坐标系里,所以球心就该是 (0,0,0)。
         容差 3mm:42 个顶点的二十面体不是严格均匀分布,质心本身有零点几毫米的抖。 */
      const drift = distance(ball, { x: 0, y: 0, z: 0 });
      assert.ok(drift < 0.003,
        `肩 ${side} 自带的把手球心必须落在关节原点上,实测偏了 ${(drift * 1000).toFixed(1)}mm`);
      assert.equal(rig.grabMode(`shoulder.${side}`), "bone", `肩球 ${side} 抓起来仍然是旋转`);
    }
  }

  for (const side of ["L", "R"]) {
    assert.equal(rig.grabMode(`hand.${side}`), "node", `腕球 ${side} 侧应当用 IK 移动整条胳膊`);
    assert.equal(rig.boneGrab(`hand.${side}`), "bone", `手掌网格 ${side} 侧应当能转角度`);
    assert.equal(rig.grabMode(`foot.${side}`), "node", `踝球 ${side} 侧应当用 IK 移动整条腿`);
    assert.equal(rig.boneGrab(`foot.${side}`), "bone", `脚掌网格 ${side} 侧应当能转角度`);
  }
  /* 其余零件的网格照旧只管旋转:点小臂中间是转小臂,不是去拽肘球。
     头是刻意的例外 —— 它没有球,整块头就是零件本身,抓住它就是挪头。 */
  for (const name of ["upperArm.L", "forearm.L", "thigh.R", "shin.R", "chest", "neck", "head"]) {
    const expected = name === "head" ? "node" : "bone";
    assert.equal(rig.boneGrab(name), expected, `${name} 的零件网格的拖动语义不对`);
  }
}

/* 手与脚的可转范围必须按人体来,而且记的是**相对静止姿态的增量**。
   宜家的脚踝 rest x 是 65.4 度,写绝对角度会一上来就被夹飞。
   (整张关节范围表 + 左右镜像 + 反关节几何验证在 rig.test.mjs,这里只守
    "IK 会去拧的那几个"最容易拧过头的关节。) */
{
  for (const name of ["hand.L", "hand.R", "foot.L", "foot.R", "shin.L", "shin.R", "forearm.L", "forearm.R"]) {
    const joint = rig.byName(name);
    assert.ok(joint.limit, `${name} 缺少可转范围`);
  }
  const hand = rig.byName("hand.L");
  const foot = rig.byName("foot.L");

  /* IK 会去拧的那几个关节,窗口不能宽到能反关节 */
  for (const side of ["L", "R"]) {
    assert.equal(rig.byName(`shin.${side}`).limit.x[1], 0, `膝 ${side} 不许有反张的余量`);
    assert.equal(rig.byName(`forearm.${side}`).limit.x[0], 0, `肘 ${side} 不许有反张的余量`);
    assert.ok(rig.byName(`thigh.${side}`).limit.x[0] >= -30,
      `髋 ${side} 的后伸窗口太宽(IK 会把大腿甩到身后去)`);
    assert.ok(rig.byName(`upperArm.${side}`).limit.y[0] >= -90 && rig.byName(`upperArm.${side}`).limit.y[1] <= 90,
      `肩 ${side} 的旋内旋外窗口太宽`);
  }

  /* 手腕:掌屈 / 背伸各约 70 度,桡尺偏窄;脚踝:勾脚背约 20 度、绷脚背约 50 度 */
  assert.ok(hand.limit.x[1] <= 90 && hand.limit.x[1] > 45, "手腕的掌屈上限不合人体");
  assert.ok(hand.limit.x[0] >= -80 && hand.limit.x[0] < -40, "手腕的背伸下限不合人体");
  assert.ok(hand.limit.z[1] <= 30 && hand.limit.z[1] >= 10, "手腕的侧偏范围过宽");
  assert.ok(foot.limit.x[1] <= 35 && foot.limit.x[1] >= 10, "脚踝的勾脚范围不合人体");
  assert.ok(foot.limit.x[0] >= -60 && foot.limit.x[0] <= -30, "脚踝的绷脚范围不合人体");
  assert.ok(foot.limit.y[1] <= 30 && foot.limit.z[1] <= 30, "脚踝的摆转范围过宽");

  /* 收口:窗口窄的时候不能"先夹后归一化"。
     记的是增量 —— 输入是绝对角度,先减去 rest 得到"相对静止姿态转了多少",再夹。
     (增量自己也过一次归一化,所以用 ±100 这种不绕圈的量来测;±200 会等价成 ∓160,
     顶到另一端去,那是归一化的定义。) */
  const restHandX = app.utils.normalizeAngle(hand.rest[0]);
  const restFootX = app.utils.normalizeAngle(foot.rest[0]);
  assert.equal(rig.clampJoint("hand.L", "x", restHandX + 100), app.utils.normalizeAngle(restHandX + hand.limit.x[1]), "手腕超上限应当顶在上限");
  assert.equal(rig.clampJoint("hand.L", "x", restHandX - 100), app.utils.normalizeAngle(restHandX + hand.limit.x[0]), "手腕超下限应当顶在下限");
  assert.equal(rig.clampJoint("foot.L", "x", restFootX - 100), app.utils.normalizeAngle(restFootX + foot.limit.x[0]), "脚踝超下限应当顶在下限");
  assert.equal(rig.clampJoint("foot.L", "x", restFootX + 100), app.utils.normalizeAngle(restFootX + foot.limit.x[1]), "脚踝超上限应当顶在上限");
  /* 窗口内的输入原样通过(相对 rest 的增量) */
  assert.equal(rig.clampJoint("hand.L", "x", restHandX + 30), app.utils.normalizeAngle(restHandX + 30), "窗口内的角度不该被改动");
  /* 夹取之后绝不允许悄悄变成 rest(那正是"拖了没反应"的样子) */
  assert.notEqual(rig.clampJoint("hand.L", "x", restHandX + 100), restHandX, "超范围的写入被压回了默认站姿");
  /* 每个关节都带自己的窗口了,所以"全局 ±180"那条路只剩陌生关节走;
     已知关节越界一律顶在**它自己的**窗口边界上 */
  const upper = rig.byName("upperArm.L");
  const restUpperX = app.utils.normalizeAngle(upper.rest[0]);
  assert.equal(rig.clampJoint("upperArm.L", "x", 999),
    app.utils.normalizeAngle(restUpperX + upper.limit.x[0]),
    "肩关节的越界写入应当顶在它自己的下限上");
  assert.equal(rig.clampJoint("not.a.joint", "x", 999), 180, "陌生关节沿用全局 ±180");
}

/* 站姿落地:脚掌末端贴地、脚尖朝前(数值来自宜家人偶自己的骨架) */
{
  const offsets = rig.jointPositions(rig.defaultAngles());
  assert.ok(Math.abs(offsets["foot.L"].tail.y) < 0.05, `脚掌末端应当贴地,现在 y=${offsets["foot.L"].tail.y.toFixed(4)}`);
  assert.ok(offsets["foot.L"].tail.z > 0.05, "脚尖应当朝前");
  assert.ok(offsets["foot.L"].origin.y > offsets["foot.L"].tail.y, "脚踝应当在脚掌之上");
}

/* IK 链:肢体只走肢体,躯干沿着脊柱往上,骨盆永不进链 */
{
  assert.deepEqual(rig.ikChain("hand.L"), ["shoulder.L", "upperArm.L", "forearm.L"]);
  assert.deepEqual(rig.ikChain("forearm.L"), ["shoulder.L", "upperArm.L"]);
  assert.deepEqual(rig.ikChain("shin.L"), ["thigh.L"]);
  assert.deepEqual(rig.ikChain("foot.L"), ["thigh.L", "shin.L"]);
  assert.deepEqual(rig.ikChain("head"), ["spine", "chest", "neck"]);
  assert.deepEqual(rig.ikChain("neck"), ["spine", "chest"]);
  for (const name of rig.names()) {
    assert.ok(rig.ikChain(name).indexOf("hips") < 0, `${name} 的 IK 链里不许出现 hips`);
    assert.ok(rig.ikChain(name).indexOf("broot") < 0, `${name} 的 IK 链里不许出现 broot`);
  }
  assert.deepEqual(rig.ikChain("shoulder.L"), [], "肩球没有可转的上游关节,视口应当退回旋转");
}

/* IK 求解:抬脚能真的抬到位,且不碰链外的关节 */
{
  const before = rig.defaultAngles();
  const start = rig.jointPositions(before)["foot.L"].origin;
  const target = { x: start.x, y: 0.36, z: 0.30 };
  const result = ik.solve(before, { effector: "foot.L", target });
  const landed = rig.jointPositions(result.angles)["foot.L"].origin;
  assert.ok(distance(landed, target) < 0.02, `抬脚没到位,还差 ${distance(landed, target).toFixed(4)}m`);
  assert.ok(Object.keys(result.changed).length > 0, "求解必须至少改一个关节");
  assert.ok(!result.changed.hips, "骨盆不许被 IK 改动");
  assert.ok(!result.changed["foot.L"], "效应器自己不参与旋转(绕自身原点转不会移动自己)");
  assert.deepEqual(before, rig.defaultAngles(), "solve 不得改动传入的姿态");
}

/* 抬脚必须走**解剖学的那条路**:髋前屈(+x)、膝屈(−x)。
   这一条是踩出来的:CCD 自己解这个目标时会用"膝反张"(膝 +x)去够,加上"膝只许屈"
   的窗口之后它一步都迈不动,整条腿退化成绕髋摆动的直杆 —— 真机上就是
   "拖脚踝往上,脚不动"。两骨链改走闭式解之后,解出来的才是人腿的样子。 */
{
  const cases = [
    { y: 0.16, z: 0.09 },   /* 往前上方抬 */
    { y: 0.36, z: 0.30 },
    { y: 0.16, z: -0.13 },  /* 往后 */
    { y: 0.08, z: 0.00 }    /* 单纯屈膝(脚跟往臀走) */
  ];
  for (const item of cases) {
    for (const side of ["L", "R"]) {
      const before = rig.defaultAngles();
      const start = rig.jointPositions(before)[`foot.${side}`].origin;
      const target = { x: start.x, y: start.y + item.y, z: start.z + item.z };
      const landed = rig.jointPositions(ik.solve(before, { effector: `foot.${side}`, target }).angles);
      const ankle = landed[`foot.${side}`].origin;
      const knee = landed[`thigh.${side}`].tail;
      const error = distance(ankle, target);
      assert.ok(error < 0.01, `${side} 侧抬脚没到位,还差 ${error.toFixed(4)}m`);

      const result = ik.solve(before, { effector: `foot.${side}`, target });
      const thigh = rig.byName(`thigh.${side}`);
      const shin = rig.byName(`shin.${side}`);
      const hipFlexion = app.utils.normalizeAngle(result.angles[`thigh.${side}`].x - thigh.rest[0]);
      const kneeFlexion = app.utils.normalizeAngle(result.angles[`shin.${side}`].x - shin.rest[0]);
      assert.ok(kneeFlexion <= 0, `${side} 侧膝被拧成了反关节(${kneeFlexion.toFixed(1)} 度)`);
      /* 膝屈的方向:踝必须落在膝的"后方"(世界 -Z 侧)或者竖直下方,绝不在膝的前方 */
      assert.ok(ankle.z - knee.z < 0.01,
        `${side} 侧小腿被转到了膝的前方(${(ankle.z - knee.z).toFixed(3)}m)—— 膝反张`);
      /* 往前上方抬的时候,髋必须是前屈(而不是把大腿往后甩) */
      if (item.z > 0.02) {
        assert.ok(hipFlexion > 0,
          `${side} 侧抬脚向前时髋竟然是后伸(${hipFlexion.toFixed(1)} 度)`);
      }
    }
  }
}

/* 拖脚时膝盖不许跳。两骨闭式解里"膝朝轴线哪一边鼓"是一个一维自由度的选择:
   余弦定理只定下膝到髋的距离,没说它绕"髋→目标"轴落在哪个方位。方位定错就会瞬间翻到
   另一侧 —— 修复前实测:膝位移一次跳 460mm、末端残差 524mm、膝角被夹到 0.5°、整条腿锁死。
   守三件事:
     ① 连续拖:目标绕髋在矢状面里一步步转,相邻两步的膝位移不得出现跳变;
     ② 膝必须始终待在矢状面里:侧向偏移不得随拖动累积(拿"被 IK 夹住之后的膝位"当方位
        参考时,实测会一路漂到 225mm —— 膝盖横着撇出去);
     ③ 膝盖能到的那片范围里,脚要真的到位。
   递进模式(上一帧的解作起点)才是真实拖动的样子,视口就是这么喂的。 */
{
  const span = 0.66;                    /* 目标到髋的距离,压在腿长 0.8467 之内 ⇒ 腿是弯的 */
  const hip = rig.frames(rig.defaultAngles())["thigh.L"].origin;
  let pose = rig.defaultAngles();
  let previous = null;
  let worstStep = 0;
  let worstSide = 0;
  let worstError = 0;
  /* 只走到 -10 度:再往上(髋前上方)需要前屈超过 120 度,超出生理范围,本来就够不到 */
  for (let deg = -80; deg <= -10; deg += 2) {
    const radians = deg * Math.PI / 180;
    const target = {
      x: hip.x,
      y: hip.y + Math.sin(radians) * span,
      z: hip.z + Math.cos(radians) * span
    };
    pose = ik.solve(pose, { effector: "foot.L", target }).angles;
    const frames = rig.frames(pose);
    const base = frames["thigh.L"].origin;
    const knee = frames["shin.L"].origin;
    const offset = { x: knee.x - base.x, y: knee.y - base.y, z: knee.z - base.z };
    worstSide = Math.max(worstSide, Math.abs(offset.x));
    worstError = Math.max(worstError, distance(frames["foot.L"].origin, target));
    if (previous) worstStep = Math.max(worstStep, distance(offset, previous));
    previous = offset;
  }
  assert.ok(worstStep < 0.05,
    `拖脚时膝盖跳了 ${(worstStep * 1000).toFixed(1)}mm(应当是随目标连续移动的量级)`);
  assert.ok(worstSide < 0.02,
    `膝盖撇出了矢状面 ${(worstSide * 1000).toFixed(1)}mm(膝只能在这个平面里弯)`);
  assert.ok(worstError < 0.02,
    `膝盖够得到的范围里抬脚没到位,最差差 ${(worstError * 1000).toFixed(1)}mm`);
}

/* 目标超出腿长时,腿伸直去够,但绝不因此反关节,也不吐 NaN。
   腿长 = |大腿| + |小腿| = 0.7736m,这里故意给一个 1.2m 外的目标。 */
{
  for (const side of ["L", "R"]) {
    const result = ik.solve(rig.defaultAngles(), {
      effector: `foot.${side}`,
      target: { x: 0.08, y: 0.02, z: 0.90 }
    });
    const shin = rig.byName(`shin.${side}`);
    const kneeFlexion = app.utils.normalizeAngle(result.angles[`shin.${side}`].x - shin.rest[0]);
    assert.ok(kneeFlexion <= 0 && kneeFlexion >= shin.limit.x[0] - 1e-9,
      `${side} 侧够不到的目标把膝拧成了 ${kneeFlexion.toFixed(1)} 度`);
    for (const joint of rig.joints) {
      for (const key of rig.angleKeys) {
        const value = result.angles[joint.name][key];
        assert.ok(Number.isFinite(value), `够不到时 ${joint.name}.${key} 变成了非有限数`);
      }
    }
  }
}

/* IK 求解:手够到身体前方,并且只动胳膊 */
{
  const before = rig.defaultAngles();
  const start = rig.jointPositions(before)["hand.L"].origin;
  const target = { x: start.x - 0.06, y: 1.24, z: 0.34 };
  const result = ik.solve(before, { effector: "hand.L", target });
  const landed = rig.jointPositions(result.angles)["hand.L"].origin;
  assert.ok(distance(landed, target) < 0.02, `举手没到位,还差 ${distance(landed, target).toFixed(4)}m`);
  for (const name of Object.keys(result.changed)) {
    assert.ok(rig.ikChain("hand.L").indexOf(name) >= 0, `IK 动了链外的关节 ${name}`);
  }
}

/* 每个能抓的节点都真的会动 —— 求解器的**路由**错一次,真机表现就是"拖着某个球没反应":
 *   foot.L      两骨链(大腿 + 小腿)      → 解析式闭式解
 *   forearm.L   退化的两骨链(肩与上臂同原点,第一段长度 0)→ 必须退回 CCD
 *   shin.L      单关节链(只有大腿)      → CCD;膝盖只能落在绕髋的球面上
 *   hand.L      三节链                   → CCD
 *   head        三节链(脊柱上行)        → CCD
 * 所以单关节/单球面的目标要拿"真的转一下关节算出来的位置"当目标,不能随便写一个点。 */
{
  const bentPose = function (name, delta) {
    const pose = rig.defaultAngles();
    const joint = rig.byName(name);
    const key = Object.keys(delta)[0];
    const index = rig.angleKeys.indexOf(key);
    pose[name][key] = app.utils.normalizeAngle(joint.rest[index] + delta[key]);
    return pose;
  };

  const kneeTarget = rig.jointPositions(bentPose("thigh.L", { x: 24 }))["thigh.L"].tail;
  const elbowTarget = rig.jointPositions(bentPose("upperArm.L", { x: 30 }))["forearm.L"].origin;
  const headTarget = rig.jointPositions(bentPose("neck", { x: 20 }))["head"].origin;
  const handStart = rig.jointPositions(rig.defaultAngles())["hand.L"].origin;

  const cases = [
    ["shin.L", kneeTarget],                                                  /* 单关节 */
    ["forearm.L", elbowTarget],                                              /* 退化两骨链 */
    ["foot.L", { x: 0.082, y: 0.16, z: 0.09 }],                              /* 两骨链 */
    ["hand.L", { x: handStart.x, y: handStart.y + 0.30, z: handStart.z + 0.24 }],
    ["head", headTarget]
  ];
  for (const [effector, target] of cases) {
    const before = rig.defaultAngles();
    const result = ik.solve(before, { effector, target });
    const landed = rig.jointPositions(result.angles)[effector].origin;
    assert.ok(Object.keys(result.changed).length > 0, `拖 ${effector} 一个关节都没动`);
    assert.ok(distance(landed, target) < 0.02,
      `拖 ${effector} 没到位,还差 ${distance(landed, target).toFixed(4)}m`);
    for (const name of Object.keys(result.changed)) {
      assert.ok(rig.ikChain(effector).indexOf(name) >= 0, `${effector} 的求解动了链外的关节 ${name}`);
    }
  }
}

/* IK 求解:够不到的目标不许把关节转成乱码,角度始终在范围内 */
{
  const before = rig.defaultAngles();
  const result = ik.solve(before, { effector: "hand.L", target: { x: 9, y: 9, z: 9 } });
  for (const joint of rig.joints) {
    for (const key of rig.angleKeys) {
      const value = result.angles[joint.name][key];
      assert.ok(Number.isFinite(value), `${joint.name}.${key} 不是有限数`);
      assert.ok(value >= rig.limits.min && value <= rig.limits.max, `${joint.name}.${key} 越界`);
    }
  }
}

console.log("ik.test.mjs: ok");
