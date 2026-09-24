# PoseGi

Hermit 上的 3D 摆姿 happ:手动摆放 3D 角色的骨骼造型,再把渲染截图交给本地大模型生图。

- 形态:运行在 HermitApp 内的普通 happ(不是 HermitUI),原生 HTML / CSS / JavaScript,没有构建步骤,源文件直接运行。
- 本地优先:角色、姿态、生图全部在本机完成,不内置任何平台密钥。
- 许可:MIT(见 `LICENSE`)。

## 目标能力(尚未实现,当前只有框架)

1. 3D 视口里显示一个人形角色,可旋转、缩放、平移视角。
2. 点选骨骼关节,手动摆出造型;姿态可保存、可套用预设、可左右镜像。
3. 把当前造型渲染成截图,连同提示词提交给本地生图服务。
4. 生图结果回到应用内,可继续以新造型迭代。

## 目录约定

运行包(进 release zip 的只有这些):

```
index.html            入口;只放骨架与资源引用
hermit.json           包清单(schema 2, happId io.github.zhyuzh3d.posegi)
guid.md               给智能体插件读的短说明
app/                  应用代码与静态资源
styles/               样式
vendor/               内置第三方库(three.js r147)
```

开发期才有的东西:

```
AGENTS.md             开发约束(先读这个)
README.md             本文件
tools/                开发与发布脚本
tests/                纯逻辑测试
docs/                 设计与验收记录
release/              打包产物(不进仓库)
```

`app/` 内部分层,依赖方向单向 `core → platform → services → components → features`:

```
core/        纯逻辑,不碰 DOM 与宿主:namespace / utils / i18n / runtime / rig
platform/    hermit.js —— Bridge 与网络的唯一出口
services/    store 持久化 / providers 生图接口适配 / image-engine 生图编排
components/  viewport 3D 视口 / ui 弹层与提示 / gallery 作品库 / settings 设置
features/    poser 摆姿编排 / editor 页面装配 / self-test 自检
assets/      icon.webp 等随包资源
```

## 开发流程(热更新优先)

设备地址与密码见手机 Hermit 的「开发配置」。先在设备开发服务上保存一次密码:

```sh
python3 ~/.workbuddy/skills/hermit-dev-plugin/hermit-agent.py --address http://PHONE:8766 connect
```

之后每次改完代码,一条命令推到设备看效果:

```sh
python3 tools/dev.py --address http://PHONE:8766
```

它包的是 Hermit 智能体开发模式的 `develop-dir`:初始化一次 DEV 工作区,之后持续监听本地改动并按批同步,改一个文件就在手机上看一次,不递增版本号,也不打包。

常用命令:

```sh
node tools/verify.mjs --source-only   # 静态检查与纯逻辑测试
python3 tools/package.py              # 打 release zip(只在要发版时跑)
```

浏览器里直接打开 `index.html` 也能看界面:没有 Hermit Bridge 时 `app/platform/hermit.js` 会退回 `fetch` 与 `localStorage`,只在开发期用作降级路径。

## 状态

框架阶段:目录、清单、工具链、最小可加载入口已就位;3D 渲染、摆姿交互、生图链路都还是空实现,接口与职责已在各文件头部写明。
