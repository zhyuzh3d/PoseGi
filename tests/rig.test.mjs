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
for (const file of ["app/core/namespace.js", "app/core/utils.js", "app/core/rig.js"]) {
  const code = fs.readFileSync(path.join(root, file), "utf8");
  new Function(code)();
}

const app = globalThis.window.posegi;
const rig = app.rig;

assert.ok(rig, "rig 没有注册到 window.posegi");
assert.equal(app.version, "0.1.0");

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
    assert.deepEqual(defaults[joint.name], { x: joint.rest[0], y: joint.rest[1], z: joint.rest[2] });
  }
  const cleaned = rig.normalize({
    "upperArm.L": { x: 999, y: 0, z: 0 },
    "not.a.joint": { x: 10, y: 10, z: 10 }
  });
  assert.equal(cleaned["upperArm.L"].x, 180, "越界角度应被收敛到上限");
  assert.equal(cleaned["not.a.joint"], undefined, "陌生关节应当被丢弃");
  assert.deepEqual(cleaned.hips, { x: 0, y: 0, z: 0 });
}

/* 镜像:左右互换、Ry 与 Rz 取反、Rx 保持,且两次镜像回到原样 */
{
  const source = rig.applyPreset(rig.defaultAngles(), "walk");
  const mirrored = rig.mirror(source);
  assert.deepEqual(mirrored["thigh.R"], source["thigh.L"], "镜像后左侧姿态应落到右侧");
  assert.deepEqual(mirrored["upperArm.R"], source["upperArm.L"]);
  assert.deepEqual(mirrored.hips, source.hips, "非成对关节在镜像前后保持一致");
  assert.deepEqual(rig.mirror(mirrored), source, "镜像两次应当回到原姿态");

  const single = rig.mirror(rig.normalize({ "upperArm.L": { x: 30, y: 40, z: 50 } }));
  assert.deepEqual(single["upperArm.R"], { x: 30, y: -40, z: -50 });
}

/* 预设:叠加在默认姿态上,不改动入参 */
{
  const before = rig.defaultAngles();
  const frozen = JSON.parse(JSON.stringify(before));
  const tpose = rig.applyPreset(before, "tpose");
  assert.deepEqual(before, frozen, "applyPreset 不得改动原姿态");
  assert.equal(tpose["shoulder.L"].z, -90, "T 字的左肩应指向 +X");
  assert.equal(tpose["shoulder.R"].z, 90, "T 字的右肩应指向 -X");
  assert.deepEqual(rig.applyPreset(before, "no-such-preset"), frozen, "未知预设等同于默认姿态");
}

/* 手臂不许埋进躯干:肩的水平偏移必须让上臂完全落在躯干轮廓之外。
   真机踩到过:肩偏移只有 0.055 而髋半径就有 0.105,两条手臂全被躯干吃掉,
   渲染出来在胸口糊成一坨横杠,还以为是骨架算错了。 */
{
  const halfWidth = (joint) => joint.radius * (joint.shape ? joint.shape.sx : 1);
  const torsoHalf = Math.max(halfWidth(rig.byName("chest")), halfWidth(rig.byName("spine")), halfWidth(rig.byName("hips")));
  const shoulderL = rig.byName("shoulder.L");
  const shoulderR = rig.byName("shoulder.R");
  for (const [side, shoulder] of [["L", shoulderL], ["R", shoulderR]]) {
    const arm = rig.byName(`upperArm.${side}`);
    assert.ok(
      Math.abs(shoulder.offset[0]) - arm.radius > torsoHalf,
      `肩偏移 ${shoulder.offset[0]} 不足以让 ${side} 侧上臂离开躯干(躯干半宽 ${torsoHalf.toFixed(3)})`
    );
  }
  assert.ok(shoulderL.offset[0] > 0, "左肩应当在 +X 侧");
  assert.ok(shoulderR.offset[0] < 0, "右肩应当在 -X 侧");

  const shoulderWidth = Math.abs(shoulderL.offset[0]) * 2 + shoulderL.radius * 2;
  const ratio = shoulderWidth / rig.height;
  assert.ok(ratio > 0.2 && ratio < 0.34, `肩宽/身高 = ${ratio.toFixed(3)} 不合人体比例`);
}

/* 预设是一整套姿态:从默认站姿起算,不能被上一个预设或当前姿态污染。
   (真机实测踩到过:先点 T 字再点行走,肩的 z=±90 会留下来,手臂一直横着。) */
{
  const fromStand = rig.applyPreset(rig.defaultAngles(), "walk");
  const afterTpose = rig.applyPreset(rig.applyPreset(rig.defaultAngles(), "tpose"), "walk");
  assert.deepEqual(afterTpose, fromStand, "先摆 T 字再套行走,结果必须与直接套行走一致");
  assert.equal(afterTpose["shoulder.L"].z, 180, "肩的 rest 角度不该被上一个预设残留下来");
  assert.equal(afterTpose["shoulder.R"].z, 180, "左右两侧都不该残留");
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

/* 前向运动学:站姿的量级必须对得上 */
{
  const positions = rig.jointPositions(rig.defaultAngles());
  assert.ok(Math.abs(positions.hips.origin.y - 0.95) < 1e-9, "髋关节离地 0.95m");
  assert.ok(Math.abs(positions.head.tail.y - rig.height) < 1e-6, "头顶应当等于骨架总高");
  assert.ok(Math.abs(positions["foot.L"].tail.y - 0.13) < 1e-6, "脚踝离地 0.13m");
  assert.ok(positions["foot.L"].tail.z > 0.15, "脚尖应当朝前(世界 +Z)");
  assert.ok(positions["hand.L"].tail.y < 0.95, "站姿下左手指向地面");
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
