/* 模型卡、出厂参数与配置迁移
 *
 * 这里锁的都是"静默发错请求 / 老装机上的卡失效"型的问题:不报错、界面也正常,
 * 只是发出去的场景名、画幅或参考强度是另一张卡的参数。
 *
 * 这一轮(CHP 2 插件 3.0.0 + 宽高比锁 9:16,用户 2026-09-30 定)有三处结构性变化,
 * 每一处漏改都会静默出错:
 *   1. **画幅从"一个正方边长 `size`"换成"一条 `resolution: "WxH"` 字符串"** ——
 *      宽高比锁死之后,"边长"说不清是宽还是高(576×1024 与 1080×1920 都是 9:16);
 *   2. **CHP 的画幅由插件的帧表说了算**,本应用只挑表里标着 `9:16` 的那一档 ——
 *      出厂表只填插件当前**确实**公布了的档(只有 render 有 9:16,fast/upscale 没有);
 *   3. **出厂激活卡从"快速生图"换成"高质量生图"** —— 插件只会为 render 出 9:16 的图,
 *      停在另外两张上是一按生图就报错,而用户不知道该换哪张。
 * 加上上一批遗留的**改名迁移**:插件的场景词从 `quick` / `qwen` 变成 `fast` / `render`,
 * 而 `chp/2` 取消了别名 —— 旧名字发过去不是"另一个叫法",是 `unsupported_category`。
 *
 * 断言分两层:任务名与画幅映射本身(shapeModel / chpResolution),以及
 * "配置里那个 schema 记号"驱动的出厂卡迁移。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = globalThis.window || {};
for (const file of ["app/core/namespace.js", "app/core/i18n.js", "app/core/utils.js",
  "app/services/providers.js", "app/services/render-adjust.js", "app/services/store.js"]) {
  new Function(fs.readFileSync(path.join(root, file), "utf8"))();
}

const app = globalThis.window.posegi;
const providers = app.services.providers;
const internals = providers.internals;
const store = app.services.store;

const TASKS = Object.keys(app.defaults.chpTasks);
assert.deepEqual(TASKS, ["fast", "upscale", "render"],
  "任务表就是插件的三个场景词 —— 多的那一档 `inpaint` 本应用没有卡,不在这里");
assert.ok(TASKS.indexOf("quick") < 0 && TASKS.indexOf("qwen") < 0,
  "`quick` 与 `qwen` 是 chp/1 的词,chp/2 里它们不再存在");

/* 1) 场景白名单就是 chpTasks 的键;**旧词在读数时一次性迁移掉**。
      没测过连接时按出厂表发,而"不认识的词一律退回 fast"这条不能省 ——
      写成"是不是 upscale"的话,第三种场景加进来时会被悄悄降级(卡上写着高质量生图、
      发出去的却是快速绘制)。 */
{
  assert.equal(internals.chpTask({ task: "fast" }), "fast");
  assert.equal(internals.chpTask({ task: "upscale" }), "upscale");
  assert.equal(internals.chpTask({ task: "render" }), "render");
  assert.equal(internals.chpTask({ task: "wipe" }), "fast", "不认识的词退回 fast");
  assert.equal(internals.chpTask({}), "fast");

  /* 迁移发生在 store.shapeModel(换句话说:卡一进配置就被收口,providers 不许再见旧词) */
  assert.equal(store.shapeConfig({ schema: 4, models: [{ id: "a", task: "qwen" }] }).models[0].task,
    "render", "qwen 是旧词,要迁到 render");
  assert.equal(store.shapeConfig({ schema: 4, models: [{ id: "a", task: "quick" }] }).models[0].task,
    "fast", "quick 是旧词,要迁到 fast");
  assert.equal(store.shapeConfig({ schema: 4, models: [{ id: "a", task: "nope" }] }).models[0].task,
    "fast", "认不出来的退回 fast");
  assert.equal(internals.chpTask({ task: "qwen" }), "fast",
    "providers 这一层不再认旧词 —— 迁移是单向的,不在这儿留一张兼容表");
}

