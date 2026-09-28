# guid.md — PoseGi(写给插件的短说明)

开发这个 happ 之前读一遍就够了。这里只讲这个项目本身:技术思路、目录、注意事项、怎么自检。完整约束见仓库根目录 `AGENTS.md`。

## 技术思路

- 定位:HaminnApp 里的 3D 摆姿 happ。手动摆放人形骨骼造型,把渲染截图交给本地大模型生图。
- 形态:纯原生 HTML / CSS / JavaScript,**没有构建步骤**,源文件直接运行。无框架、无包管理器、无 CDN、无远程字体。
- 3D 内核:`vendor/three/three.min.js`(three.js r147 UMD)与 `vendor/three/OrbitControls.js` 内置随包,不联网加载。
- 本地优先:角色、姿态、生图配置全在本机 happ 隔离数据区,不内置任何平台密钥。生图接口由用户自己填地址。

## 目录结构

```
index.html            入口;只放骨架与资源引用
haminn.json           包清单(schema 2, happId life.airen.posegi)
guid.md               本文件
app/app.js            启动与装配
app/core/             纯逻辑,不碰 DOM 与宿主:namespace / utils / i18n / runtime / rig
app/platform/         haminn.js —— Bridge 与网络的唯一出口
app/services/         store 持久化 / providers 生图接口适配 / image-engine 生图编排
app/components/       viewport 3D 视口 / ui 弹层与提示 / gallery 作品库 / settings 设置
app/features/         poser 摆姿编排 / editor 页面装配 / self-test 自检
app/assets/           随包静态资源(icon.webp 等)
styles/               tokens / base / viewport / components
vendor/three/         内置 three.js 与许可原文
```

不进运行包:`.gitignore` 里的开发残留、`tools/`、`tests/`、`docs/`、`release/`。

## 开发注意

- 依赖方向固定 `core → platform → services → components → features`;不要反向依赖,`core` 里不要出现 `document` 与 `window.haminn`。
- 兼容 Android 10 与旧厂商 WebView(实测等价 Chrome 83):flex 的 `gap` 不生效,flex 行间距用相邻兄弟 `margin`;不用 `?.`、`??`、`||=`;不用 ES Modules 语法。
- 设备 CSS 视口只有 510px 宽,紧凑分支写在 `@media(max-width:520px)`。
- WebGL 必须特性检测:拿不到上下文时给出可读提示并保持页面可用。
- 所有模型请求与文件操作经过 `app/platform/haminn.js`;公网 HTTPS,HTTP 只允许可信局域网。
- 图片字节禁止写入 `haminn.data`,只存文件引用。API Key 只在用户明确保存后落入隔离数据区,界面默认遮罩。
- 姿态数据模型(`app/core/rig.js`)是纯数据:关节名、层级、默认角度、姿态序列化格式。改这里要同步 `tests/rig.test.mjs`。

## 自检

- 改完先跑 `node tools/verify.mjs --source-only`:含清单断言、引用存在性、脚本顺序、禁用语法扫描、跨模块导出检查与纯逻辑测试。
- 需要真机时用 `python3 tools/dev.py --address http://PHONE:8766` 热同步,再用页面状态确认改动生效(页面暴露 `window.posegiDevState.capture()`)。
- 出正式包:`python3 tools/package.py` → 更新 `haminn-install.json` 的 zip 路径与 sha256 → 版本号同步 `haminn.json`、`app/core/namespace.js` 与 `README.md`。
