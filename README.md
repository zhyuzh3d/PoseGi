# PoseGi

PoseGi 是运行在 [Haminn](https://haminn.airen.life/) 宿主里的 3D 摆姿 happ：在应用内手动摆放人形角色的骨骼造型,再把渲染截图连同提示词交给你自己配置的生图服务出图。

> 官网：<https://posegi.airen.life/> · 源码仓库：<https://github.com/zhyuzh3d/PoseGi> · [下载安装包](https://haminn.airen.life/pages/happs.html#happ-life-airen-posegi) · [GitHub Releases](https://github.com/zhyuzh3d/PoseGi/releases) · [MIT License](./LICENSE)

- happ id：`life.airen.posegi`
- 当前源码版本：`0.1.17`(versionCode `18`,见 `haminn.json`)
- 形态：HaminnApp 的普通 happ,不能脱离宿主单独安装,纯原生 HTML / CSS / JavaScript,没有构建步骤
- 3D 内核：内置 three.js r147(`vendor/three/`,随包分发,不联网加载)

## 特性亮点

- **内置 3D 视口**：用随包的 three.js r147 渲染人形角色,可旋转,缩放,平移视角,打不开 WebGL 时给出可读提示并保持页面可用,不白屏。
- **手动摆姿**：20 多个解剖学关节——骨盆,腰,胸,颈,头,左右肩 / 上臂 / 前臂 / 手 / 大腿 / 小腿 / 脚。每个关节都有自己的可转范围限制(相对静止姿态的增量),例如手腕约 ±80°,脚踝 -50° 至 +25°,膝 -150° 至 0°(单轴铰链,不允许反张)。
- **两套拖拽语义**：点选关节之间的「连接杆」拖动就是**旋转**该关节,点选关节上的「节点」拖动就是 **IK 移动**。视口会按你的选点决定这次拖动是旋转还是移动。
- **独立「自转」滑杆**：绕骨轴自转是拖拽永远碰不到的自由度(转轴就是骨头本身,转动时末端在屏幕上几乎不动),所以用一个常驻滑杆单独控制。
- **自写反向运动学(IK)**：拖手或拖脚时,让整条肢体链跟着动。恰好两节的肢体链(大腿 + 小腿)用**闭式解**,其余(躯干,三节胳膊)用 **CCD**：12 次迭代,单次单关节最多 14°,4mm 容差。自己写的原因和算法细节都写在 `app/core/ik.js` 头部。
- **姿态预设与镜像**：内置站姿,T 字,行走,举手,坐下五个预设,另有镜像与复位,预设按解剖学校正过(例如膝一律向后弯,髋前屈是 +x)。
- **作品管理**：一件作品 = 标题 + 提示词 + 你自己保存的成图。作品列表可浏览,生成弹窗里是这件作品最近的 12 张成图,每张右上角的叉单独删掉那一张(槽位随之空出来),点图片本身全屏预览(双指缩放,拖动平移,双击复位),全屏里也能直接删。顶栏在版本号后面跟着显示当前作品的标题,写不下时末尾自动省略。
- **全屏看图的调色面板**：亮度 / 对比度 / 饱和度 / 色相 / 梦幻辉光 / 清晰度六项(与 HamDraw 的全屏面板逐项相同),参数跟着作品走。清晰度是唯一逐像素的一步,所以它单独缓存、并只在它自己变化时重算 —— 拖其余五项时画面由 GPU 滤镜直接重画,不重算像素。
- **自建「模型卡」生图**：不内置任何平台密钥,生图接口由你自己填。支持四类接口——CHP 插件（ComfyUI Haminn Protocol,推荐）,OpenAI Images 兼容,SD WebUI / Forge,Stability AI。提交的参考图固定 1024 边。
- **按接口该调的才给控件**：参考图强度,超时,自定义请求头 JSON。在 CHP 卡上**画幅与步数由插件的场景定义决定**(协议 `chp/2`,插件 3.0.2),界面上点一次「测试连接」就把插件当前公布的场景,模型文件与画幅读回来 —— 所以这两项是只读显示,不给你调出一个插件不认的值。
- **出好的图不会再丢**(2026-09-30)：CHP 这条路把「提交」和「取结果」分成两次请求,中间隔着几十秒,任何一次网络抖动都可能让一张已经画好的图取不回来。所以这一版做了三件事 —— 提交带**幂等键**(`chp/2` 的 `request_id`),同一次提交重发时服务端还你原来那个作业而不是再多画一张,于是提交也能安全重试了;作业一交出去就把它的 `job id` **写进作品文档**,杀进程,重启手机都还在;等待或取图失败时不再报一句「超时」了事,而是给一个**「重试取回」**——服务端那张图已经画好的话,点一下就拿回来,不必重画。
- **中文描述自动译成英文**：在提交那一刻翻(不是打字时,也不是保存时),译文按句子缓存,同一句只翻一次;配了翻译模型就翻,没配就在输入框标签上补一句「请使用英文,或软件设置中增加翻译模型」。CHP 卡不必翻 —— 插件自己的工作流里带翻译节点。
- **本地优先与隐私**：角色,姿态,生图配置全部保存在本机 happ 的隔离数据区,公网服务必须 HTTPS,可信局域网允许 HTTP。
- **语言与外观**：中英双语(默认跟随系统),锁定深色主题,锁定竖屏。

> 截图位置：此处可放 3D 视口与摆姿结果的真机截图(仓库暂未内置静态截图文件)。

## 安装使用

PoseGi 是 HaminnApp 的 happ,**不能脱离宿主单独安装**。

1. 先安装 Haminn：[下载页](https://haminn.airen.life/pages/download.html)(Android 10 及以上),或到 [Releases](https://github.com/zhyuzh3d/haminnapp/releases) 取 APK。
2. 再添加 PoseGi：打开 [应用广场](https://haminn.airen.life/pages/happs.html) 找到 PoseGi,扫描二维码,或复制它的官方安装清单地址(形如 `https://haminn.airen.life/downloads/happs/<happId>/haminn-install.json`,`<happId>` 以应用广场页面显示的为准),回到 Haminn 点「从网址」粘贴。

## 快速上手

1. 打开 PoseGi,在 3D 视口里旋转,缩放,平移,找到顺手的观察角度。
2. 点关节的「连接杆」拖动旋转(例如抬手臂),点「节点」拖动做 IK 移动(例如把整条腿拉到位),够不到的自由度用底部「自转」滑杆补。
3. 想快速起势就先套一个姿态预设(站姿 / T 字 / 行走 / 举手 / 坐下),需要左右对称时用镜像。
4. 到生图设置里新建一张「模型卡」,填接口地址与参数。用 CHP 插件就在地址后面先点一次「测试连接」——它会报出插件版本,这个场景的模型文件与将要用到的画幅;你能调的是参考图强度(0–200,100 中性)。
5. 写一句提示词(中文也行,提交时会自动译成英文),提交生图,结果回到应用内成为这件作品的成图,可继续以新造型迭代。

## 项目结构

```text
index.html            入口,只放骨架与资源引用
haminn.json           包清单(schema 2,happId life.airen.posegi)
guid.md               写给智能体插件的短说明
app/app.js            启动与装配
app/core/             纯逻辑,不碰 DOM 与宿主:namespace / utils / i18n / runtime / rig / ik / models
app/platform/         haminn.js,宿主能力与网络的唯一出口
app/services/         store 持久化 / providers 生图接口适配 / image-engine 生图编排 / translate / assets
app/components/       viewport 3D 视口 / ui 弹层 / gallery 作品库 / render-preview 成图预览 / settings
app/features/         poser 摆姿编排 / editor 页面装配 / figure / self-test
app/assets/           随包静态资源(icon.webp 等)
styles/               tokens / base / viewport / components
vendor/three/         内置 three.js r147 与许可原文
```

依赖方向固定 `core → platform → services → components → features`,`core` 不碰 DOM 与 `window.haminn`。运行包(发布 ZIP)只包含 `index.html`,`haminn.json`,`guid.md`,`app/`,`styles/` 与 `vendor/`,`tools/`,`tests/`,`docs/`,`release/` 不进运行包。

## 开发与验证

日常迭代优先使用热更新(需要设备开发地址与密码,见手机 Haminn 的「开发配置」)：

```sh
python3 tools/dev.py --address http://PHONE:8766
```

它包的是 Haminn 智能体开发模式的 `develop-dir`：初始化一次 DEV 工作区,之后持续监听本地改动并按批同步,改一个文件就能在手机上看一次,不递增版本号,不打包。

自检与打包：

```sh
node tools/verify.mjs --source-only   # 清单断言,引用存在性,禁用语法扫描,跨模块导出检查与纯逻辑测试
python3 tools/package.py              # 打 release zip(只在要发版时跑)
python3 tools/package.py --check      # 只校验不写入
```

姿态数据模型 `app/core/rig.js` 是纯数据(关节名,层级,默认角度,姿态序列化格式),改这里要同步 `tests/rig.test.mjs`。IK 的纯数学在 `app/core/ik.js`,对应 `tests/ik.test.mjs`。浏览器里直接打开 `index.html` 也能看界面：没有 Haminn Bridge 时 `app/platform/haminn.js` 会退回 `fetch` 与 `localStorage`,仅作开发期降级路径。

## Haminn 家族

**Haminn 家族 —— 一个安卓宿主 + 若干可自由改造的应用**

- **Haminn**(宿主,先装这个)：<https://haminn.airen.life/> · <https://github.com/zhyuzh3d/haminnapp>
- **Chataxi**(多角色 AI 群聊)：<https://chataxi.airen.life/> · <https://github.com/zhyuzh3d/chataxi>
- **HamDraw**(实时 AI 绘图)：<https://hamdraw.airen.life/> · <https://github.com/zhyuzh3d/hamdraw>
- **PoseGi**(3D 摆姿生图)：<https://posegi.airen.life/> · <https://github.com/zhyuzh3d/PoseGi> —— **本仓库**

三个 happ 都必须先装 Haminn 宿主,再在[应用广场](https://haminn.airen.life/pages/happs.html)添加。PoseGi 与 Chataxi,HamDraw 互不依赖,只做相互推荐,生图接口可以复用 HamDraw 的 CHP 插件(ComfyUI Haminn Protocol,规范 `chp/2`,根 `/chp`)方式接入。

## 贡献

欢迎提交 Issue 与 Pull Request。请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)：其中说明了提 Issue / 提 PR 的流程,分支与提交信息风格,如何在本地跑起来与自检,代码风格与红线,以及不要提交哪些内容(API Key,设备开发地址与密码,用户图片等)。

## License

本项目以 [MIT License](./LICENSE) 发布,Copyright (c) 2026 zhyuzh。

内置的 three.js r147 保留其原始 MIT 许可,原文见 `vendor/three/LICENSE`。

## 免责与支持

- PoseGi 不内置任何平台密钥,生图接口由你自己填写并承担相应费用。
- 公网服务必须使用 HTTPS,HTTP 只允许可信局域网地址。
- 遇到问题请到 <https://github.com/zhyuzh3d/PoseGi/issues> 反馈。
