/* 模型库:外部模型转成的"骨架 + 刚性件"数据的登记处
 *
 * 责任:持有 app/assets/models/*.js 登记进来的模型定义,并在需要时把它解成 three.js 几何体。
 * 约束:core 层不碰 DOM;three.js 只在真正取几何体时才用,没跑 3D 的路径完全不受影响。
 *
 * 模型定义(由 tools/import-model.py 生成)的形状:
 *   { id, label: [zh, en], short: [zh, en], source,
 *     joints: { 关节名: { offset: [x, y, z], rest: [x, y, z], length, radius } },
 *     parts:  { 关节名: { n, pos: <base64 f32>, idx: <base64 u16> } } }
 *
 * 顶点写在**关节局部坐标系**里(原点 = 关节,骨骼方向 = 局部 +Y),
 * 与 app/core/rig.js 的约定逐字一致 —— 所以视口可以拿它当"另一套骨骼几何"直接替换,
 * FK、命中检测、IK 一行都不用改。
 *
 * 几何里**不含法线**:加载时按需 computeVertexNormals() 算一遍,省掉约四成体积。
 * 也不含贴图与纹理 —— 造型统一由主题色决定(见 viewport.js 的 THEMES)。
 *
 * 顶点索引上限是 Uint16(65535),转换器已按"单件顶点数远小于该值"输出。
 */
(function (app) {
  "use strict";

  var definitions = {};
  var order = [];
  var cache = {};

  /* 登记一个模型。重复登记同一个 id 时保留首次出现的顺序,数据取最新的一份。 */
  function register(definition) {
    if (!definition || !definition.id || !definition.joints) return null;
    var id = String(definition.id);
    if (order.indexOf(id) < 0) order.push(id);
    definitions[id] = definition;
    dispose(id);
    return definition;
  }

  function get(id) { return definitions[String(id || "")] || null; }

  function has(id) { return Boolean(get(id)); }

  function list() {
    return order.map(function (id) { return definitions[id]; });
  }

  /* base64 → 定型数组。转换器一律按小端打包,而设备上的 ARM 也是小端,
     所以可以直接用 buffer 视图,不必逐元素搬运。 */
  function typed(text, Type, size) {
    var bytes = app.utils.base64ToBytes(text);
    return new Type(bytes.buffer, 0, Math.floor(bytes.byteLength / size));
  }

  function triangles(part) {
    var index = part && part.idx ? typed(part.idx, Uint16Array, 2) : null;
    return index ? index.length / 3 : 0;
  }

  /* 按 id + 关节名取几何体,取过一次就留下 —— 切换造型时会来回取同一批几何。 */
  function geometry(id, partName) {
    var key = String(id || "") + "/" + String(partName || "");
    if (cache[key]) return cache[key];
    var definition = get(id);
    var part = definition && definition.parts ? definition.parts[partName] : null;
    var THREE = window.THREE;
    if (!part || !THREE) return null;
    if (!part.n || !part.pos) return null;

    var built = new THREE.BufferGeometry();
    built.setAttribute("position", new THREE.BufferAttribute(typed(part.pos, Float32Array, 4), 3));
    built.setIndex(new THREE.BufferAttribute(typed(part.idx, Uint16Array, 2), 1));
    built.computeVertexNormals();
    cache[key] = built;
    return built;
  }

  /* 一个模型的粗略规模,给界面与自检报数用 */
  function stats(id) {
    var definition = get(id);
    if (!definition) return null;
    var vertices = 0;
    var faces = 0;
    Object.keys(definition.parts || {}).forEach(function (name) {
      vertices += definition.parts[name].n / 3;
      faces += triangles(definition.parts[name]);
    });
    return { joints: Object.keys(definition.joints).length, parts: Object.keys(definition.parts || {}).length, vertices: vertices, triangles: faces };
  }

  function dispose(id) {
    var prefix = String(id || "") + "/";
    Object.keys(cache).forEach(function (key) {
      if (key.indexOf(prefix) !== 0) return;
      if (cache[key] && cache[key].dispose) cache[key].dispose();
      delete cache[key];
    });
  }

  function clear() {
    Object.keys(cache).forEach(function (key) { if (cache[key] && cache[key].dispose) cache[key].dispose(); });
    cache = {};
  }

  app.models = {
    register: register,
    get: get,
    has: has,
    list: list,
    geometry: geometry,
    stats: stats,
    dispose: dispose,
    clear: clear
  };
})(window.posegi);
