/* 作品文档:一件作品除了标题 / 描述 / 成图之外,还带走"它长什么样"
 *
 * 2026-09-30 用户要求:「人偶的姿势和摄像机数据要随作品一起保存!!每次打开旧作品都要
 * 恢复人偶的姿势和视口角度!请帮我设计好作品文档的数据格式,确保再次打开后相关设置
 * 都能得到恢复,比如提示词、翻译等等,模型也要保存」、「新建作品,建好并打开,
 * 要把当前人偶恢复开始的初始姿势」。
 *
 * 于是作品记录升到 schema 2,多四个字段:
 *   pose    姿态(app.rig.serialize 那一份:关节角度表 + 预设名)
 *   view    视口({ azimuth, elevation, distance, targetY })
 *   modelId 生图用哪张模型卡
 *   figure  人偶造型 id
 * 四个都**由别的模块持有**,所以 store 只做两件事:存的时候问 documentSource 要,
 * 装的时候发 work:loaded 让装配层分发给 poser / viewport / providers / figure。
 *
 * 这组测试把整条链走完:**屏幕状态(live) → 记录 → 装配层收到的状态**。
 * 只断言"记录里有 pose 字段"是不够的 —— 中间任何一段断掉(取数口没接、事件没发、
 * 装配层顺序错了),那种断言照样绿,而用户看到的是"打开旧作品姿势没回来"。
 *
 * 另外锁三条最容易静默坏掉的规矩:
 *   1. **姿态是按作品分开存的**:存乙不能把甲的姿势覆盖掉(否则"打开旧作品恢复姿势"
 *      这句话根本不成立,而界面上一切正常);
 *   2. **改标题不该把人偶摆回出厂姿势** —— 那条路也会走 applyToState,
 *      所以 work:loaded 只在"整份文档换了"时发(见 store.applyToState 的注释);
 *   3. **换作品前先把当前这件存好**:切走的那一刻用户摆到一半的姿势不能丢。
 *
 * 加载顺序:namespace.js 会把 app.platform 重置成空对象,而 providers / translate /
 * store 在加载时就会把 haminn 抓成局部变量 —— 所以替身必须夹在这两者之间。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = globalThis.window || {};
new Function(fs.readFileSync(path.join(root, "app/core/namespace.js"), "utf8"))();

/* ---------- 宿主替身:数据区在内存里,不该发网络请求 ---------- */
const mem = new Map();
globalThis.window.posegi.platform = { haminn: {
  getData: async (collection, key) => {
    const name = collection + "/" + key;
    return mem.has(name) ? { collection, key, value: JSON.parse(JSON.stringify(mem.get(name))) } : null;
  },
  putData: async (collection, key, value) => {
    const stored = JSON.parse(JSON.stringify(value));
    mem.set(collection + "/" + key, stored);
    return { collection, key, value: stored };
  },
  deleteData: async (collection, key) => { mem.delete(collection + "/" + key); return { deleted: true }; },
  request: async () => { throw new Error("这组测试不该发网络请求"); }
} };

for (const file of ["app/core/utils.js", "app/core/i18n.js",
  "app/core/runtime.js", "app/core/models.js", "app/assets/models/ikea.js", "app/core/rig.js",
  "app/services/providers.js", "app/services/translate.js", "app/services/assets.js",
  "app/services/render-adjust.js", "app/services/store.js"]) {
  new Function(fs.readFileSync(path.join(root, file), "utf8"))();
}

const app = globalThis.window.posegi;
const rig = app.rig;
const store = app.services.store;

rig.applyModel(app.models.get("ikea"));

/* ---------- 三个替身 ----------
 * live  = "屏幕上现在是什么样"(poser 的姿态 + viewport 的视口 + 选中的模型卡 + 造型);
 * source= 交给 store 的取数口(app.js 的 wireWorkDocument 就是它);
 * 监听  = 装配层(真机上是 app.js 的 applyDocument:figure → poser → viewport → 模型卡)。
 * 三个替身都只是把同一份数据搬来搬去,搬错任何一处都会在这组断言里露出来。 */

