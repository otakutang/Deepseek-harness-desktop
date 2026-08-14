# DeepSeek Harness Desktop

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 官方代码构建的 Windows 桌面客户端。

DeepSeek Harness 本身是一个 Web GUI（浏览器访问 `http://127.0.0.1:3080`）。本项目用 Electron 给它套了一层原生桌面壳：**不修改、不裁剪官方代码**，只是把官方 Web GUI 装进一个原生窗口，因此官方的全部扩展能力（Host 插件、客户端插件、`__DSH_BOOT__` 引导、Slot 系统、HMR）原样保留。

> 本仓库仅包含桌面壳（`main.mjs` + 打包脚本 + 图标），不含 DeepSeek Harness 源码。构建时 `scripts/bundle-runtime.mjs` 会从官方 checkout 按依赖闭包打包出一份运行时放进安装包。

## 特性

- **原生桌面窗口**：双击启动，窗口加载官方 Web GUI（默认 attach 到已运行的 `dsh web`，否则自动拉起）。
- **托盘常驻**：关窗 = 最小化到托盘，harness 后台继续运行；托盘菜单「检查更新…」手动触发更新。
- **自动更新**：启动后静默检查 GitHub Releases；发现新版本后台下载，下载完成提示「立即重启 / 稍后」，重启后静默升级（保留数据）。
- **扩展能力零改动**：窗口就是普通 Chromium，官方客户端插件照常加载。
- **Key 不进包**：凭据走官方运行时机制（环境变量 / `$DSH_HOME/.credentials.yaml` / `.env`），安装包不含任何 API key。

## 使用

### 直接安装（推荐）

在 [Releases](../../releases) 下载最新 `DSH Desktop Setup x.y.z.exe`，双击安装。首次启动会引导（或自动 attach 到）你本机的 DeepSeek Harness；API key 在 GUI 内配置。

### 从源码构建

要求：Windows、Node ≥ 22.19、pnpm，以及一份已 `pnpm install` + `pnpm run build` 的 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) checkout。

```sh
git clone https://github.com/otakutang/Deepseek-harness-desktop.git
cd Deepseek-harness-desktop
npm install

# 开发模式（直接从官方 checkout 源码拉起）
DSH_REPO=/path/to/deepseek-harness npm start

# 打包安装包（需在官方 checkout 内运行，见下）
npm run dist
```

`bundle-runtime` 通过 `DSH_REPO` 环境变量或脚本内默认的上层目录定位官方 checkout（默认假定本仓库与官方 checkout 为相邻目录，见 `scripts/bundle-runtime.mjs` 顶部）。

## 目录结构

```
main.mjs                  # Electron 主进程：定位 dsh/node → 探测端口 → attach/spawn → 开窗
loading.html              # 启动等待页
electron-builder.yml      # 打包配置（NSIS + GitHub Releases 更新源）
build/icon.png            # 应用图标（DeepSeek 鲸鱼 logo，脚本生成）
scripts/
  bundle-runtime.mjs      # 从官方 checkout 打包 dsh 运行时 + 便携 Node
  generate-icon.mjs       # 渲染鲸鱼图标（官方 FishLogo path）
  publish-update.mjs      # 整理发布产物（latest.yml + 安装包）
```

## 自动更新与发布

更新源为 GitHub Releases（`electron-builder.yml` 的 `publish` 已指向本仓库）。发布新版本：

1. 改 `package.json` 的 `version`（如 `0.1.0` → `0.1.1`）。
2. `npm run dist` 生成安装包与 `latest.yml`。
3. 在 GitHub 上打同名 tag 并创建 Release，上传安装包、`latest.yml` 和 `.blockmap`（`node scripts/publish-update.mjs` 会把它们整理到 `update-staging/`）。

已安装用户下次启动会自动发现并更新。

## 基于官方代码的说明

- 鲸鱼图标来自官方 `FishLogo` 组件（`packages/client/ui-primitives/src/FishLogo.tsx`）的矢量路径，仅重渲染为构建资产；logo 版权归 DeepSeek。
- 运行时打包复用官方自身的依赖闭包算法（`healProfilesModuleFallback` 的 BFS 语义）。
- 桌面壳未改动官方任何源码，兼容性取决于官方版本；升级官方 checkout 后需重新 `npm run dist`。

## 许可证

桌面壳代码沿用 [MIT](LICENSE)。DeepSeek Harness 及其 logo 版权归其各自权利人所有。
