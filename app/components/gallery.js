/* 作品列表:列出全部作品,打开 / 编辑 / 删除
 *
 * 责任:把 store 的作品索引渲染成可操作的卡片网格,并提供"编辑作品"表单。
 * 事件:work:changed(由 store 发出)/ works:changed(数量变化)
 *
 * 挂载:init(弹层里的挂载点),每次打开作品列表时由 editor 传进来。
 *
 * 版式照 hamdraw 的作品列表:两列卡片、预览区、底部一行操作。
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
   * 这里**没有译文那一块**。2026-09-30 用户定稿把翻译改成"提交时自动做":
   * 「如果模型需要翻译为英文,那么,如果配置了翻译模型,每次提交的时候 PoseGi 就自动
   *   使用这个翻译模型进行翻译,然后缓存备用避免下次同样内容重复调用模型翻译」;
   * 于是界面上所有翻译按钮与输入框都撤了,用户在这张表单里只剩标题与角色描述两件事。
   * 英文译文由 services/image-engine.js 在提交那一刻自动翻、自动存进作品,
   * 不必用户过问;这一层唯一还能看见的痕迹是 label 上那句提示
   * (没有配翻译模型时才有,见 components/translate-hint.js)。 */

  function openEditForm(id, options) {
    if (!host) return;
    var item = find(id);
    if (!item) { paintList(); return; }
    /* 离开这张表单之后去哪。作品列表里点进来 = 回列表;
       主菜单的「编辑作品」点进来时列表根本没打开过,回列表会很怪 —— 那种情况直接关掉弹层。 */
    var back = options && options.back === "close" ? "close" : "list";
    editing = String(id);
    var draft = { title: String(item.title || ""), prompt: String(item.prompt || "") };

    function leave() {
      editing = "";
      if (back === "close") app.components.ui.closeSheet();
      else paintList();
    }

    function paint() {
      host.innerHTML =
        '<label class="field"><span>' + t("标题(留空自动取名)", "Title (auto-named when empty)") + '</span>' +
        '<input name="title" type="text" value="' + esc(draft.title) + '" placeholder="' + esc(app.services.store.untitledTitle()) + '"></label>' +
        '<label class="field"><span>' + t("角色描述", "Description") +
        app.components.translateHint.labelHint() + '</span>' +
        '<textarea name="prompt" rows="3" placeholder="' + esc(t("例如:一个女孩站在海边,傍晚的光", "For example: a girl standing by the sea at dusk")) + '">' +
        esc(draft.prompt) + "</textarea></label>" +
        '<p class="field-help">' + t("描述会在每次生成时提交给模型,之后随时可以回来改。", "The description is sent to the model on every generation and can be edited later.") + "</p>" +
        '<div class="sheet-actions">' +
        '<button class="button button-secondary" type="button" data-cancel>' + t("返回", "Back") + "</button>" +
        '<button class="button button-primary" type="button" data-save>' + t("保存", "Save") + "</button>" +
        "</div>";

      var titleInput = host.querySelector('[name="title"]');
      var promptInput = host.querySelector('[name="prompt"]');
      titleInput.oninput = function () { draft.title = titleInput.value; };
      promptInput.oninput = function () { draft.prompt = promptInput.value; };

      host.querySelector("[data-cancel]").onclick = leave;
      host.querySelector("[data-save]").onclick = app.components.ui.action(async function () {
        /* **不递 english**。英文译文留给提交那一刻自动翻(image-engine 的 prepare),
           store.pairFor 收到"没递过来"就按缓存里那句现成的挂上 —— 于是改描述时
           旧译文自然作废(原文对不上),而缓存里正好有新译文就顺手补上。
           绝不用一次保存把已有的译文清掉,这正是 pairFor 那条规则存在的理由。 */
        await app.services.store.updateWork(id, { title: draft.title, prompt: draft.prompt });
        leave();
        app.components.ui.toast(t("作品已更新", "Artwork updated"));
      });
    }

    paint();
  }

  app.components.gallery = { init: init, render: render, openEditForm: openEditForm };
})(window.posegi);
