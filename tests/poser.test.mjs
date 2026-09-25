/* 摆姿编排的数据规则测试
 *
 * 都是"静默失效"型的问题:不报错、不崩,只是某个方向拖了没反应,
 * 靠肉眼很难发现,所以锁在测试里。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = globalThis.window || {};
for (const file of ["app/core/namespace.js", "app/core/utils.js", "app/core/models.js",
  "app/assets/models/ikea.js", "app/core/rig.js", "app/features/poser.js"]) {
  const code = fs.readFileSync(path.join(root, file), "utf8");
  new Function(code)();
}

const app = globalThis.window.posegi;
const rig = app.rig;
const poser = app.features.poser;

/* 骨架的尺寸与静止姿态来自人物模型,先装上 —— 不装的话整张表都是零 */
rig.applyModel(app.models.get("ikea"));

/* 角度写入的两条契约。
 *   1) **每个关节都有自己的窗口**(rig.joints 里 limit 一处都没落下),
 *      越界一律顶在该关节自己的上/下限上,而不是全局 ±180;
 *   2) 窗口记的是"**相对静止姿态的增量**" —— 必须先算出增量再夹。
 *      反过来(先夹到 ±180 再算增量)会把"绕轴转 186 度"这类等价旋转压成 0,
 *      正方向整条封死(真机表现:拖大腿往右完全不动、往左才动)。
 *      模型的 rest 不是 0(宜家脚踝 x 是 65.4 度、大腿的 rest z 是 -178.7 度),
 *      所以这两条必须分开测。 */
{
  const thigh = rig.byName("thigh.L");
  const restThighZ = app.utils.normalizeAngle(thigh.rest[2]);
  poser.reset();
  poser.patchJoint("thigh.L", { z: 999 });
  assert.equal(poser.angles()["thigh.L"].z, app.utils.normalizeAngle(restThighZ + thigh.limit.z[1]),
    "越界应当顶在大腿自己的外展上限上");

  const hand = rig.byName("hand.L");
  const restHandX = app.utils.normalizeAngle(hand.rest[0]);

  /* 窗口内:相对 rest 原样生效 */
  poser.reset();
  poser.patchJoint("hand.L", { x: restHandX + 40 });
  assert.equal(poser.angles()["hand.L"].x, app.utils.normalizeAngle(restHandX + 40), "窗口内的角度写入被改坏了");

  /* 窗口外:顶在同一侧的上/下限,而不是被压回 rest。
     (增量自己也过一次归一化,所以这里用 ±100 这种"不绕圈"的量;±200 会等价成
      ∓160,顶到另一端去 —— 那是归一化的定义,不是 bug。) */
  poser.reset();
  poser.patchJoint("hand.L", { x: restHandX + 100 });
  assert.equal(poser.angles()["hand.L"].x, app.utils.normalizeAngle(restHandX + hand.limit.x[1]), "超上限应当顶在掌屈上限");
  poser.reset();
  poser.patchJoint("hand.L", { x: restHandX - 100 });
  assert.equal(poser.angles()["hand.L"].x, app.utils.normalizeAngle(restHandX + hand.limit.x[0]), "超下限应当顶在背伸下限");
  /* 回归:夹取之后绝不允许悄悄变成 rest(那正是"拖了没反应"的样子) */
  assert.notEqual(poser.angles()["hand.L"].x, restHandX, "超范围的写入被压回了默认站姿");

  poser.reset();
  poser.setJointAngle("shoulder.R", "z", -186);
  assert.notEqual(poser.angles()["shoulder.R"].z, -180, "setJointAngle 的顺序与 patchJoint 不一致");

  poser.reset();
  assert.equal(poser.angles()["hand.L"].x, restHandX, "reset 没有回到默认站姿");
}

/* 手与脚的范围必须真的夹得住,而且 reset 之后不能被上一次夹取污染 */
{
  const foot = rig.byName("foot.L");
  const restFootX = app.utils.normalizeAngle(foot.rest[0]);
  poser.reset();
  poser.setJointAngle("foot.L", "x", restFootX - 120);
  assert.equal(poser.angles()["foot.L"].x, app.utils.normalizeAngle(restFootX + foot.limit.x[0]), "脚踝超出绷脚范围应当顶住下限");
  poser.reset();
  assert.equal(poser.angles()["foot.L"].x, restFootX, "夹取过的手脚角度污染了默认站姿");
}

