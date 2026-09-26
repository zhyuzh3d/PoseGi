/* 模型卡与 CVP 请求契约的测试
 *
 * 这里锁的都是"静默发错请求"型的问题:不报错、界面也正常,只是发出去的画幅、
 * 步数或参考图强度是另一张卡的参数,表现成"新加的卡怎么都不对"或服务端 400。
 * 三个任务(quick / upscale / qwen)的参数只有一份出处(app.defaults.cvpTasks),
 * 这些断言守的就是"界面、夹取、请求三处读的是同一份"。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = globalThis.window || {};
for (const file of ["app/core/namespace.js", "app/core/i18n.js", "app/core/utils.js",
  "app/services/providers.js", "app/services/store.js"]) {
  const code = fs.readFileSync(path.join(root, file), "utf8");
  new Function(code)();
}

const app = globalThis.window.posegi;
const providers = app.services.providers;
const internals = providers.internals;
const store = app.services.store;

const TASKS = Object.keys(app.defaults.cvpTasks);
assert.deepEqual(TASKS, ["quick", "upscale", "qwen"], "任务表应该是这三档");

/* 1) 任务名不认识的卡一律退回 quick,而不是原样发出去。
      以前 store 用的是"是不是 upscale",第三种任务加进来时会被悄悄降级成 quick ——
      卡上写着 Qwen、请求里却是 quick。 */
{
  assert.equal(internals.cvpTask({ task: "qwen" }), "qwen");
  assert.equal(internals.cvpTask({ task: "upscale" }), "upscale");
  assert.equal(internals.cvpTask({ task: "wipe" }), "quick");
  assert.equal(internals.cvpTask({}), "quick");
  assert.equal(store.shapeConfig({ schema: 3, models: [{ id: "a", task: "qwen" }] }).models[0].task, "qwen");
  assert.equal(store.shapeConfig({ schema: 3, models: [{ id: "a", task: "nope" }] }).models[0].task, "quick");
}

/* 2) 画幅必须落在插件自己报出来的那几档上,否则会被 400 顶回来:
      quick 只有 512,渲染只有 1024,Qwen 是 512–1024 每 64 一档。 */
{
  assert.equal(internals.cvpSize({ task: "quick", size: 768 }), 512, "快速只有 512 这一档");
  assert.equal(internals.cvpSize({ task: "upscale", size: 512 }), 1024, "渲染只有 1024 这一档");
  assert.equal(internals.cvpSize({ task: "upscale", size: 2048 }), 1024, "本应用的画幅上限就是 1024");
  assert.equal(internals.cvpSize({ task: "qwen", size: 700 }), 704, "Qwen 要吸附到 64 的整数倍");
  assert.equal(internals.cvpSize({ task: "qwen", size: 512 }), 512);
  assert.equal(internals.cvpSize({ task: "qwen", size: 1024 }), 1024);
  assert.equal(internals.cvpSize({ task: "qwen", size: 4096 }), 1024, "Qwen 上限 1024");
  assert.equal(internals.cvpSize({ task: "qwen", size: 100 }), 512, "Qwen 下限 512");
  for (let value = 512; value <= 1024; value += 7) {
    const snapped = internals.cvpSize({ task: "qwen", size: value });
    assert.ok(snapped >= 512 && snapped <= 1024 && snapped % 64 === 0, `Qwen 画幅必须合法,收到 ${snapped}`);
  }
}