const FACTORY_VIEW = { azimuth: 0.19, elevation: 0.12, distance: 2.8, targetY: 0.94 };
const FACTORY_POSE = rig.serialize({ name: "stand", angles: rig.defaultAngles() });
/* 出厂站姿里"左手 x"是几?**不是 0** —— 那是模型 rest 归一化之后的值(ikea 上是个小数)。
   断言"回到出厂"一律拿它比,不写死数字,否则换个模型这组测试就假红。 */
const FACTORY_HAND_X = FACTORY_POSE.angles["hand.L"].x;

function poseOf(handX, name) {
  const angles = rig.defaultAngles();
  angles["hand.L"].x = handX;
  return rig.serialize({ name: name || "custom", angles });
}
const VIEW_A = { azimuth: 0.19, elevation: 0.12, distance: 2.8, targetY: 0.94 };
const VIEW_B = { azimuth: -1.05, elevation: -0.3, distance: 3.4, targetY: 1.1 };
const VIEW_C = { azimuth: 2.2, elevation: 0.4, distance: 2.1, targetY: 0.8 };
/* 成图调色那一份(schema 3)。**不是**全中性 —— 全中性的那一份存进去是 null,
   拿它当"有调色"的证据会永远绿(见 renderAdjust.stored)。 */
const RENDER_A = { brightness: 120, contrast: 95, saturation: 140, hue: -20, glow: 30, clarity: 15, enabled: true };
/* 第二套,用来证明"调色是按作品分开的"(和姿态一个道理) */
const RENDER_B = { brightness: 80, contrast: 130, saturation: 60, hue: 40, glow: 0, clarity: 0, enabled: true };
const NEUTRAL = app.services.renderAdjust.normalize(null);

let live = { pose: poseOf(20), view: VIEW_A, modelId: "chp-qwen", figure: "ikea", render: RENDER_A };
/* 每件作品**在屏幕上**被摆成什么样 */
const onScreen = new Map();
/* 每次 work:loaded 的载荷,给断言看事件本身发了什么 */
const loaded = [];

store.attachDocument(() => {
  /* 取数口照抄 app.js:对象要**新建**一份 —— 直接把 live 交出去的话,
     记录与屏幕共用同一个引用,视口每帧都在改它。
     调色那一份交出去的是**活的完整对象**(与 renderPreview.adjustments() 一样),
     "没有调色就存 null"是 store 那边 shapeRender 的事,取数口不管这件事。 */
  return {
    pose: app.utils.copy(live.pose),
    view: app.utils.copy(live.view),
    modelId: live.modelId,
    figure: live.figure,
    render: app.utils.copy(live.render)
  };
});

app.events.on("work:loaded", (detail) => {
  loaded.push(detail);
  const doc = detail.document || {};
  /* 装配层:文档里给什么就用什么,五个都空就是**回出厂**(用户要的那条)。
     调色"回出厂"= 回中性(全屏看图手上永远是一份完整参数,不会是 null)。 */
  live = {
    pose: doc.pose || FACTORY_POSE,
    view: doc.view || FACTORY_VIEW,
    modelId: doc.modelId || "",
    figure: doc.figure || "ikea",
    render: app.services.renderAdjust.normalize(doc.render)
  };
  if (detail.id) onScreen.set(detail.id, live);
});

function recordOf(title) {
  const item = store.listWorks().filter((entry) => entry.title === title)[0];
  return item ? mem.get("work/" + item.id) : null;
}
function idOf(title) {
  const item = store.listWorks().filter((entry) => entry.title === title)[0];
  return item ? item.id : "";
}
/* "用户在屏幕上把这一件摆成这样" —— 摆完等防抖到点(这里直接 flush) */
async function poseAndSave(pose, view, modelId, render) {
  live = { pose: pose, view: view, modelId: modelId, figure: "ikea", render: render === undefined ? NEUTRAL : render };
  await store.flush();
}

