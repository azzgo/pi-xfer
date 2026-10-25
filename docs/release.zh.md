> 中文版 · 英文原文：[release.md](release.md)

# 发布指南

如何把 pi-xfer 的新版本发到 npm。流程由 tag 驱动：GitHub Actions workflow
（`.github/workflows/publish.yml`）在每次推送 `v*` tag 时发布。

## 发布之前

1. 所有改动都已提交到 `main`，且 `npm test` 全绿。
2. 构建产物是最新的：如果改过 `web-picker.src/` 或 `mesh-runtime.src/`，
   运行 `npm run build` 并提交 `dist/web-picker.user.js` 与
   `dist/mesh-runtime.cjs` + `.sha256`。

## 步骤

1. **升版本**：改 `package.json` 并提交：

   ```bash
   npm version patch   # or minor / major
   ```

   `npm version` 一步完成更新 `package.json`、提交、创建 `vX.Y.Z`
   tag。publish workflow 会校验 tag 与 `package.json` 的版本是否一致，
   不一致即中止，所以永远不要只手改其中一边。

   如果你动过 `dependencies` / `peerDependencies` / `devDependencies`，
   先跑 `npm install` 让 `package-lock.json` 同步——CI 里的 `npm ci`
   会因为 lockfile 过期而失败。

2. **把分支和 tag 一起推送**：

   ```bash
   git push origin main --follow-tags
   ```

3. **盯 workflow**：见
   `https://github.com/azzgo/pi-xfer/actions` —— 它依次跑 `npm ci`、
   `npm test`、tag/版本检查，然后 `npm publish --provenance`。

## 发布之后

用户这样升级：

```bash
pi update --extensions
```

（或用 `pi install npm:pi-xfer` 重装。）

## 包清单要求

`package.json` 必须保证扩展从 npm 安装后仍能加载：

- `"pi": { "extensions": ["./index.ts"] }` —— 没有 `pi` 清单时，pi
  只会在约定目录（`extensions/` …）里发现扩展，根目录的 `index.ts`
  永远不会被加载。
- 由宿主提供的包（`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、
  `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`）声明为
  `peerDependencies`，范围为 `"*"`——绝不做 `dependencies`，绝不打包进去。
- `files` 必须覆盖扩展导入的每一个模块，外加 daemon 源码（`daemon/*.ts`）和
  已入库的 `dist/` bundle。漏掉一个条目在仓库树里是看不见的——`daemon/` 就曾漏过——
  它只在 npm 安装后表现为 `Cannot find module`，此后扩展永远不会注册它的 flag，
  `pi --xfer <name>` 会报 `Unknown option: --xfer`。
  `src/package-files.test.ts` 会遍历导入图，任何缺口都会失败。