/* 3) 参考图强度:卡上是 0–200(100 中性),插件要的是 0.05–0.95。
      每个任务有自己的基准 —— 渲染更贴原图,Qwen 的 100 就是"原稿原样送进去"。 */
{
  assert.equal(internals.refStrength01({ task: "quick", refStrength: 100 }), 0.55);
  assert.equal(internals.refStrength01({ task: "upscale", refStrength: 100 }), 0.75);
  assert.equal(internals.refStrength01({ task: "qwen", refStrength: 100 }), 0.95);
  assert.ok(internals.refStrength01({ task: "qwen", refStrength: 50 }) < 0.95, "调低要真的更低");
  assert.equal(internals.refStrength01({ task: "quick", refStrength: 0 }), 0.55, "0 当成没填,回落中性");
  assert.equal(internals.refStrength01({ task: "qwen", refStrength: 200 }), 0.95, "上限夹到 0.95");
  assert.equal(internals.refStrength01({ task: "qwen", refStrength: 1 }), 0.05, "下限夹到 0.05");
}

/* 4) 出厂卡:三张都要在,名字与任务对得上,而且每个任务的出厂卡参数都合法。 */
{
  const factory = app.defaults.models;
  assert.equal(factory.length, 3);
  assert.deepEqual(factory.map((item) => item.task), ["quick", "upscale", "qwen"]);
  factory.forEach((item) => {
    assert.ok(TASKS.indexOf(item.task) >= 0, `出厂卡的 task 必须在册:${item.task}`);
    assert.equal(item.protocol, "cvp");
    assert.equal(internals.cvpSize(item), item.size, `出厂卡的画幅要是本任务合法档位:${item.name} ${item.size}`);
    assert.ok(item.timeoutMs >= app.defaults.limits.timeoutMs[0]);
    assert.ok(item.steps >= app.defaults.limits.steps[0] && item.steps <= app.defaults.limits.steps[1]);
  });
}

/* 5) schema 2 → 3:老配置里只有两张卡,升上来要补回 Qwen 卡;用户自己加的卡不动。 */
{
  const stored = { schema: 2, activeModelId: "mine",
    models: [{ id: "mine", name: "我的卡", protocol: "cvp", task: "upscale", size: 1024 },
      { id: "cvp-quick", name: "快速生图", protocol: "cvp", task: "quick", size: 512 }] };
  const migrated = store.shapeConfig(stored);
  const ids = migrated.models.map((item) => item.id);
  assert.deepEqual(ids.slice().sort(), ["cvp-qwen", "cvp-quick", "cvp-render", "mine"].sort(),
    "缺的出厂卡要补回来,已有的不动");
  assert.equal(migrated.activeModelId, "mine", "用户选中的卡不能被换掉");
  assert.equal(migrated.schema, app.defaults.schema);
  assert.equal(migrated.models.filter((item) => item.id === "mine")[0].name, "我的卡", "用户改过的名字不能被覆盖");

  /* 已经补齐的配置再走一遍不应该重复添加 */
  const again = store.shapeConfig(migrated);
  assert.equal(again.models.length, 4);
}

/* 6) 新建卡的接口:三档任务各自给一份能直接用的参数;非 CVP 协议只有快速/渲染。 */
{
  const qwen = providers.preset("cvp", "qwen");
  assert.equal(qwen.task, "qwen");
  assert.equal(qwen.size, 1024);
  assert.equal(qwen.steps, app.defaults.cvpTasks.qwen.steps);
  assert.equal(qwen.refStrength, 100);
  assert.ok(qwen.timeoutMs >= app.defaults.cvpTasks.qwen.timeoutMs, "Qwen 单张几十秒,超时不能按快速的 60 秒给");
  assert.equal(internals.cvpSize(qwen), qwen.size, "出厂参数本身就要是合法画幅");

  assert.equal(providers.preset("cvp", "quick").size, 512);
  assert.equal(providers.preset("cvp", "upscale").size, 1024);
  /* 从 Qwen 卡切到别的接口,不能把 qwen 那套参数跟着带过去 */
  const sd = providers.preset("sd-webui", "qwen");
  assert.equal(sd.task, "quick");
  assert.equal(sd.size, 512);
  assert.equal(internals.taskName("qwen"), app.i18n.text("Qwen 图像 2.1", "Qwen Image 2.1"));
}

console.log("providers.test.mjs: ok");
