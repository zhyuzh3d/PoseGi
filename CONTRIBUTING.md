# 贡献指南

感谢你愿意为 **PoseGi** 出力。PoseGi 是运行在 Hermit 宿主里的 3D 摆姿 happ,本文件说明提 Issue,提 Pull Request,本地开发与自检,代码风格与红线。动手前请先读一遍,并顺带读一下仓库里的 `AGENTS.md` 与 `guid.md`。

## 提 Issue

- 到 <https://github.com/zhyuzh3d/PoseGi/issues> 新建 Issue,优先使用仓库提供的模板：`.github/ISSUE_TEMPLATE/bug_report.yml`(缺陷)与 `feature_request.yml`(功能建议)。
- 缺陷请写清：复现步骤,期望结果,实际结果,PoseGi 版本(见 `hermit.json`),Hermit 版本,Android 与 WebView 版本,设备是否支持 WebGL,以及相关日志或截图。
- **不要**在 Issue 里粘贴真实 API Key,访问令牌,设备开发地址或服务密码,也不要粘贴隐私图片。

## 提 Pull Request

1. Fork 本仓库并从 `main` 切出特性分支。分支名建议 `fix/短描述`,`feat/短描述`,`doc/短描述`。
2. 一个 PR 只做一件事,只改与目标直接相关的文件。
3. 提交前跑与改动相称的自检(见下),在 PR 描述里写清：改了什么,为什么,怎么验证的。
4. 向 `main` 发起 PR,描述里关联相关 Issue(如 `Closes #12`)。

## 分支与提交信息风格

- 分支：从 `main` 切出,合并回 `main`。
- 提交信息参考仓库既有历史,推荐使用一句话主题行(可用半角前缀)：
  - `feat: 一句话说清新能力`
  - `fix: 一句话说清修了什么`
  - `doc:` / `chore:` / `refactor:` / `test:`
  - 也可以用中文直接描述,例如「摆姿：解剖学校正骨架并接入自写 IK」。
- 主题行尽量控制在 72 字符以内,需要时在正文说明动机,影响面与验证方式。

## 本地跑起来

PoseGi 是纯原生页面,**没有构建步骤**,源文件直接运行,直接用浏览器打开 `index.html` 可看界面(没有 Hermit Bridge 时 `app/platform/hermit.js` 会退回 `fetch` 与 `localStorage`,仅作开发期降级路径)。

真机热更新优先(设备开发地址与密码见手机 Hermit 的「开发配置」)：

```sh
python3 tools/dev.py --address http://PHONE:8766
```

它包的是 Hermit 智能体开发模式的 `develop-dir`：初始化一次 DEV 工作区,之后持续监听本地改动并按批同步,不递增版本号,不打包。

## 自检

按改动范围选择,验证强度与改动相称：

```sh
node tools/verify.mjs --source-only  # 清单断言,引用存在性,禁用语法扫描,跨模块导出检查与纯逻辑测试
python3 tools/package.py --check     # 只在改动触及发布产物时:校验运行包
```

纯逻辑测试放在 `tests/`：`rig.test.mjs`(关节层级与限位),`ik.test.mjs`(反向运动学),`poser.test.mjs`,`providers.test.mjs`(生图接口适配),`settings.test.mjs`,`translate.test.mjs` 等。改动对应模块时要同步这些测试。

## 代码风格与红线

- **依赖方向固定** `core → platform → services → components → features`,不允许反向依赖,`core` 不碰 DOM,`app/platform/hermit.js` 是宿主能力与网络的唯一出口。
- 兼容 Android 10 与旧厂商 WebView(设备 CSS 视口约 510px 宽,实测等价 Chrome 83)：
  - flex 的 `gap` 在该 WebView 上不生效,flex 行间距用相邻兄弟 `margin`,grid 的 `gap` 正常。
  - **不用** `?.`,`??`,`||=`,`&&=` 等新语法,不用 ES Modules 语法作为唯一运行路径。
  - 窄屏分支写在 `@media(max-width:520px)`。
- 组件以保守语法的 IIFE 注册到 `window.posegi`。
- WebGL 必须做特性检测：拿不到上下文时给出可读提示并保持页面可用,不得白屏或抛未捕获异常。
- 姿态数据模型 `app/core/rig.js` 是纯数据(关节名,层级,默认角度,限位,姿态序列化格式),成对关节的限位由左侧经镜像生成,不许手抄反。改这里要同步 `tests/rig.test.mjs`。IK 的纯数学在 `app/core/ik.js`,对应 `tests/ik.test.mjs`。
- 安全与数据边界：所有模型请求与文件操作统一经过 `app/platform/hermit.js`,公网服务必须 HTTPS,HTTP 只允许可信局域网,图片字节,Base64,data URL 禁止写入 `hermit.data`,持久化只存文件引用或路径,API Key 只在用户明确保存后写入本 happ 的隔离数据区,界面默认遮罩。
- `vendor/` 里的第三方库必须是自带许可原文的正式发行文件,不得内嵌构建产物之外的补丁。
- 运行包只包含 `index.html`,`hermit.json`,`guid.md`,`app/`,`styles/` 与 `vendor/`,`tools/`,`tests/`,`docs/`,`release/` 不进包。

## 不要提交

- API Key,密码,访问令牌。
- 设备开发地址与六位密码(`.hermit-dev.json` 已在 `.gitignore` 中忽略,不要提交)。
- 用户图片,姿态数据或其他本地资产。
- `.server-state/`,`*.log`,`*.pid` 等本机开发残留。

## License

提交即表示你同意你的贡献以本仓库的 [MIT License](./LICENSE) 授权。
