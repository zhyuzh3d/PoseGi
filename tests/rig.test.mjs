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
    assert.ok(joint.length > 0, `${joint.name} 的骨骼长度必须是正数`);
    assert.ok(joint.radius > 0, `${joint.name} 的半径必须是正数`);
    assert.equal(joint.offset.length, 3, `${joint.name} 的 offset 必须是三个分量`);
    assert.equal(joint.rest.length, 3, `${joint.name} 的 rest 必须是三个分量`);
    seen.add(joint.name);
  }
  assert.equal(rig.joints.length, 19, "人形骨架固定 19 个关节");
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
