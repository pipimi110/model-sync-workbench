# Windows 单文件 EXE 发布

开发和日常测试继续使用源码启动及现有平台上传逻辑热加载，不调用打包工具。只有准备发布时才打包，并测试生成的成品。

## 一键发布

打包机需要 Windows x64、Node.js 22+，首次准备时在项目目录执行：

```powershell
npm.cmd ci
```

如果 Electron 运行文件缺失，再执行 `npm.cmd run setup-desktop`。首次打包可能下载 NSIS 等构建组件，需要联网。

双击项目根目录 `build-exe.cmd`，或执行：

```powershell
npm.cmd run release
```

流程按顺序执行：

1. 源码语法检查。
2. 全部自动化测试，不向真实平台上传。
3. 构建 Windows x64 免安装 EXE。
4. 自动测试这个 EXE：检查归档内容，单独复制到含中文和空格的目录启动，在隔离的空资料库内验证界面、静态资源、本地接口、文件选择桥接是否存在、导航及导入弹窗，最后正常关闭。

自动测试会短暂打开一个空的 ModelPort 窗口。使用独立资料库，不连接你的 Chrome，不读取开发资料库，也不创建真实上传任务。测试启动时移除 Node/npm 的 PATH，但这不代替在其他干净 Windows 设备上的兼容性验证。

任一步失败，发布命令返回非零退出码，不生成成功报告。成品测试失败时保留诊断目录供排查；不要把失败产物当作已验证的发布版。

## 产物

当前版本输出：

- `dist/ModelPort-0.1.1-win-x64.exe`：需要分发的唯一应用文件。
- `dist/ModelPort-0.1.1-win-x64.exe.sha256`：通过测试后生成的校验文件，可随 EXE 分发。
- `dist/release-smoke.json`：通过测试后生成，记录校验值、检查项目和测试证据目录。
- `dist/win-unpacked/`：打包过程的中间目录，无需分发。
- `artifacts/release-smoke-*/`：隔离成品测试资料、进程日志及截图，无需分发。

文件名中的版本来自 `package.json`。正式发新版前应更新版本，并提交对应的锁文件。

只构建、不测试的内部命令是 `npm.cmd run pack:exe`；已有成品可通过 `npm.cmd run test:exe` 重测。最终交付优先用完整 `release` 流程。

## 收到 EXE 后怎么用

双击 EXE 运行，无需安装 Node.js、npm、Electron 或项目依赖。免安装启动器会将内置运行文件解压到系统临时目录，退出后清理；首次启动需要等待解压。

模型同步仍需要设备安装 Chrome 144+、开启远程调试、批准连接并登录相关平台。EXE 不携带平台账号或开发时的登录信息。

EXE 没有配置代码签名证书。正式对外分发前可另行接入签名；当前流程生成未签名构建。

## 数据与更新

- 源码开发版：继续使用项目内 `.data/`。
- EXE 默认资料库：`%APPDATA%\ModelPort\data\`。
- 两者均可用 `MODEL_SYNC_DATA` 指定独立目录；`MODEL_SYNC_SHELL_DIR` 可单独指定桌面外壳目录。
- EXE 不会自动复制开发版资料库，也不会包含已有模型、任务、日志或截图。
- 更新 EXE 不会改变默认资料库路径。资料不写入 EXE 或解包目录，因此不会随临时运行文件删除。
- 开发版与发布版默认使用不同资料库；不要让两个实例同时指定同一资料库。需要迁移已有资料时，先退出应用并完整备份目录，注意现有素材文件路径可能需要另外处理。

发布配置只打包 `desktop/`、`src/`、`ui/`、`package.json` 和生产依赖。打包依赖属于开发依赖，不进入成品。

## 开发热加载

继续双击 `start.cmd` 或 `npm.cmd start` 运行开发桌面版。目标平台适配器在准备、保存等任务边界按文件内容变化重新加载，保留已有窗口、队列和浏览器连接。没有把发布流程接到热加载或日常修改流程上。

现有热加载并不覆盖所有文件：修改主进程、服务端启动或队列结构等代码仍可能需要重启源码实例。发布 EXE 使用内置代码，更新它需要重新打包并重测。

实现使用 electron-builder 的 [Windows portable 目标](https://www.electron.build/nsis/)，运行数据放在 [ASAR 只读归档](https://www.electronjs.org/docs/latest/tutorial/asar-archives#archives-are-read-only)之外。
