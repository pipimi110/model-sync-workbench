# ModelPort · 模型同步工作台

Windows 本地桌面应用。第一版范围：MakerWorld 模型链接导入、NexPrint 草稿、创想云仅自己可见。公开发布由用户在平台完成。

## 使用文档（第一阶段验收稿）

[文档与验收入口](docs/README.md) · [快速开始](docs/quick-start.zh-CN.md) · [使用手册](docs/user-guide.zh-CN.md) · [故障排查](docs/troubleshooting.zh-CN.md) · [视频脚本](docs/video-script.zh-CN.md)

当前交付为文档与视频脚本初稿，逐步实测、视频成片、离线 HTML 和应用内帮助入口将在分阶段验收后制作。支持边界见[功能核对表](docs/feature-audit.zh-CN.md)。

## 运行

源码运行需要 Node.js 22+ 和 Chrome 144 或更高版本。默认连接设备上的 Chrome 登录会话。发布的单文件 EXE 不需要 Node.js，见[Windows 打包与发布](docs/packaging.zh-CN.md)。

```powershell
npm.cmd install --registry=https://registry.npmjs.org
npm.cmd run setup-desktop
npm.cmd start
```

依赖安装完成后可双击 `start.cmd`。开发预览：`npm.cmd run dev`，默认只监听 `http://127.0.0.1:4317`。开发预览可输入本机文件路径；桌面版使用文件选择器。

## 打包发布

开发和开发测试继续使用现有热加载流程。准备发布时双击 `build-exe.cmd`，或执行 `npm.cmd run release`，依次检查源码、运行测试、构建免安装 EXE，并验证生成的成品。

产物为 `dist/ModelPort-0.1.1-win-x64.exe`，只需分发这个 EXE。通过成品测试后还会生成 SHA-256 校验文件和 `dist/release-smoke.json` 验证报告。EXE 默认资料库为 `%APPDATA%\ModelPort\data\`，不包含开发资料和平台账号。[完整说明](docs/packaging.zh-CN.md)。

## 使用

1. 在 Chrome 144+ 中为默认配置启用远程调试，然后在 ModelPort“平台与账号”点击“连接默认 Chrome”。ModelPort 使用 Chrome 默认配置中的登录会话，不读取或填写密码。
2. 在工作台粘贴 MakerWorld 模型链接。应用会在默认 Chrome 中打开页面，读取标题、说明、许可、图片和打印配置，并下载页面提供的素材。若平台要求验证，请在 Chrome 页面按平台正常流程处理；工具不会绕过验证。
3. 核对模型资料、全部打印配置、许可和创作类型。ModelPort 的开发者署名和版权声明显示在“平台与账号”页面。为图片指定实拍、渲染或示意用途并选择封面，因为这些信息无法可靠地仅凭图片地址判定。
4. 选择目标平台并查看预览。工具准备表单后，展示平台声明及待保存表单供你确认；NexPrint 保存草稿，创想云保存为仅自己可见。公开发布仍由你手动完成。
5. 完成后查看作品链接和截图。失败或提交结果不明时先核对平台，再重试或记录已有作品。

模型和同步任务删除时可选择“放入回收站”或“彻底删除”。回收站保留记录和文件，可恢复；彻底删除需确认，并清理相应的本地模型文件或任务专用截图。模型资料内可永久删除单份 3MF 配置；图片删除也始终为永久删除，均需确认并在“保存资料”后执行。应用不提供图片回收站。共用文件、导入前的本地原件和目标平台作品保留。[操作说明](docs/user-guide.zh-CN.md#删除图片和批量确认实拍)。

## 当前能力与边界

- 本地资料库原子保存，按来源模型与目标平台去重。当前按一套默认 Chrome 账号使用；切换账号前应建立独立工作空间，第一版不支持多账号混合队列。
- 自动接收 MakerWorld 页面中识别出的每份打印配置 3MF，校验文件后存入本地资料库；图片按实际文件头判断格式。
- MakerWorld 来源直接通过默认 Chrome 会话读取。若未启用远程调试或页面触发平台验证，采集会暂停并显示原因。
- 默认 Chrome 远程调试会让本地应用访问该配置中的已登录页面数据；请只对信任的应用开放。ModelPort 仅在处理你添加的模型链接及同步任务时操作页面。
- 两个目标平台的自动填表属于试运行，需要真实账号逐项联调。字段或许可不能唯一识别会停止；不猜选项、不绕过验证，也不把局部上传标为成功。
- 创想云一份主配置与其余原始附件分别记录，平台转换后的切片参数仍需核对。
- 浏览器表单不会跨应用重启可靠恢复；重启后相关任务转为“需要处理”，先核对平台，避免重复作品。素材与任务记录仍在。
- 保存结果核验：NexPrint 在草稿箱匹配标题；创想云核对提交前私密选项及提交后的详情页。后台审核/配置验证状态与保存状态分别看待。

源码桌面与开发预览默认使用项目内 `.data/`，发布 EXE 默认使用 `%APPDATA%\ModelPort\data\`。可通过 `MODEL_SYNC_DATA` 指定独立工作空间。同一工作空间只能由一个实例使用。目录含模型、任务记录、日志和截图，勿提交到公开仓库；站点登录状态由默认 Chrome 配置维护。

## 开发验证

```powershell
npm.cmd run check
npm.cmd test
```

测试覆盖来源链接、许可区分、3MF/图片识别、队列去重、声明一致性、资料变化、中断恢复、不确定提交与本地接口隔离。测试不会登录或向真实平台上传。

实现参考：[Electron 隔离](https://www.electronjs.org/docs/latest/tutorial/context-isolation)、[Electron 安全](https://www.electronjs.org/docs/latest/tutorial/security/)、[Playwright 浏览器上下文](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)。
