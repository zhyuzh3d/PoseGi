/* 中英双语:文案就近写在 DOM 上,这里只负责选择与应用
 *
 * 约定:文案元素同时写 data-zh 与 data-en;属性文案用 data-i18n-attr 指定要改的属性名。
 * 约束:不引入语言包文件,不在 core 层做 DOM 绑定(apply 由 features/editor 调用)。
 *
 * 语言偏好有三态:**system / zh / en**(2026-09-25 用户要求「支持中英文双语,默认跟随系统」)。
 * 存的是**偏好**,"跟随系统"要每次现算 —— 把 system 解析成具体语言后存下来,
 * 下次系统换了语言就再也跟不上,那是把"跟随"写成了"锁定"。
 */
(function (app) {
  "use strict";

  var current = "zh";
  var preference = "system";

  function language() { return current; }

  function systemLanguage() {
    var list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""];
    for (var index = 0; index < list.length; index += 1) {
      var value = String(list[index] || "").toLowerCase();
      if (value.indexOf("zh") === 0) return "zh";
      if (value.indexOf("en") === 0) return "en";
    }
    return "zh";
  }

  /* 偏好 → 实际语言。只有字面是 zh / en 才算"指定了",其余(含 system 与脏值)都跟随系统。 */
  function resolve(value) {
    var wanted = String(value || "system");
    if (wanted === "zh" || wanted === "en") return wanted;
    return systemLanguage();
  }

  function setLanguage(value) {
    preference = String(value || "system");
    current = resolve(preference);
    if (document.documentElement) document.documentElement.lang = current === "en" ? "en" : "zh-CN";
    return current;
  }

  function preferred() { return preference; }

  /* 在代码里取一条双语文案:没有对应语言时回退中文 */
  function text(zh, en) {
    if (current === "en") return en === undefined || en === null || en === "" ? zh : en;
    return zh;
  }

  /* 主题:应用不做主题切换,恒定取 namespace 里的锁值(深色)。
     不再读 prefers-color-scheme —— 2026-09-25 用户要求锁定深色主题。 */
  function theme() {
    var value = app.THEME === "light" ? "light" : "dark";
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
    preferred: preferred,
    setLanguage: setLanguage,
    text: text,
    theme: theme,
    apply: apply
  };
})(window.posegi);