await store.loadConfig();
assert.equal(typeof store.attachDocument, "function",
  "attachDocument 要导出去 —— 装配层靠它把取数口交进来");

/* 1) 新建作品 = **一份空文档**(四个字段都不给)。
      装配层收到空文档就回出厂站姿与出厂取景 —— 用户要的"新建作品恢复初始姿势"就是
      这条路;而紧接着的那次保存,写下去的是**刚复位的那一份**(不是上一件作品的)。 */
{
  loaded.length = 0;
  await store.newWork("甲");
  const record = recordOf("甲");

  assert.equal(record.schema, 4, "作品文档升到 schema 4(多了待取回的作业 pending)");
  assert.equal(record.pending, null, "新作品没有待取回的作业 ⇒ 存 null");
  assert.equal(loaded.length, 1, "换整份文档要发一次 work:loaded");
  assert.deepEqual(loaded[0].document, { pose: null, view: null, modelId: "", figure: "", render: null },
    "新作品发出去的就是五个空位 —— 装配层看到空位才回出厂");
  assert.equal(app.state.document.pose, null, "运行时状态里的那一份也是空的");

  /* 装配层把 live 复位了,于是落盘的是出厂那一份 */
  assert.deepEqual(record.pose, FACTORY_POSE, "新建之后存下去的是出厂站姿");
  assert.notEqual(record.pose.angles["hand.L"].x, 20, "存下去的**不是**上一件作品那个姿势");
  assert.deepEqual(record.view, FACTORY_VIEW, "视口也回出厂");
  assert.equal(record.figure, "ikea", "造型回出厂那一个");
  assert.equal(record.modelId, "", "新作品不指定模型卡(用配置里当前激活的那张)");
  /* 调色回出厂 = **不存**:一份全中性的调色不表达任何东西,存下去只会让每件作品
     都揣着一个七字段的废物。所以"新建作品的记录里没有 render"正是对的。 */
  assert.equal(record.render, null, "新作品没有调色 ⇒ 记录里不写 render(不是写一份全中性的)");
}

/* 2) 存:摆好姿势、调好色之后存下去,五个字段都要落进记录,而且是**拷贝**。 */
{
  await store.newWork("乙");
  await poseAndSave(poseOf(35), VIEW_A, "chp-qwen", RENDER_A);
  const record = recordOf("乙");

  assert.equal(record.pose.angles["hand.L"].x, 35, "姿态要落进记录");
  assert.equal(record.pose.name, "custom", "姿态里的预设名也要留着");
  assert.deepEqual(record.view, VIEW_A, "视口的四个通道要原样落进去");
  assert.equal(record.modelId, "chp-qwen", "模型卡 id 要留着");
  assert.equal(record.figure, "ikea", "造型 id 要留着");
  assert.deepEqual(record.render, RENDER_A, "六个调色参数与那个开关要原样落进记录");
  assert.notEqual(record.pose, live.pose, "存下去的必须是拷贝,不能是屏幕上那个对象");
  assert.notEqual(record.render, live.render, "调色那一份也得是拷贝");
}

