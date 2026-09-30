/* 译英在界面上唯一的残留:提示词输入框 label 上那一句
 * 「（请使用英文,或软件设置中增加翻译模型）」
 *
 * 2026-09-30 用户定稿:「对于设置中文界面的情况:如果模型需要翻译为英文,那么,
 * 如果配置了翻译模型,每次提交的时候 PoseGi 就自动使用这个翻译模型进行翻译,然后缓存
 * 备用避免下次同样内容重复调用模型翻译,把翻译结果直接发给生图模型使用;如果没有配置
 * 翻译模型,就在提示词输入框添加（请使用英文,或软件设置中增加翻译模型）。
 * 这样就可以去掉所有其他界面上的翻译按钮和输入框。」
 *
 * 所以这个文件里**没有输入框、没有按钮** —— 翻译是提交时自动发生的
 * (见 services/image-engine.js 的 prepare),用户在这一层只剩一件事可做:把描述写成英文。
 * 而"请写英文"这句话只能写在 label 上:那种状态下没有别的地方能说,
 * 用户写一句中文发出去、模型那边画不出东西,而界面上一个字都没提。
 *
 * 历史(别再捡回来):这里曾经有一个英文输入框 + 框内右下角的翻译按钮。
 * 它被删掉,是因为自动翻译让"提前手翻一遍"没有任何意义 —— 提交时该翻的一定会翻,
 * 而且带缓存(同一句话第二次不会再问模型)。
 */
(function (app) {
  "use strict";

  function t(zh, en) { return app.i18n.text(zh, en); }

  /* 这一句该不该出现。两条都满足才出:
       1. 这套机制现在在用 —— 界面中文 + 当前这张卡要英文,判据只有
          services/translate.js 的 relevant() 一处(界面各判一次就会分叉);
       2. 译英服务**没配好** —— 配好了就是自动翻,再喊一句"请使用英文"是多余的。 */
  function labelHint() {
    if (!app.services.translate.relevant()) return "";
    if (app.services.translate.ready()) return "";
    return t("（请使用英文,或软件设置中增加翻译模型）",
      " (please use English, or add a translation model in Preferences)");
  }

  app.components.translateHint = { labelHint: labelHint };
})(window.posegi);