/* 抓到球之后走"移动"还是"旋转",由上游有没有可转的关节决定。
 * 肘、膝、腕、踝、头都能移动;肩球直接挂在胸上,只能旋转 ——
 * 这一条如果反过来(整片都判成旋转),用户要的"点节点就是移动"就没了。 */
{
  const movable = ["head", "forearm.L", "forearm.R", "hand.L", "hand.R", "shin.L", "shin.R", "foot.L", "foot.R"];
  const rotatable = ["shoulder.L", "shoulder.R"];

  movable.forEach(function (name) {
    assert.equal(rig.grabMode(name), "node", name + " 应当能抓着移动");
    assert.ok(rig.ikChain(name).length, name + " 的 IK 链是空的,移动无从谈起");
  });
  rotatable.forEach(function (name) {
    assert.equal(rig.grabMode(name), "bone", name + " 应当退回旋转");
    assert.equal(rig.ikChain(name).length, 0, name + " 不该有上游可转关节");
  });
  ["upperArm.L", "thigh.R", "chest", "hips"].forEach(function (name) {
    assert.equal(rig.grabMode(name), "bone", name + " 没有节点球,只能是旋转");
  });
}

/* 每根骨骼都要有正的长度,旋转的力臂才不会是 0 */
{
  rig.joints.forEach(function (joint) {
    if (joint.pivot) return;
    assert.ok(joint.length > 0, joint.name + " 长度必须为正,否则转不动");
  });
}

/* 滑杆的行程与角度的夹取必须同源。
 * rig.jointRange 给出"该关节自己的可转窗口"(与 limit 同一套口径:相对静止姿态的增量),
 * 滑杆拿它当行程;rig.relativeAngle / absoluteAngle 是"显示"与"写入"之间的两个方向。
 * 这三条一起守的是"旋钮与数值对不上"那一类静默失效 ——
 * 行程曾经写死 ±180,于是旋钮能停在 180 而角度被夹在 20(小腿的自转窗口只有 ±20)。
 * 判据:①窗口正长度、不越全局 ±180 ②增量往返一致
 *       ③窗口端点写进去原样落回端点(能顶住,且不被折到别处)。 */
{
  const close = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
  let checked = 0;
  rig.joints.forEach(function (joint) {
    /* 纯变换节点(broot)不承载姿态:它的窗口是 [0,0],本来就不该转,也不该有滑杆 */
    if (joint.pivot) return;
    rig.angleKeys.forEach(function (key) {
      const range = rig.jointRange(joint.name, key);
      const tag = joint.name + "." + key;
      assert.ok(range[0] < range[1], tag + " 的可转窗口必须是正长度");
      assert.ok(range[0] >= rig.limits.min && range[1] <= rig.limits.max, tag + " 的窗口越出了全局 ±180");

      const rest = app.utils.normalizeAngle(joint.rest[rig.angleKeys.indexOf(key)]);
      assert.equal(rig.relativeAngle(joint.name, key, rest), 0, tag + " 在静止姿态下的增量应当是 0");

      [range[0], range[1], 0].forEach(function (delta) {
        const absolute = rig.absoluteAngle(joint.name, key, delta);
        assert.ok(close(rig.relativeAngle(joint.name, key, absolute), app.utils.normalizeAngle(delta)),
          tag + " 的增量往返不一致(" + delta + ")");
        poser.reset();
        poser.setJointAngle(joint.name, key, absolute);
        assert.ok(close(poser.angles()[joint.name][key], absolute),
          tag + " 的窗口端点在写入时被改动(端点 " + delta + ")");
        checked += 1;
      });

      /* 超出窗口必须顶在窗口上,而不是滑到别处。可转满一圈的关节(骨盆转身 ±180)除外:
         角度在绝对空间里绕圈,+30 会等价成另一侧窗口内的一个值,那是归一化的定义,不是 bug。 */
      if (range[1] - range[0] < 350) {
        poser.reset();
        poser.setJointAngle(joint.name, key, rig.absoluteAngle(joint.name, key, range[1] + 30));
        assert.ok(close(poser.angles()[joint.name][key], rig.absoluteAngle(joint.name, key, range[1])),
          tag + " 超出上限没有顶在窗口上");
        poser.reset();
        assert.ok(close(poser.angles()[joint.name][key], rest), tag + " 夹取过之后污染了默认站姿");
      }
    });
  });
  assert.ok(checked > 100, "窗口检查的覆盖面太小了(" + checked + ")");
}

console.log("poser.test.mjs: ok");