/* 3) **姿态与调色都按作品分开**:存第二件,第一件那份一个字都不许动。
      做不到的话所有作品共用一份姿势(或共用一套调色),界面上完全看不出来
      (每次打开都"恢复"成了最后那一次的样子)。 */
{
  await store.newWork("丙");
  await poseAndSave(poseOf(-15), VIEW_B, "chp-quick", RENDER_B);

  assert.equal(recordOf("丙").pose.angles["hand.L"].x, -15);
  assert.deepEqual(recordOf("丙").render, RENDER_B);
  assert.equal(recordOf("乙").pose.angles["hand.L"].x, 35, "存丙不该动到乙的姿态");
  assert.equal(recordOf("乙").modelId, "chp-qwen", "模型卡也不该被带着改");
  assert.deepEqual(recordOf("乙").render, RENDER_A, "乙那套调色也不许被丙覆盖掉");
  assert.equal(recordOf("甲").pose.angles["hand.L"].x, FACTORY_HAND_X, "甲那份是出厂站姿,照旧不动");
  assert.notEqual(recordOf("甲").pose.angles["hand.L"].x, 35, "更不许被乙/丙的姿势串改");
  assert.equal(recordOf("甲").render, null, "甲从来没调过色,record.render 一直是 null");
}

/* 4) **换作品前先把当前这件存好**,而且装回来的必须是记录里那份。
      当前站在乙上,把姿势摆到一半(70)就点开丙 —— 那一下不能丢,
      同时屏幕上要换成**丙自己**那份(-15 / VIEW_B / chp-quick)。 */
{
  const second = idOf("乙");
  const third = idOf("丙");

  await store.openWork(second);                          /* 先站到乙上 */
  await poseAndSave(poseOf(70), VIEW_C, "chp-render", RENDER_A);   /* 在乙上把姿势摆到一半 */
  assert.equal(recordOf("乙").pose.angles["hand.L"].x, 70, "摆完就存(防抖到点)");

  loaded.length = 0;
  await store.openWork(third);                           /* 摆到一半就点开丙 */

  /* 切走那一下:乙 必须被存成 70,而且视口与模型卡一起走 */
  assert.equal(recordOf("乙").pose.angles["hand.L"].x, 70, "切走之前先把当前这件(乙)存下去");
  assert.equal(recordOf("乙").view.distance, VIEW_C.distance, "视口也要一起存");
  assert.equal(recordOf("乙").modelId, "chp-render", "模型卡跟着这件作品走");
  assert.deepEqual(recordOf("乙").render, RENDER_A, "调色也跟着这件作品走");

  /* 装回来的必须是**丙记录里那份**(-15 / RENDER_B),而不是屏幕上那份(70) */
  assert.equal(app.state.document.pose.angles["hand.L"].x, -15, "装回来的应当是记录里存的那一份");
  assert.deepEqual(app.state.document.view, VIEW_B);
  assert.equal(app.state.document.modelId, "chp-quick");
  assert.deepEqual(app.state.document.render, RENDER_B, "调色也要装回记录里那一套");
  assert.equal(loaded.length, 1, "换整份文档要发一次 work:loaded");
  assert.equal(loaded[0].id, third, "事件里要带上作品 id");
  assert.equal(loaded[0].document.pose.angles["hand.L"].x, -15, "发出去的就是要装回去的那一份");

  /* 出口:装配层收到的屏幕状态 = 记录里那一份(端到端,不只断言中间态) */
  assert.equal(onScreen.get(third).pose.angles["hand.L"].x, -15, "屏幕上要恢复成丙自己的姿势");
  assert.deepEqual(onScreen.get(third).view, VIEW_B, "视口角度要恢复");
  assert.equal(onScreen.get(third).modelId, "chp-quick", "模型卡要恢复");
  assert.deepEqual(onScreen.get(third).render, RENDER_B, "屏幕上那套调色要换成丙自己的");
}