/* 1b) 协议名由 CVP 更名成 CHP(`cvp/1` → `chp/2`,根 `/cvp` → `/chp`)。改名前的装机盘上
       写的是 "cvp",它落在白名单外,于是回落到 "chp" —— 也就是**同一个协议**。
       这就是"改个名字不该让老用户的卡失效"的技术含义:回落点必须是它自己。 */
{
  const stored = store.shapeConfig({ schema: 4, models: [
    { id: "old", name: "改名前的卡", protocol: "cvp", task: "qwen", size: 1024 },
    { id: "new", name: "改名后的卡", protocol: "chp", task: "fast", size: 512 }
  ] });
  const old = stored.models.filter((item) => item.id === "old")[0];
  assert.equal(old.protocol, "chp", "改名前的卡要落回 CHP,不能被换成别的协议或丢掉");
  assert.equal(old.task, "render", "顺带把旧场景词也迁掉");
  assert.equal(stored.models.length, 2, "不该凭空多出或少了卡");
}

/* 2) 画幅:**宽高比锁死**(唯一出处 app.defaults.ratio),所以能表达的只剩分辨率。
      四条要一起成立:比例对不对、在不在清单里、chp 卡上真值归谁、界面显示的是哪一条。 */
{
  assert.equal(app.defaults.ratio, "9:16", "比例锁死 9:16,而且只有一个出处");
  assert.ok(!("size" in app.defaults.limits), "`size` 那条区间已经随正方画幅一起删了");

  /* 比例判据**必须留宽松的余量**(2026-09-30 用户定:像素容错放到 5%)。
     整数边长里精确的 9:16 只有 576x1024 / 1080x1920 那几个,而各家最常用的竖幅档
     没一个是精确值:768x1344 偏 1.587%,是本应用清单里偏得最远的一条 ——
     容差写成 1.5% 时**本应用会拒掉自己清单里的一档**(测试当场抓出来的)。
     再放宽到 5%,是因为各家的"竖幅"本来就是各自估的(480x854、640x1136、800x1422
     偏得都不大,但谁也不保证在 2% 以内),卡太紧只会让用户在某个平台上莫名选不了
     它自己那张竖幅。 */
  ["576x1024", "1080x1920", "768x1344", "1024x1820", "512x912", "480x854", "640x1136"].forEach((value) => {
    assert.equal(internals.ratioMatches(value), true, `${value} 是竖幅,要放行`);
  });
  /* 另一头的边界要卡死:5% 的可接受区间是宽高比 0.5344–0.5906。
     540x1000(0.540,偏 4.0%)在里头、576x960(0.600,偏 6.7%)在门外 ——
     这一对是判"余量到底多大"的标尺,换容差必有一条要红。 */
  assert.equal(internals.ratioMatches("540x1000"), true, "偏 4.0% 仍在 5% 的余量内");
  assert.equal(internals.ratioMatches("576x960"), false, "3:5 偏 6.7%,越界");
  ["512x512", "1024x1024", "1024x1536", "832x1216", "896x1152", "1536x640", "1152x832",
    "768x1344x", "1600x1200", "", "1024"].forEach((value) => {
    assert.equal(internals.ratioMatches(value), false, `${value} 不是 ${app.defaults.ratio},要拦住`);
  });

  /* 别的协议的分辨率:清单成员校验,表外一律回落清单第一条(用户填不进一个清单外的值) */
  const list = app.defaults.resolutions;
  assert.ok(list.length >= 4, "非 CHP 接口的 9:16 档不该只剩一条");
  list.forEach((value) => assert.equal(internals.ratioMatches(value), true, `清单里的 ${value} 必须是竖幅`));
  assert.equal(internals.resolution({ resolution: "576x1024" }), "576x1024", "在清单里就原样用");
  assert.equal(internals.resolution({ resolution: "640x1140" }), list[0],
    "比例对但不在清单里 ⇒ 回落第一条,不留一条谁也说不清出处的值");
  assert.equal(internals.resolution({}), list[0], "没填就是第一条");
  assert.equal(internals.pairOf("768x1344").join("/"), "768/1344", "WxH 的解析只有一处");

  /* CHP 卡:没读过插件文档时用出厂表,而**出厂表只填插件确实公布了的档**
     (fast/upscale 上那是空串,见 namespace 的注释)。 */
  assert.equal(internals.chpResolution({ task: "render" }), "768x1344",
    "render 是插件唯一公布 9:16 的场景,出厂值就是它的那一档");
  assert.equal(internals.chpResolution({ task: "fast" }), "",
    "fast 在插件上没有 9:16 档 ⇒ 空串,由界面/生成链路当面说清,而不是编一个必 400 的值");
  assert.equal(internals.chpResolution({ task: "upscale" }), "");
  assert.deepEqual(internals.chpResolutions("render"), [], "没读过文档时没有帧表可挑");

  /* 界面显示的那个字面量:CHP 卡取"真正会发出去"的,别的协议取卡里存的那条 */
  assert.equal(providers.resolutionText({ protocol: "chp", task: "render", resolution: "nope" }), "768x1344",
    "CHP 卡显示的是会发出去的那条,不是卡里存的");
  assert.equal(providers.resolutionText({ protocol: "sd-webui", resolution: "768x1344" }), "768x1344",
    "别的协议它才是用户挑的那条");
}

