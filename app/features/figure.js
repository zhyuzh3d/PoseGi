/* 人物造型:启动时把模型的骨架参数装进 rig
 *
 * 责任:把"用哪套骨架与几何"收在一处 —— 改 rig 的关节表、换视口的几何、重存配置。
 *       目前只有一个造型(宜家人偶),所以没有切换界面;留着这一层是因为它是
 *       "模型数据 → 骨架 → 视口"的唯一编排点,以后加第二个模型只需要登记一次。
 * 事件:figure:changed { id, label }
 * 约束:模型只是数据(app/core/models.js + app/assets/models/*.js);本模块不做几何处理,
 *       也不碰 DOM。
 *
 * 为什么不放在 rig.js:rig 是纯数据 + 纯数学,不认识"当前选了谁"这种运行时状态;
 * 为什么不放在 viewport.js:视口不认识配置与姿态。这里是唯一的编排点。
 *
 * 顺序很关键:
 *   1) rig.applyModel 先换骨架参数(姿态的 rest 随之改变)
 *   2) poser 静默复位到新骨架的默认站姿(旧的姿态角度对新骨架没有意义)
 *   3) viewport.setFigure 用新骨架 + 新姿态重搭那一层网格
 * 反过来做(先复位姿态再换骨架)会多一次"旧网格配新骨架"的重绘,屏幕上一帧乱影。
 */
(function (app) {
  "use strict";

  /* 出厂唯一登记的模型。配置里存着别的 id(旧版本写进去的、已删掉的造型)时一律退回它。 */
  var DEFAULT_ID = "ikea";
  var activeId = "";

  /* 在册的模型就用它,否则退回默认造型 —— 配置里存着一个已经删掉的模型 id 时,
     不能让造型整个起不来。 */
  function normalize(id) {
    var value = String(id || "");
    if (value && app.models && app.models.has(value)) return value;
    if (app.models && app.models.has(DEFAULT_ID)) return DEFAULT_ID;
    /* 模型脚本没加载成功:返回空串,骨架退化成"原点上的零长节点"——
       一眼就能看出是数据缺了,而不是静默拿一套写死的数字顶上 */
    return "";
  }

  function definition(id) {
    var value = normalize(id);
    return value && app.models ? app.models.get(value) : null;
  }

  function current() { return activeId; }

  function pick(id) {
    var item = definition(id);
    return item || { id: "", label: ["没有可用模型", "No model"], short: ["无", "None"] };
  }

  function label(id) {
    var item = pick(id);
    return app.i18n.text(item.label[0], item.label[1]);
  }

  function list() {
    return (app.models ? app.models.list() : []).map(function (model) {
      return { id: model.id, label: model.label, short: model.short };
    });
  }

  /* 启动时按配置装上骨架。**不碰视口** —— 那时视口还没建,
     它初始化时会直接读到装好的关节表。 */
  function init() {
    var id = normalize(app.config && app.config.render ? app.config.render.character : DEFAULT_ID);
    app.rig.applyModel(definition(id));
    activeId = id;
    return id;
  }

  /* 换造型。返回真正生效的 id。 */
  function apply(id, options) {
    var next = normalize(id);
    var config = options || {};
    if (next === activeId && config.force !== true) return next;

    app.rig.applyModel(definition(next));
    activeId = next;
    var angles = app.features.poser.reset(true);

    var viewport = app.components.viewport;
    if (viewport.available()) {
      viewport.setFigure(angles);
      viewport.frameCamera();
    }

    if (app.config && app.config.render) {
      app.config.render.character = next;
      /* 存不下不影响这一次切换已经生效,所以只提示不抛 */
      app.services.store.saveConfig(app.config).catch(function () {});
    }

    app.events.emit("figure:changed", { id: next, label: label(next) });
    return next;
  }

  app.features.figure = {
    defaultId: DEFAULT_ID,
    init: init,
    list: list,
    current: current,
    label: label,
    apply: apply
  };
})(window.posegi);