/* 5) **改标题不该把人偶摆回出厂姿势**。
      靶子必须是**当前这件**:只有 target === app.state.workId 那条分支才会走
      applyToState(改别人只是读写记录,根本不碰屏幕)。不加"整份文档"这个开关的话,
      用户每改一次标题,屏幕上刚摆好的姿势就会被复位,而他正看着它。 */
{
  const current = app.state.workId;
  const before = app.utils.copy(live);
  loaded.length = 0;
  await store.updateWork(current, { title: "丙改名" });

  assert.equal(loaded.length, 0, "只改标题不发 work:loaded");
  assert.deepEqual(live, before, "屏幕上的姿势与视角一点都不许动");
  assert.equal(app.state.document.pose.angles["hand.L"].x, -15,
    "运行时状态里的那份文档也不该被动到");
  assert.equal(recordOf("丙改名").pose.angles["hand.L"].x, -15, "记录里的姿态更不该变");
  assert.deepEqual(recordOf("丙改名").view, VIEW_B, "视口也不许被写成空");
  assert.equal(recordOf("丙改名").modelId, "chp-quick", "模型卡也不许被写成空");
  assert.deepEqual(recordOf("丙改名").render, RENDER_B, "调色也不许被写成空");
  assert.equal(app.state.workId, current, "改标题不改 id");
  assert.equal(recordOf("丙改名").title, "丙改名");
}

/* 5b) 改描述也一样 —— 它走的是同一个口子 */
{
  const current = app.state.workId;
  loaded.length = 0;
  await store.updateWork(current, { prompt: "换一句描述" });

  assert.equal(loaded.length, 0, "改描述同样不该触发整份文档装载");
  assert.equal(live.pose.angles["hand.L"].x, -15, "姿势照旧不动");
  assert.equal(app.state.document.pose.angles["hand.L"].x, -15, "文档里那份也不动");
  assert.deepEqual(recordOf("丙改名").view, VIEW_B, "视口要原样留在记录里");
  assert.equal(app.state.prompt, "换一句描述");
}

/* 5c) **待取回的作业跟着作品走**,而且"只改了标题 / 描述"那两条路都不许把它抹掉。
       它是"服务端那张图还能取回来"的唯一凭据(2026-09-30 真机事故后加的,见 store 的
       schema 4):抹掉它不会报任何错,用户看到的是"图没了,也没得取"。
       所以要钉四件事 —— 落盘、改字不动它、换作品跟着走、换回来还在。
       最后一条就是"能扛住 app 重启"那一半:它住在记录里,不在内存里。 */
{
  const current = app.state.workId;
  const JOB = { jobId: "job-abc-123", task: "render", requestId: "r-1", createdAt: 1790000000000 };

  /* (a) 提交成功那一刻记上去 ⇒ 当场落进作品记录 */
  app.state.pendingJob = JOB;
  await store.flush();
  assert.deepEqual(recordOf("丙改名").pending, JOB, "待取回的作业要落进作品记录");

  /* (b) 改标题 / 改描述走的是 applyToState 的另一个分支,都不许顺手清掉它 */
  await store.updateWork(current, { title: "丙再改名" });
  assert.deepEqual(app.state.pendingJob, JOB, "改标题不许把待取的作业抹掉");
  assert.deepEqual(recordOf("丙再改名").pending, JOB, "记录里那份也还在");
  await store.updateWork(current, { prompt: "再换一句" });
  assert.deepEqual(app.state.pendingJob, JOB, "改描述同样不许抹掉它");

  /* (c) 换作品:它跟着换(新那一件自己没有待取的作业) */
  await store.newWork("戊");
  assert.equal(app.state.pendingJob, null, "新作品没有待取的作业");

  /* (d) 换回来:它还在 —— 这一条等价于"杀掉进程再打开,记录里那个 id 还在" */
  await store.openWork(current);
  assert.deepEqual(app.state.pendingJob, JOB, "打开旧作品要把待取的作业装回来");

  /* (e) 清掉 ⇒ 记录里也清掉(取回成功 / 作业失败 / 被取消 三条路都走这个口子) */
  app.state.pendingJob = null;
  await store.flush();
  assert.equal(recordOf("丙再改名").pending, null, "清掉之后记录里不该还留着");
}

