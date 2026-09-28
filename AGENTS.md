# PoseGi 开发约束

PoseGi 是 HaminnApp 中运行的普通 happ,不是 HaminnUI,也不拥有宿主管理权限。每项任务开始时先明确本轮对象、动作和验收点,只处理该边界。

## 仓库与发布边界

- 本目录是独立 Git 仓库,唯一规范远程为 `git@github.com:zhyuzh3d/PoseGi.git`。不得与其他仓库合并提交、互相嵌套或改作 subtree / submodule。
- 提交或推送前先确认 `git rev-parse --show-toplevel` 以 `/PoseGi` 结尾,且 `git remote get-url origin` 精确匹配上面的地址。
- 运行包白名单只有一个出处:`tools/package.py` 的 `RUNTIME_ROOTS`(`index.html`、`haminn.json`、`guid.md`、`app`、`styles`、`vendor`)。`tools/`、`tests/`、`docs/`、`release/` 不进包。
- `vendor/` 里的第三方库必须是自带许可原文的正式发行文件,不得内嵌构建产物之外的补丁。

## 页面技术基线

- 纯原生 HTML / CSS / JavaScript,源文件直接可运行:不用 React、Vue、Vite、Webpack、npm 运行依赖、CDN、远程字体或运行时下载的模块。
- 组件以保守语法的 IIFE 注册到 `window.posegi`,不用 ES Modules 作为唯一运行路径。
- 依赖方向固定 `core → platform → services → components → features`,不允许反向依赖;`core` 不碰 DOM,`platform` 是宿主能力与网络的唯一出口。
- 设备 WebView 视口宽度只有 510px 左右,兼容基线按 Android 10 与旧厂商 WebView(实测等价 Chrome 83):
  - flex 的 `gap` 在该 WebView 上不生效,flex 行的间距用相邻兄弟 `margin`;grid 的 `gap` 正常。
  - 不用 `?.`、`??`、`||=`、`&&=` 等新语法,不用 ES Modules 语法。
  - 窄屏分支写在 `@media(max-width:520px)`。
- WebGL 必须特性检测:不可用时给出可读提示并保持页面可用,不得白屏或抛未捕获异常。
- 页面同时支持 `haminnready` 事件与即时 `window.haminn.isReady`。

## 数据与安全边界

- 所有模型请求与文件操作统一经过 `app/platform/haminn.js`。公网服务必须使用 HTTPS;HTTP 只允许可信局域网地址。
- 图片字节、Base64、data URL 禁止写入 `haminn.data`:持久化只存文件引用或路径,大图走文件接口。
- API Key 只在用户明确保存后写入本 happ 的隔离数据区,界面默认遮罩;绝不写入源码、日志、文档、测试或提交记录。
- 设备开发地址与六位密码不写入仓库任何文件(见 `.gitignore` 的 `.haminn-dev.json`)。

## 开发与验证节奏

- 日常迭代走热更新:`python3 tools/dev.py --address http://PHONE:8766`(等价 `haminn-agent.py develop-dir`)。改代码不等于发版,不递增版本号、不生成 release zip。
- 版本号与 `haminn-install.json` 只在用户明确要求发版、交付稳定包或更新下载位时才动。
- 验证强度与改动相称:界面或逻辑改动只跑与改动直接相关的检查(`node tools/verify.mjs --source-only`,必要时一次真机确认);`tests/` 全量与 `tools/package.py` 只在用户要求或改动触及发布产物时跑。
- 报告"已修复 / 已生效"之前,先在设备上读到对应证据(页面状态或截图),不要只凭同步成功就下结论。
- 同一批代码没有变化时不重复同步、打包或安装。
