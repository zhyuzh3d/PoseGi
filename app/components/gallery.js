/* 作品列表:列出全部作品,打开 / 编辑 / 删除
 *
 * 责任:把 store 的作品索引渲染成可操作的卡片网格,并提供"编辑作品"表单。
 * 事件:work:changed(由 store 发出)/ works:changed(数量变化)
 *
 * 挂载:init(弹层里的挂载点),每次打开作品列表时由 editor 传进来。
 *
 * 版式照 vibedraw 的作品列表:两列卡片、预览区、底部一行操作。
 * 预览区这里放**角色描述**而不是缩略图:一件作品可能还没有成图,
 * 一张空白的预览框比一段文字更没用。
 *
 * 2026-09-25 用户要求两处改动:
 *   1) 「作品库中的添加按钮去掉,作品库改名作品列表」—— 新建的入口收到右上角菜单里
 *      (菜单第一项「添加作品」),列表这一页只管看和管已有的作品;
 *   2) 每张卡加「编辑」,编辑界面里显示这段描述对应的**英文译文** ——
 *      标了「需要翻译为英文」的模型卡生图前会用到它,用户得能看见到底翻了什么。
 */
(function (app) {
  "use strict";

  var host = null;
  /* 正在编辑哪一件(空串 = 在看列表)。
   * 为什么需要它:保存 / 立即翻译都会写作品,store 于是发 works:changed,
   * 而 editor 收到这个事件就会调一次 render() —— 那会把**正在填的表单**整块换掉,
   * 「立即翻译」刚拿到的译文还没来得及显示就被列表顶走了。
   * 所以编辑期间外部触发的 render 一律不执行,列表由表单自己那两条出口重画。 */
  var editing = "";

  function t(zh, en) { return app.i18n.text(zh, en); }
  function esc(value) { return app.utils.escapeHtml(value); }

  function init(element) {
    host = element || host;
    /* 挂载点是每次打开弹层新建的,所以"上次退出时还在编辑"这件事不该跨次保留 */
    editing = "";
    return Boolean(host);
  }

  /* ---------- 列表 ---------- */

  function cardHtml(item) {
    var current = item.current ? '<span class="art-current">' + t("当前作品", "Current") + "</span>" : "";
    var prompt = String(item.prompt || "").trim();
    return '<article class="art-card" data-work="' + esc(item.id) + '">' +
      '<button class="art-open" data-open="' + esc(item.id) + '">' + current +
      '<span class="art-prompt">' + (prompt ? esc(prompt) : '<em>' + t("还没有描述", "No description yet") + "</em>") + "</span>" +
      '<span class="art-badge">' + item.count + " " + t("张成图", "images") + "</span></button>" +
      '<div class="art-meta"><span class="art-title">' + esc(item.title) + "</span>" +
      '<span class="art-date">' + esc(app.utils.formatTime(item.updatedAt)) + "</span>" +
      '<div class="art-actions">' +
      '<button class="button button-secondary" data-open="' + esc(item.id) + '">' + t("打开", "Open") + "</button>" +
      '<button class="icon-button" data-edit="' + esc(item.id) + '" aria-label="' + t("编辑作品", "Edit artwork") + '"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>' +
      '<button class="icon-button" data-delete="' + esc(item.id) + '" aria-label="' + t("删除作品", "Delete artwork") + '"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>' +
      "</div></div></article>";
  }

  function emptyHtml() {
    return '<div class="empty-state"><i class="fa-regular fa-folder-open" aria-hidden="true"></i>' +
      "<strong>" + t("作品还会出现在这里吗?", "Your artworks will live here") + "</strong>" +
      "<p>" + t("点右上角菜单里的「添加作品」建一件,写一句描述就可以开始生图。", "Use Add artwork in the top-right menu to create one, describe it, and start generating.") + "</p></div>";
  }

  function find(id) {
    return app.services.store.listWorks().filter(function (item) { return item.id === id; })[0] || null;
  }

  async function paintList() {
    /* 挂载点是弹层内部的 #gallery-slot,而不是外面某个常驻容器:
       弹层每次打开都会重写 innerHTML,常驻容器被搬进去之后会被下一次 openSheet
       连带销毁 —— 表现是"第二次打开作品列表是空的"。挂载点没了就什么也不做。 */
    if (!host || (host.isConnected === false)) return;
    editing = "";
    var list = app.services.store.listWorks();
    host.innerHTML = list.length ? '<div class="gallery-grid">' + list.map(cardHtml).join("") + "</div>" : emptyHtml();

    Array.prototype.forEach.call(host.querySelectorAll("[data-open]"), function (button) {
      button.onclick = app.components.ui.action(async function () {
        await app.services.store.openWork(button.dataset.open);
        app.components.ui.closeSheet();
        app.components.ui.toast(t("已打开作品:", "Artwork opened: ") + app.state.workTitle);
      });
    });

    Array.prototype.forEach.call(host.querySelectorAll("[data-edit]"), function (button) {
      button.onclick = function () { openEditForm(button.dataset.edit); };
    });

    Array.prototype.forEach.call(host.querySelectorAll("[data-delete]"), function (button) {
      button.onclick = app.components.ui.action(async function () {
        var confirmed = await app.components.ui.confirm({
          title: t("删除这件作品?", "Delete this artwork?"),
          message: t("作品与它的全部成图会一起删除,无法恢复。", "The artwork and all of its images are deleted. This cannot be undone."),
          okText: t("删除", "Delete")
        });
        if (!confirmed) return;
        await app.services.store.removeWork(button.dataset.delete);
        await paintList();
        app.components.ui.toast(t("作品已删除", "Artwork deleted"));
      });
    });
  }

  /* 对外的入口:编辑期间一律不重画 —— 否则保存 / 翻译写下去时发出的 works:changed
     会把用户正在填的那张表单整块冲掉(见 editing 的注释)。
     表单自己的两条出口(返回 / 保存)直接调 paintList,不走这道闸。 */
  function render() {
    if (editing) return Promise.resolve(null);
    return paintList();
  }

  /* ---------- 编辑 ----------
   * 表单就地换掉列表:开第二个 sheet 会叠在第一个上面,
   * 而"返回列表"只需要再渲染一次 —— 少一层弹层,少一类层级 bug。
   *
   * 译文那一块是这个表单的重点:用户标的「需要翻译为英文」会在生图时把这段中文
   * 换成英文发给模型,那他必须能在这里看见译文、并且能手动催一次翻译
   * (第一次生图之前缓存里还没有这句话,不给按钮就只能靠"先生成一次"来触发)。 */

  function translationHtml(prompt, pair) {
    var english = app.services.translate.fromPair(pair, prompt);
    if (english) {
      return '<div class="translate-block"><span class="section-label">' + t("英文译文", "English") + "</span>" +
        '<p class="translate-text">' + esc(english) + "</p>" +
        '<p class="field-help">' + t("这段译文存在本机,生图时直接用它,不会重复翻译。", "This translation is stored on the device and reused, so it is never translated twice.") + "</p></div>";
    }
    var hasCjk = app.services.translate.hasCjk(prompt);
    return '<div class="translate-block"><span class="section-label">' + t("英文译文", "English") + "</span>" +
      '<p class="translate-text is-empty">' +
      (hasCjk ? t("还没有译文,点右边翻译一次", "No translation yet. Translate it once on the right.")
        : t("描述里没有中文,不需要翻译", "The description has no Chinese, so nothing to translate")) + "</p>" +
      (hasCjk ? '<div class="button-row"><button class="button button-secondary" type="button" data-translate-now>' +
        t("立即翻译", "Translate now") + "</button></div>" : "") + "</div>";
  }

  function openEditForm(id) {
    if (!host) return;
    var item = find(id);
    if (!item) { paintList(); return; }
    editing = String(id);
    var draft = { title: String(item.title || ""), prompt: String(item.prompt || "") };
    var pair = { promptEn: item.promptEn || null };

    function paint() {
      host.innerHTML =
        '<label class="field"><span>' + t("标题(留空自动取名)", "Title (auto-named when empty)") + '</span>' +
        '<input name="title" type="text" value="' + esc(draft.title) + '" placeholder="' + esc(app.services.store.untitledTitle()) + '"></label>' +
        '<label class="field"><span>' + t("角色描述", "Description") + '</span>' +
        '<textarea name="prompt" rows="3" placeholder="' + esc(t("例如:一个女孩站在海边,傍晚的光", "For example: a girl standing by the sea at dusk")) + '">' +
        esc(draft.prompt) + "</textarea></label>" +
        '<p class="field-help">' + t("描述会在每次生成时提交给模型,之后随时可以回来改。", "The description is sent to the model on every generation and can be edited later.") + "</p>" +
        '<div id="translate-slot"></div>' +
        '<div class="sheet-actions">' +
        '<button class="button button-secondary" type="button" data-cancel>' + t("返回", "Back") + "</button>" +
        '<button class="button button-primary" type="button" data-save>' + t("保存", "Save") + "</button>" +
        "</div>";

      var titleInput = host.querySelector('[name="title"]');
      var promptInput = host.querySelector('[name="prompt"]');
      var slot = host.querySelector("#translate-slot");
      titleInput.oninput = function () { draft.title = titleInput.value; };
      promptInput.oninput = function () {
        var changed = draft.prompt !== promptInput.value;
        draft.prompt = promptInput.value;
        /* 描述一改,原来那块译文就不再对应当前这句话了 —— 就地重画那一块,
           别让它继续显示旧译文(用户会以为改描述之后译文也跟着变)。 */
        if (changed) paintTranslation();
      };
      function paintTranslation() {
        slot.innerHTML = translationHtml(draft.prompt, pair);
        var now = slot.querySelector("[data-translate-now]");
        if (now) now.onclick = app.components.ui.action(translateNow);
      }
      async function translateNow() {
        var text = String(draft.prompt || "").trim();
        if (!text) return;
        var results = await app.services.translate.translate([text]);
        if (!app.services.translate.translated(text)) {
          app.components.ui.toast(results.length
            ? t("翻译服务没有给出译文,请到「软件设置」里检查翻译模型", "The translator returned no English. Check the translation model in Preferences.")
            : t("译英服务还没配置好,请到「软件设置」里添加中英文翻译模型", "The translator is not set up yet. Add a translation model in Preferences."), "error");
          return;
        }
        /* 顺手把译文写进作品(也写进列表索引),这样关掉弹层再进来它就还在 */
        await app.services.store.updateWork(id, { title: draft.title, prompt: draft.prompt });
        pair = { promptEn: app.services.translate.pair(draft.prompt, "") };
        paintTranslation();
      }
      paintTranslation();

      host.querySelector("[data-cancel]").onclick = paintList;
      host.querySelector("[data-save]").onclick = app.components.ui.action(async function () {
        await app.services.store.updateWork(id, { title: draft.title, prompt: draft.prompt });
        await paintList();
        app.components.ui.toast(t("作品已更新", "Artwork updated"));
      });
    }

    paint();
  }

  app.components.gallery = { init: init, render: render, openEditForm: openEditForm };
})(window.posegi);