/* 6) 删掉当前这件 ⇒ 状态整个清空,装配层回出厂(没有作品就没有"它的姿态"了) */
{
  const current = app.state.workId;
  assert.ok(app.state.document && app.state.document.pose, "删之前它确实有一份文档");

  loaded.length = 0;
  await store.removeWork(current);

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].document, null, "没有作品 ⇒ 文档为空,装配层据此回出厂");
  assert.equal(app.state.document, null);
  assert.equal(live.pose.angles["hand.L"].x, FACTORY_HAND_X, "屏幕上回到出厂站姿");
  assert.deepEqual(live.view, FACTORY_VIEW, "视口也回出厂取景");
  assert.equal(live.modelId, "", "模型卡也清空(没有作品就没有它指定的卡)");
  assert.deepEqual(live.render, NEUTRAL, "调色也回中性(没有作品就没有它的调色)");
}

/* 7) 形状收口:手改坏的 / 半份的记录不能让姿态与视口"装作装上了"。
      视口**四个通道齐了才算一份**(半份装回去会得到"角度是这件作品的、距离是上一件的"
      那种怪视角);姿态没有角度表就不算姿态。 */
{
  const shape = store.shapeDocument;
  assert.deepEqual(shape({}), { pose: null, view: null, modelId: "", figure: "", render: null },
    "什么都没有 ⇒ 五样全空");
  assert.equal(shape({ view: { azimuth: 0, elevation: 0, distance: 2 } }).view, null,
    "缺通道的视口整份丢掉");
  assert.equal(shape({ view: Object.assign({}, VIEW_A, { targetY: "上面一点" }) }).view, null,
    "有通道不是数 ⇒ 整份丢掉,不许拿一半");
  assert.equal(shape({ view: Object.assign({}, VIEW_A, { distance: 0 }) }).view, null,
    "距离为 0 的视口是坏数据");
  assert.equal(shape({ view: Object.assign({}, VIEW_A, { azimuth: null }) }).view, null,
    "null 不是数(NaN 那种'换算过来是 0'的假数尤其不能收)");
  assert.equal(shape({ view: Object.assign({}, VIEW_A, { elevation: "" }) }).view, null,
    "空串不是 0");
  assert.equal(shape({ view: Object.assign({}, VIEW_A, { targetY: true }) }).view, null,
    "布尔不是数");
  assert.equal(shape({ view: Object.assign({}, VIEW_A, { targetY: [1] }) }).view, null,
    "数组不是数");
  assert.deepEqual(shape({ view: VIEW_A }).view, VIEW_A, "四个通道齐全就原样收下");
  /* 反过来也得认:手改过的记录里数值可能写成字符串,那不是坏数据 */
  assert.deepEqual(shape({ view: { azimuth: "0.19", elevation: 0.12, distance: "2.8", targetY: 0.94 } }).view,
    VIEW_A, "数值字符串应当收下,换算成数");

  assert.equal(shape({ pose: { name: "stand" } }).pose, null, "没有角度表就不算一份姿态");
  assert.equal(shape({ pose: { angles: {} } }).pose, null, "空角度表也不算");
  assert.equal(shape({ pose: "stand" }).pose, null, "姿态是一段字符串 ⇒ 丢掉");
  assert.equal(shape({ pose: poseOf(1) }).pose.schema, 1, "姿态那一份带着自己的 schema 记号");
  assert.equal(shape({ pose: poseOf(1) }).pose.angles["hand.L"].x, 1);

  /* 非数值的轴丢掉,剩下的照收 —— 取值范围归 rig(poser.restore 会走 rig.parse),
     所以这里**不许**自己夹一遍,两处规则迟早对不上。 */
  const partial = shape({ pose: { angles: { "hand.L": { x: 12, y: "abc" }, "wipe.L": { x: 1 } } } }).pose;
  assert.deepEqual(partial.angles, { "hand.L": { x: 12 }, "wipe.L": { x: 1 } },
    "非数值的轴丢掉;不认识的关节留着由 rig 去丢");
  assert.equal(shape({ pose: { angles: { "hand.L": { x: null } } } }).pose, null,
    "轴写成 null 不许被当成 0 度收下");
  assert.deepEqual(shape({ pose: { angles: { "hand.L": { x: "-15" } } } }).pose.angles,
    { "hand.L": { x: -15 } }, "轴写成数值字符串照样认");

  /* 调色那一份的收口:**一项看不懂就换那一项,不是整份丢掉** ——
     调色没有"半份会更怪"这回事(某个滑杆坏了就把那一项当中性,别的照旧)。 */
  assert.equal(shape({ render: null }).render, null, "没有调色 ⇒ null");
  assert.equal(shape({ render: "调过的" }).render, null, "调色不是对象 ⇒ null");
  assert.equal(shape({ render: NEUTRAL }).render, null,
    "全中性的那一份也是 null —— 存它只会让每件作品多揣一个废物对象");
  assert.deepEqual(shape({ render: RENDER_A }).render, RENDER_A, "六个参数与开关原样收下");
  assert.deepEqual(shape({ render: { brightness: "120", contrast: 95, saturation: 140, hue: -20, glow: 30, clarity: 15 } }).render,
    RENDER_A, "数值字符串照样认,缺的那个开关补成开");
  const loose = shape({ render: { brightness: null, contrast: 95, saturation: 140, hue: -20, glow: 30, clarity: 15 } }).render;
  assert.equal(loose.brightness, 100, "某一项是 null ⇒ 那一项回中性(不是整份丢掉)");
  assert.equal(loose.contrast, 95, "别的项照旧收下");
  assert.equal(shape({ render: { brightness: 999, saturation: 140 } }).render.brightness, 180,
    "超出行程的收进行程:留着它只会让滑杆夹在自己头尾之间动不了");
  assert.equal(shape({ render: { brightness: 999, saturation: 140 } }).render.saturation, 140);
  assert.equal(shape({ render: { enabled: false } }).render, null,
    "调色开关关掉 = 没有调色(滑杆停在哪都不影响画面)");
  assert.equal(shape({ render: Object.assign({}, RENDER_A, { enabled: false }) }).render.enabled, false,
    "有调色但开关关着的那一份要留着开关(否则用户回到界面时会发现它自己开了)");

  /* 待取回的作业(schema 4)那一份的收口:判据只有一条 —— **jobId 得是个非空字符串**。
     没有它什么都做不了,收下一个没有 id 的对象只会让界面挂出一颗点了没用的按钮。 */
  const pending = store.shapePending;
  assert.equal(pending(null), null, "没有 ⇒ null");
  assert.equal(pending({ task: "render" }), null, "没有 jobId ⇒ 当没有(取不回来)");
  assert.equal(pending({ jobId: "   " }), null, "只有空白也不算");
  assert.equal(pending({ jobId: 42 }), null, "不是字符串就不是 id");
  assert.deepEqual(pending({ jobId: "j-1" }),
    { jobId: "j-1", task: "", requestId: "", createdAt: 0 },
    "只有 id 的那一份也要收下:另外三个字段只是给人看的,缺了给默认值");
  assert.deepEqual(pending({ jobId: "j-1", task: "render", requestId: "r-1", createdAt: 7 }),
    { jobId: "j-1", task: "render", requestId: "r-1", createdAt: 7 }, "齐了原样收下");
}


