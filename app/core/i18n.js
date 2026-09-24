/* 中英双语:文案就近写在 DOM 上,这里只负责选择与应用
 *
 * 约定:文案元素同时写 data-zh 与 data-en;属性文案用 data-i18n-attr 指定要改的属性名。
 * 约束:不引入语言包文件,不在 core 层做 DOM 绑定(apply 由 features/editor 调用)。
 */
(function (app) {
  "use strict";

  var current = "zh";

  function language() { return current; }

  function setLanguage(value) {
    current = value === "en" ? "en" : "zh";
    if (document.documentElement) document.documentElement.lang = current === "en" ? "en" : "zh-CN";
    return current;
  }

  /* 在代码里取一条双语文案:没有对应语言时回退中文 */
  function text(zh, en) {
    if (current === "en") return en === undefined || en === null || en === "" ? zh : en;
    return zh;
  }

  function theme() {
    var media = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
    var preferred = app.config && app.config.preferences && app.config.preferences.theme;
    var dark = preferred === "dark" || (preferred === "system" || !preferred) && Boolean(media && media.matches);
    var value = dark ? "dark" : "light";
    app.state.theme = value;
    if (document.documentElement) document.documentElement.dataset.theme = value;
    return value;
  }

  /* 把 DOM 里所有 data-zh / data-en 文案刷成当前语言 */
  function apply(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll("[data-zh]");
    Array.prototype.forEach.call(nodes, function (node) {
      var value = current === "en" ? node.dataset.en : node.dataset.zh;
      if (value === undefined || value === null || value === "") value = node.dataset.zh;
      var attribute = node.dataset.i18nAttr;
      if (attribute) node.setAttribute(attribute, value);
      else node.textContent = value;
    });
    return nodes.length;
  }

  app.i18n = {
    language: language,
    setLanguage: setLanguage,
    text: text,
    theme: theme,
    apply: apply
  };
})(window.posegi);
