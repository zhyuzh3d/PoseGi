/* 持久化:配置、姿态库、作品记录
 *
 * 责任:把 app.defaults 的形状与宿主数据区对上,提供读写的唯一入口。
 * 约束:只存引用与标量,图片字节与 Base64 一律不进 hermit.data(见 AGENTS.md)。
 *
 * 数据区布局(collection/key):
 *   config / "app"        → 一份 app.defaults 形状的配置
 *   pose   / <poseId>     → rig.serialize() 产出的姿态记录
 *   result / <resultId>   → 生图记录(只存文件引用与参数,不存图)
 */
(function (app) {
  "use strict";

  var CONFIG_KEY = { collection: "config", key: "app" };

  /* 逐字段合并,保证旧版本存下来的配置缺字段时也能跑 */
  function shapeConfig(raw) {
    var defaults = app.defaults;
    var source = raw && typeof raw === "object" ? raw : {};
    var result = app.utils.merge(defaults, {});
    result.schema = defaults.schema;
    result.preferences = app.utils.merge(defaults.preferences, source.preferences || {});
    result.render = app.utils.merge(defaults.render, source.render || {});
    result.generation = app.utils.merge(defaults.generation, source.generation || {});
    return result;
  }

  async function loadConfig() {
    var record = await app.platform.hermit.getData(CONFIG_KEY.collection, CONFIG_KEY.key);
    app.config = shapeConfig(record && record.value);
    return app.config;
  }

  async function saveConfig(config) {
    var value = shapeConfig(config || app.config);
    app.config = value;
    await app.platform.hermit.putData(CONFIG_KEY.collection, CONFIG_KEY.key, value);
    return value;
  }

  async function savePose(pose) {
    var record = app.rig.serialize(pose);
    if (!record.name) throw new Error("姿态需要先命名");
    await app.platform.hermit.putData("pose", record.name, record);
    return record;
  }

  async function loadPose(name) {
    var record = await app.platform.hermit.getData("pose", String(name || ""));
    return record && record.value ? app.rig.parse(record.value) : null;
  }

  async function deletePose(name) {
    return app.platform.hermit.deleteData("pose", String(name || ""));
  }

  async function saveResult(result) {
    var value = {
      schema: 1,
      id: String(result && result.id || ""),
      createdAt: Number(result && result.createdAt) || Date.now(),
      prompt: String(result && result.prompt || ""),
      poseName: String(result && result.poseName || ""),
      fileId: String(result && result.fileId || ""),
      params: result && result.params ? result.params : {}
    };
    if (!value.id) throw new Error("生图记录缺少 id");
    await app.platform.hermit.putData("result", value.id, value);
    return value;
  }

  /* 列表能力待宿主数据接口提供枚举后再补(见 README 的"目标能力") */
  function notImplemented(name) {
    return function () {
      throw new Error(name + " 尚未实现:需要先确认宿主数据区是否提供有序枚举");
    };
  }

  app.services.store = {
    shapeConfig: shapeConfig,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    savePose: savePose,
    loadPose: loadPose,
    deletePose: deletePose,
    saveResult: saveResult,
    listPoses: notImplemented("姿态库列表"),
    listResults: notImplemented("作品列表")
  };
})(window.posegi);