/* 2b) 校验:**成员校验**而不是区间。比例锁死之后"在 512–1024 之间"这种话说不清是宽还是高,
       真正会出错的是"这个接口不接受这条分辨率"。CHP **不在这里判** —— 它的画幅是
       插件帧表里的成员,选的动作在 chpResolution 里,这里再抄一份就成了第二份规则。 */
{
  const sd = providers.preset("sd-webui", "fast");
  sd.endpoint = "http://192.168.1.2:7860";
  providers.validate(sd);
  ["512x512", "1024x1536", "1600x1200"].forEach((value) => {
    sd.resolution = value;
    assert.throws(() => providers.validate(sd), new RegExp(app.defaults.ratio),
      `${value} 不是竖幅,要在发请求之前拦住`);
  });
  sd.resolution = "640x1140";
  assert.throws(() => providers.validate(sd), /清单/, "比例对但不在清单里,同样要拦");
  sd.resolution = "576x1024";
  providers.validate(sd);

  const chp = providers.preset("chp", "fast");
  chp.resolution = "";
  providers.validate(chp);
  chp.resolution = "512x512";
  providers.validate(chp);
}

/* 3) 参考图强度:卡上是 0–200(100 中性),插件要的是 0.05–0.95。
      没读过插件时按出厂基准;每个场景有自己的基准(readme 里那张表)。 */
{
  assert.equal(internals.refStrength01({ task: "fast", refStrength: 100 }), 0.55);
  assert.equal(internals.refStrength01({ task: "upscale", refStrength: 100 }), 0.75);
  assert.equal(internals.refStrength01({ task: "render", refStrength: 100 }), 0.95);
  assert.ok(internals.refStrength01({ task: "render", refStrength: 50 }) < 0.95, "调低要真的更低");
  assert.equal(internals.refStrength01({ task: "fast", refStrength: 0 }), 0.55, "0 当成没填,回落中性");
  assert.equal(internals.refStrength01({ task: "render", refStrength: 200 }), 0.95, "上限夹到 0.95");
  assert.equal(internals.refStrength01({ task: "render", refStrength: 1 }), 0.05, "下限夹到 0.05");
}

/* 4) 出厂卡:三张都要在,名字与场景对得上,参数都合法。
      `growMaskBy`(描边外扩)整条已删 —— 它是 chp/1 的字段,chp/2 的顶层不认它。 */
{
  const factory = app.defaults.models;
  assert.equal(factory.length, 3);
  assert.deepEqual(factory.map((item) => item.task), ["fast", "upscale", "render"]);
  assert.deepEqual(factory.map((item) => item.name), ["快速生图", "图像放大", "高质量生图"]);
  factory.forEach((item) => {
    assert.ok(TASKS.indexOf(item.task) >= 0, `出厂卡的 task 必须在册:${item.task}`);
    assert.equal(item.protocol, "chp");
    assert.ok(!("growMaskBy" in item), "growMaskBy 是 chp/1 的字段,已删");
    assert.ok(!("size" in item), "`size` 是正方画幅的字段,已换成 resolution");
    assert.equal(item.resolution, app.defaults.chpTasks[item.task].resolution,
      `出厂卡的画幅要是本场景的出厂档:${item.name}`);
    assert.equal(item.steps, app.defaults.chpTasks[item.task].steps, "步数收归出厂表(插件按自己的枚举判)");
    assert.ok(item.timeoutMs >= app.defaults.limits.timeoutMs[0]);
  });
  /* 只有 render 那份不是空的 —— 这是"锁 9:16 之后这台插件上只有 render 出得了图"
     的直接后果,不是笔误。 */
  assert.deepEqual(factory.map((item) => item.resolution), ["", "", "768x1344"]);
  assert.equal(app.defaults.activeModelId, "chp-qwen",
    "出厂激活的是公布 9:16 的那张;停在别的卡上是一按生图就报错");
  assert.equal(factory.filter((item) => item.id === app.defaults.activeModelId)[0].task, "render");
}