/* 8) 旧作品(schema 1,没有那四个字段)读出来四样全空 ⇒ 打开时回出厂。
      这条同时保证"老装机升级上来"不会因为读到一个 undefined 而崩。 */
{
  mem.set("work/legacy", { schema: 1, id: "legacy", title: "老作品", prompt: "p",
    negativePrompt: "", results: [], createdAt: 1, updatedAt: 2 });
  mem.set("works/list", (mem.get("works/list") || []).concat([
    { id: "legacy", title: "老作品", prompt: "p", createdAt: 1, updatedAt: 2, hasResults: false, count: 0 }]));

  live = { pose: poseOf(88), view: VIEW_B, modelId: "chp-quick", figure: "ikea", render: RENDER_A };
  loaded.length = 0;
  await store.openWork("legacy");

  assert.equal(loaded.length, 1, "旧作品也走同一条装载路径");
  assert.deepEqual(loaded[0].document, { pose: null, view: null, modelId: "", figure: "", render: null },
    "schema 1 的记录没有姿势、视口与调色 ⇒ 装配层回出厂");
  assert.equal(live.pose.angles["hand.L"].x, FACTORY_HAND_X, "屏幕上回到出厂站姿");
  assert.deepEqual(live.view, FACTORY_VIEW, "视口回出厂取景");
  assert.deepEqual(live.render, NEUTRAL, "调色回中性 —— 打开一件没调过色的作品不该带上上一件的调色");
  assert.equal(app.state.prompt, "p", "别的东西照旧读得出来");
}

