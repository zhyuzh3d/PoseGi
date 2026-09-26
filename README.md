# PoseGi

PoseGi 是运行在 [Hermit](https://hermit.airen.life/) 宿主里的 3D 摆姿 happ：在应用内手动摆放人形角色的骨骼造型,再把渲染截图连同提示词交给你自己配置的生图服务出图。

> 官网：<https://posegi.airen.life/> · 源码仓库：<https://github.com/zhyuzh3d/PoseGi> · [下载安装包](https://hermit.airen.life/pages/happs.html#happ-life-airen-posegi) · [GitHub Releases](https://github.com/zhyuzh3d/PoseGi/releases) · [MIT License](./LICENSE)

- happ id：`life.airen.posegi`
- 当前源码版本：`0.1.2`(versionCode `4`,见 `hermit.json`)
- 形态：HermitApp 的普通 happ,不能脱离宿主单独安装,纯原生 HTML / CSS / JavaScript,没有构建步骤
- 3D 内核：内置 three.js r147(`vendor/three/`,随包分发,不联网加载)

## 特性亮点

- **内置 3D 视口**：用随包的 three.js r147 渲染人形角色,可旋转,缩放,平移视角,打不开 WebGL 时给出可读提示并保持页面可用,不白屏。
- **手动摆姿**：20 多个解剖学关节——骨盆,腰,胸,颈,头,左右肩 / 上臂 / 前臂 / 手 / 大腿 / 小腿 / 脚。每个关节都有自己的可转范围限制(相对静止姿态的增量),例如手腕约 ±80°,脚踝 -50° 至 +25°,膝 -150° 至 0°(单轴铰链,不允许反张)。
- **两套拖拽语义**：点选关节之间的「连接杆」拖动就是**旋转**该关节,点选关节上的「节点」拖动就是 **IK 移动**。视口会按你的选点决定这次拖动是旋转还是移动。
- **独立「自转」滑杆**：绕骨轴自转是拖拽永远碰不到的自由度(转轴就是骨头本身,转动时末端在屏幕上几乎不动),所以用一个常驻滑杆单独控制。
- **自写反向运动学(IK)**：拖手或拖脚时,让整条肢体链跟着动。恰好两节的肢体链(大腿 + 小腿)用**闭式解**,其余(躯干,三节胳膊)用 **CCD**：12 次迭代,单次单关节最多 14°,4mm 容差。自己写的原因和算法细节都写在 `app/core/ik.js` 头部。
- **姿态预设与镜像**：内置站姿,T 字,行走,举手,坐下五个预设,另有镜像与复位,预设按解剖学校正过(例如膝一律向后弯,髋前屈是 +x)。
- **作品管理**：一件作品 = 标题 + 提示词 + 你自己保存的成图。作品列表可浏览,成图支持全屏预览(双指缩放,拖动平移,双击复位),并可直接删除。
- **自建「模型卡」生图**：不内置任何平台密钥,生图接口由你自己填。支持四类接口——ComfyUI VibeDraw 插件(推荐),OpenAI Images 兼容,SD WebUI / Forge,Stability AI。提交的参考图固定 1024 边。
- **可调生图参数**：参考图强度,生成分辨率,步数,超时,自定义请求头 JSON,并可自动「翻译为英文」后再提交。
- **本地优先与隐私**：角色,姿态,生图配置全部保存在本机 happ 的隔离数据区,公网服务必须 HTTPS,可信局域网允许 HTTP。
- **语言与外观**：中英双语(默认跟随系统),锁定深色主题,锁定竖屏。

> 截图位置：此处可放 3D 视口与摆姿结果的真机截图(仓库暂未内置静态截图文件)。

## 安装使用

PoseGi 是 HermitApp 的 happ,**不能脱离宿主单独安装**。

1. 先安装 Hermit：[下载页](https://hermit.airen.life/pages/download.html)(Android 10 及以上),或到 [Releases](https://github.com/zhyuzh3d/hermitapp/releases) 取 APK。
2. 再添加 PoseGi：打开 [应用广场](https://hermit.airen.life/pages/happs.html) 找到 PoseGi,扫描二维码,或复制它的官方安装清单地址(形如 `https://hermit.airen.life/downloads/happs/<happId>/hermit-install.json`,`<happId>` 以应用广场页面显示的为准),回到 Hermit 点「从网址」粘贴。

## 快速上手

1. 打开 PoseGi,在 3D 视口里旋转,缩放,平移,找到顺手的观察角度。
2. 点关节的「连接杆」拖动旋转(例如抬手臂),点「节点」拖动做 IK 移动(例如把整条腿拉到位),够不到的自由度用底部「自转」滑杆补。
3. 想快速起势就先套一个姿态预设(站姿 / T 字 / 行走 / 举手 / 坐下),需要左右对称时用镜像。
4. 到生图设置里新建一张「模型卡」,填接口地址与参数,选好参考图强度,分辨率与步数。
5. 写一句提示词(可自动翻译为英文),提交生图,结果回到应用内成为这件作品的成图,可继续以新造型迭代。

## 项目结构

```text
index.html            入口,只放骨架与资源引用
hermit.json           包清单(schema 2,happId life.airen.posegi)
guid.md               写给智能体插件的短说明
app/app.js            启动与装配
app/core/             纯逻辑,不碰 DOM 与宿主:namespace / utils / i18n / runtime / rig / ik / models
app/platform/         hermit.js,宿主能力与网络的唯一出口
app/services/         store 持久化 / providers 生图接口适配 / image-engine 生图编排 / translate / assets
app/components/       viewport 3D 视口 / ui 弹层 / gallery 作品库 / render-preview 成图预览 / settings
app/features/         poser 摆姿编排 / editor 页面装配 / figure / self-test
app/assets/           随包静态资源(icon.webp 等)
styles/               tokens / base / viewport / components
vendor/three/         内置 three.js r147 与许可原文
```

依赖方向固定 `core → platform → services → components → features`,`core` 不碰 DOM 与 `window.hermit`。运行包(发布 ZIP)只包含 `index.html`,`hermit.json`,`guid.md`,`app/`,`styles/` 与 `vendor/`,`tools/`,`tests/`,`docs/`,`release/` 不进运行包。

## 开发与验证

日常迭代优先使用热更新(需要设备开发地址与密码,见手机 Hermit 的「开发配置」)：

```sh
python3 tools/dev.py --address http://PHONE:8766
```

它包的是 Hermit 智能体开发模式的 `develop-dir`：初始化一次 DEV 工作区,之后持续监听本地改动并按批同步,改一个文件就能在手机上看一次,不递增版本号,不打包。

自检与打包：

```sh
node tools/verify.mjs --source-only   # 清单断言,引用存在性,禁用语法扫描,跨模块导出检查与纯逻辑测试
python3 tools/package.py              # 打 release zip(只在要发版时跑)
python3 tools/package.py --check      # 只校验不写入
```

姿态数据模型 `app/core/rig.js` 是纯数据(关节名,层级,默认角度,姿态序列化格式),改这里要同步 `tests/rig.test.mjs`。IK 的纯数学在 `app/core/ik.js`,对应 `tests/ik.test.mjs`。浏览器里直接打开 `index.html` 也能看界面：没有 Hermit Bridge 时 `app/platform/hermit.js` 会退回 `fetch` 与 `localStorage`,仅作开发期降级路径。

## Hermit 家族

**Hermit 家族 —— 一个安卓宿主 + 若干可自由改造的应用**

- **Hermit**(宿主,先装这个)：<https://hermit.airen.life/> · <https://github.com/zhyuzh3d/hermitapp>
- **chataxi**(多角色 AI 群聊)：<https://chataxi.airen.life/> · <https://github.com/zhyuzh3d/chataxi>
- **VibeDraw**(实时 AI 绘图)：<https://vibedraw.airen.life/> · <https://github.com/zhyuzh3d/vibedraw>
- **PoseGi**(3D 摆姿生图)：<https://posegi.airen.life/> · <https://github.com/zhyuzh3d/PoseGi> —— **本仓库**

三个 happ 都必须先装 Hermit 宿主,再在[应用广场](https://hermit.airen.life/pages/happs.html)添加。PoseGi 与 chataxi,VibeDraw 互不依赖,只做相互推荐,生图接口可以复用 VibeDraw 的 ComfyUI VibeDraw Plugin(CVP)方式接入。

## 贡献

欢迎提交 Issue 与 Pull Request。请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)：其中说明了提 Issue / 提 PR 的流程,分支与提交信息风格,如何在本地跑起来与自检,代码风格与红线,以及不要提交哪些内容(API Key,设备开发地址与密码,用户图片等)。

## License

本项目以 [MIT License](./LICENSE) 发布,Copyright (c) 2026 zhyuzh。

内置的 three.js r147 保留其原始 MIT 许可,原文见 `vendor/three/LICENSE`。

## 免责与支持

- PoseGi 不内置任何平台密钥,生图接口由你自己填写并承担相应费用。
- 公网服务必须使用 HTTPS,HTTP 只允许可信局域网地址。
- 遇到问题请到 <https://github.com/zhyuzh3d/PoseGi/issues> 反馈。