/* 4b) 卡上的 `steps` 在 CHP 卡上不是用户可选项:老装机上被滑杆调过的数字要在读数时
       收回来,否则它会一直发一个服务端不认的步数(插件按枚举判,越界报 unsupported_steps)。
       `resolution` 的迁移同理但方向不同:CHP 卡由插件说了算,存着一条 WxH 就留着,
       否则留空;别的协议把旧的**正方边长当宽度用**,在 9:16 清单里挑最接近的一条。 */
{
  const shaped = store.shapeConfig({ schema: 4, models: [
    { id: "a", protocol: "chp", task: "render", size: 640, steps: 37 },
    { id: "b", protocol: "sd-webui", task: "upscale", size: 640, steps: 37 }
  ] }).models;
  assert.equal(shaped[0].steps, app.defaults.chpTasks.render.steps, "CHP 卡的步数收归出厂表");
  assert.equal(shaped[0].resolution, "", "CHP 卡上没有 WxH 就留空,由插件的帧表说了算");
  assert.equal(shaped[1].steps, 37, "别的协议的步数是用户自己填的,不许动");
  assert.equal(shaped[1].resolution, "576x1024",
    "旧的 640 当宽度用,9:16 清单里最接近的是 576x1024(差 64;720x1280 差 80)");
  assert.equal(shaped[1].size, undefined, "`size` 不再出现在收口后的卡上");

  /* 老卡上如果已经存了一条 WxH,原样留着(那是"上次挑的那条",插件改表也轮不到本地改) */
  assert.equal(store.shapeConfig({ schema: 4, models: [
    { id: "c", protocol: "chp", task: "render", resolution: "1080x1920" }] }).models[0].resolution,
  "1080x1920");
}

/* 5) schema 2 → 3:老配置里只有两张卡,升上来要补回第三张;用户自己加的卡不动。 */
{
  const stored = { schema: 2, activeModelId: "mine",
    models: [{ id: "mine", name: "我的卡", protocol: "chp", task: "upscale", size: 1024 },
      { id: "chp-quick", name: "快速生图", protocol: "chp", task: "quick", size: 512 }] };
  const migrated = store.shapeConfig(stored);
  const ids = migrated.models.map((item) => item.id);
  assert.deepEqual(ids.slice().sort(), ["chp-quick", "chp-qwen", "chp-render", "mine"].sort(),
    "缺的出厂卡要补回来,已有的不动");
  assert.equal(migrated.activeModelId, "mine", "用户选中的卡不能被换掉");
  assert.equal(migrated.schema, app.defaults.schema);
  assert.equal(migrated.models.filter((item) => item.id === "mine")[0].name, "我的卡", "用户改过的名字不能被覆盖");

  /* 已经补齐的配置再走一遍不应该重复添加 */
  const again = store.shapeConfig(migrated);
  assert.equal(again.models.length, 4);
}

/* 5b) schema 4 → 5:出厂卡的名字跟着场景改名走。
       `render` 那张卡的新名字是"高质量生图"(插件给这个场景定的名字也是它);旧名
       "Qwen 图像 2.1"点的是**模型族**而不是这个场景 —— 插件换了模型,那个名字就对不上了。
       只改**还叫旧出厂名**的卡:用户自己改过名字的一个字都不动。 */
{
  const renamed = store.shapeConfig({ schema: 4, models: [
    { id: "chp-qwen", name: "Qwen 图像 2.1", protocol: "chp", task: "qwen", size: 1024 },
    { id: "mine", name: "Qwen 图像 2.1（我改过的）", protocol: "chp", task: "qwen", size: 1024 }
  ] });
  assert.equal(renamed.models[0].name, "高质量生图", "出厂名要跟着场景改名走");
  assert.equal(renamed.models[0].task, "render", "场景名与卡名一起换");
  assert.equal(renamed.models[1].name, "Qwen 图像 2.1（我改过的）", "用户改过的名字不许覆盖");

  /* schema 已经是 5 就不再动名字 —— 否则用户把卡改回旧名也会被反复覆盖 */
  const kept = store.shapeConfig({ schema: 5, models: [
    { id: "x", name: "Qwen 图像 2.1", protocol: "chp", task: "render", size: 1024 }
  ] });
  assert.equal(kept.models[0].name, "Qwen 图像 2.1", "迁移只跑那一次");
}