/* 9) **往返不变形**:存进记录里那一份,打开时装配层收到的要逐字段相同(含浮点)。
      这条是"恢复"这个承诺的底线 —— 差一点点看不出来,但每开一次作品就漂一点。
      **必须换到另一件作品上再回来**:openWork 自己会先 flush 当前这件,
      当前的正好就是它的话,等于拿屏幕上那份覆盖记录,这条就永远绿。 */
{
  await store.newWork("往返");
  const one = idOf("往返");
  const patchy = { azimuth: 0.123456, elevation: -0.654321, distance: 2.71828, targetY: 0.98765 };
  /* 浮点是要证明的:收口只夹行程、**不取整**(取整了每次开关作品都会漂一点) */
  const patchyRender = { brightness: 133.5, contrast: 87.25, saturation: 100, hue: -7.5, glow: 0, clarity: 100, enabled: true };
  await poseAndSave(poseOf(33.3), patchy, "chp-qwen", patchyRender);
  const once = app.utils.copy(recordOf("往返"));
  assert.equal(once.pose.angles["hand.L"].x, 33.3, "存进去就是 33.3");
  assert.deepEqual(once.view, patchy, "存进去就是那四个浮点");
  assert.deepEqual(once.render, patchyRender, "调色的六个值也要浮点级地存进去");

  /* 换到另一件上接着摆,再打开「往返」—— 拿到的必须是记录里那一份 */
  await store.newWork("别的");
  await poseAndSave(poseOf(-42), VIEW_C, "chp-render", RENDER_B);
  assert.equal(recordOf("往返").pose.angles["hand.L"].x, 33.3, "在别件上摆不该动到它");
  assert.deepEqual(recordOf("往返").render, patchyRender, "在别件上调色也不该动到它");

  loaded.length = 0;
  await store.openWork(one);

  assert.deepEqual(onScreen.get(one).pose, once.pose, "姿态往返要逐字段相同");
  assert.deepEqual(onScreen.get(one).view, once.view, "视口往返要逐字段相同");
  assert.deepEqual(onScreen.get(one).render, once.render, "调色往返也要逐字段相同");
  assert.equal(app.state.document.pose.angles["hand.L"].x, 33.3, "浮点不许被抹平");
  assert.deepEqual(app.state.document.view, patchy, "视口的浮点也不许被抹平");
  assert.equal(app.state.document.modelId, "chp-qwen", "模型卡往返也要一致");
  assert.deepEqual(app.state.document.render, patchyRender, "调色那一份也不许被抹平");
  assert.deepEqual(recordOf("往返").pose, once.pose, "再存一次也不该变形");
  assert.deepEqual(recordOf("往返").render, once.render, "调色再存一次也不该变形");
}

console.log("work.test.mjs: ok (schema 4 六个字段、新建=空文档回出厂、姿态与调色按作品分开、"
  + "换作品前先存当前件、改标题/描述不发 work:loaded、形状收口、调色收口、schema 1 兼容、往返不变形)");
