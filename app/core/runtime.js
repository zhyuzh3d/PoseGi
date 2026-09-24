/* 运行时基础设施:帧调度与有界缓存
 *
 * 责任:把"每帧只做一次"的渲染请求合并;给位图等重对象一个有上限的 LRU。
 * 约束:不依赖 three.js,不依赖 DOM 之外的东西。
 */
(function (app) {
  "use strict";

  /* 把同一帧内多次 request 合并成一次 callback */
  function createFrameTask(callback) {
    var handle = 0, pending = false, value;
    var request = window.requestAnimationFrame || function (task) { return setTimeout(task, 16); };
    var cancel = window.cancelAnimationFrame || clearTimeout;
    function run() {
      handle = 0;
      if (!pending) return;
      pending = false;
      var next = value;
      value = undefined;
      callback(next);
    }
    return {
      request: function (next) {
        value = next;
        pending = true;
        if (!handle) handle = request(run);
      },
      flush: function () {
        if (!pending) return;
        if (handle) cancel(handle);
        handle = 0;
        run();
      },
      cancel: function () {
        if (handle) cancel(handle);
        handle = 0;
        pending = false;
        value = undefined;
      },
      pending: function () { return pending; }
    };
  }

  /* 有界缓存:按条数与权重双上限淘汰最久未用项 */
  function createLru(options) {
    options = options || {};
    var maxEntries = Math.max(1, Number(options.maxEntries) || 16);
    var maxWeight = Math.max(0, Number(options.maxWeight) || 0);
    var weigh = typeof options.weight === "function" ? options.weight : function () { return 1; };
    var values = new Map(), weights = new Map(), total = 0;
    function drop(key) {
      if (!values.has(key)) return;
      total -= weights.get(key) || 0;
      weights.delete(key);
      values.delete(key);
    }
    function trim() {
      while (values.size > maxEntries || maxWeight && total > maxWeight) {
        var oldest = values.keys().next();
        if (oldest.done) break;
        drop(oldest.value);
      }
    }
    return {
      get: function (key) {
        if (!values.has(key)) return undefined;
        var value = values.get(key), weight = weights.get(key);
        values.delete(key);
        weights.delete(key);
        values.set(key, value);
        weights.set(key, weight);
        return value;
      },
      set: function (key, value) {
        drop(key);
        values.set(key, value);
        weights.set(key, weigh(value));
        total += weights.get(key);
        trim();
      },
      has: function (key) { return values.has(key); },
      delete: drop,
      clear: function () { values.clear(); weights.clear(); total = 0; },
      size: function () { return values.size; },
      weight: function () { return total; }
    };
  }

  app.runtime = { createFrameTask: createFrameTask, createLru: createLru };
})(window.posegi);