/* 5c) schema 5 → 6:出厂激活卡从"快速生图"挪到"高质量生图"。
       老装机停在 `chp-quick` / `chp-render` 上时,那两张卡锁 9:16 之后**发不出请求**,
       继续当激活卡只会让人一按生图就报错,而他自己并不知道该换哪张。
       只认这两个出厂 id:用户自己加过卡、或停在别的卡上,一个都不动。 */
{
  const card = (id, task) => ({ id, protocol: "chp", task });
  const moved = store.shapeConfig({ schema: 5, activeModelId: "chp-quick",
    models: [card("chp-quick", "fast"), card("chp-render", "upscale"), card("chp-qwen", "render")] });
  assert.equal(moved.activeModelId, "chp-qwen", "停在没 9:16 的出厂卡上要挪到公布 9:16 的那张");

  const kept = store.shapeConfig({ schema: 5, activeModelId: "mine",
    models: [card("mine", "fast"), card("chp-quick", "fast"), card("chp-qwen", "render")] });
  assert.equal(kept.activeModelId, "mine", "用户自己选的卡不许被改");

  const already = store.shapeConfig({ schema: 6, activeModelId: "chp-quick",
    models: [card("chp-quick", "fast"), card("chp-qwen", "render")] });
  assert.equal(already.activeModelId, "chp-quick", "schema 已经是 6 就不再迁移(否则用户切回去也会被掰回来)");

  /* 出厂卡被删过:没有 chp-qwen 可挪时保持原样,不能把 activeModelId 指到一个不存在的 id */
  const missing = store.shapeConfig({ schema: 5, activeModelId: "chp-quick",
    models: [card("chp-quick", "fast")] });
  assert.equal(missing.activeModelId, "chp-quick");
}

/* 6) 新建卡的接口:三档场景各自给一份能直接用的参数;非 CHP 协议只有快速/放大两种语义。 */
{
  const render = providers.preset("chp", "render");
  assert.equal(render.task, "render");
  assert.equal(render.resolution, "768x1344", "CHP 卡带的出厂值就是插件公布的那一档");
  assert.equal(render.steps, app.defaults.chpTasks.render.steps);
  assert.equal(render.refStrength, 100);
  assert.ok(render.timeoutMs >= app.defaults.chpTasks.render.timeoutMs,
    "高质量生图单张几十秒,超时不能按快速的 60 秒给");

  assert.equal(providers.preset("chp", "fast").resolution, "", "fast 在插件上没有 9:16 档");
  assert.equal(providers.preset("chp", "upscale").resolution, "");

  /* 从高质量生图那张卡切到别的接口,不能把 render 那套参数跟着带过去;
     画幅一律来自非 CHP 那份 9:16 清单:轻的给第二档(正好 9:16),重的给末档。 */
  const list = app.defaults.resolutions;
  const sd = providers.preset("sd-webui", "render");
  assert.equal(sd.task, "fast");
  assert.equal(sd.resolution, list[1]);
  assert.equal(sd.quality, "low");
  assert.equal(providers.preset("sd-webui", "upscale").resolution, list[list.length - 1],
    "放大那一路给清单里最大的一档");
  assert.equal(providers.preset("openai-images", "fast").resolution, list[1]);

  /* 卡名走同一张表 */
  assert.equal(internals.taskName("fast"), app.i18n.text("快速生图", "Quick draw"));
  assert.equal(internals.taskName("upscale"), app.i18n.text("图像放大", "Upscale"));
  assert.equal(internals.taskName("render"), app.i18n.text("高质量生图", "High-quality render"));
  assert.equal(internals.taskName("wipe"), app.i18n.text("快速生图", "Quick draw"), "不认识的词给 quick 的画法名");
}

/* 7) 出口:`internals` 不该再留着"正方边长"那一套名字,也不该少了新的那几个。
       这条是"删干净"的守门员 —— 少删一个,别处就还能拼出一条旧请求。 */
{
  ["chpEntry", "chpEntryModel", "chpRefBase", "chpDomain", "fitDomain", "chpCapabilityName",
    "chpSquares", "chpSize", "chpSizeText"].forEach((name) => {
    assert.ok(!(name in internals), `internals 里不该再有 ${name}`);
  });
  ["chpUrl", "chpTask", "chpResolution", "chpResolutions", "resolution", "pairOf",
    "ratioMatches", "refStrength01", "taskName"].forEach((name) => {
    assert.ok(name in internals, `internals 里应该有 ${name}`);
  });
  assert.equal(typeof providers.resolutionText, "function");
}

console.log("providers.test.mjs: ok (场景词白名单与旧词迁移、9:16 比例与清单成员校验、"
  + "出厂画幅与基准、出厂卡表与激活卡、schema 2→3 / 4→5 / 5→6 三次迁移、"
  + "新建卡接口、旧入口删干净)");
