> 中文版 · 英文原文：[phase2-design-p0b.md](phase2-design-p0b.md)

# Milestone 2 design — P0-B broker/admin daemon 作为提交的 bundle

## 决定(2026-10-13)

像 `mesh-runtime.cjs` 一样打包 broker 和 admin daemon —— 提交到仓库的构建产物,
配 sha256 新鲜度测试。同时干掉实验性 API 依赖
(`stripTypeScriptTypes` / type stripping)和 `node_modules` 下的 spawn 限制
(事故:`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`,session `pi:01a12af5`)。

## 当前机制(已验证)

- `broker-manager.ts` spawn `node --disable-warning=ExperimentalWarning --import
  ts-resolve-hook.mjs broker-main.ts --port … --xfer-dir …`(detached,继承 log fd)。
- `admin-manager.ts` spawn 同样的形态(`admin-main.ts`);两个 manager 都已接受
  daemon 入口覆盖(测试指向 stub)。
- `broker-main.ts` / `admin-main.ts` 只依赖 node 内置模块 + 同级 `.ts` 文件 ——
  用 esbuild 打包它们不需要外部依赖。
- `build.mjs` 已有这个模式:esbuild CJS bundle、提交产物 +
  `.sha256`、测试中的新鲜度断言(`mesh-bundle.test.ts` /
  `artifact-freshness.test.ts`)。

## 计划

1. **build.mjs**:新增 `buildDaemon(entry, outfile)` —— esbuild,`platform: node`,
   `format: cjs`,`target: node20`(与 mesh-runtime 相同),写出 `broker.cjs` 和
   `admin.cjs`,各带 `.sha256`。`npm run build` 产出四个提交产物。
2. **新鲜度测试**:扩展现有的 artifact-freshness 测试,把两个 daemon 重新构建到临时文件
   并断言字节一致(与 mesh-runtime 相同的漏提交防线)。
3. **managers**:默认 daemon 入口改为 `.cjs` bundle;spawn 去掉
   `--import RESOLVE_HOOK` 和 `--disable-warning=ExperimentalWarning`(不再有任何
   实验性东西)。为测试保留入口覆盖开关。
4. **清理**:daemon 在运行时不再需要 `ts-resolve-hook.mjs`;移除它的 spawn
   用法(扩展侧的测试运行器仍为 `npm test` 使用 `--import` —— 把该文件留在仓库里,
   见打包一节)。
5. **README**:明确写出 Node 要求(bundle 目标 node20;扩展宿主遵循
   pi 自身的要求)。package.json 的 `engines` 与之保持一致。
6. **AGENTS.md**:「两个提交的构建产物」一行改为四个。

## 打包(npm files)—— 对原始诉求的修正

`*.ts` **不能**整体从 npm 包里去掉:pi 在运行时从这些源码加载扩展本身
(`index.ts` 及其同伴)—— 这条路径今天就能用,是 pi 的职责,不是我们的。bundle
能从发布清单里去掉的是:

- `ts-resolve-hook.mjs`(daemon spawn hook)—— 可去掉。
- 其余不变:daemon 入口 `.ts` 文件保留(manager 仍从 `broker-main.ts` import
  `pidAlive`,而且它们记录了 daemon);`.cjs` + `.sha256`
  加入 files 清单。

如果「不发布源码」是硬性要求,那是另一个更大的特性
(发布前把整个扩展编译为 JS)—— 明确 out of scope。

## 涉及范围

`build.mjs`、`broker-manager.ts`、`admin-manager.ts`、`package.json`(files、artifacts)、
新鲜度测试、`README.md`、`AGENTS.md`;新增提交产物 `broker.cjs`、
`admin.cjs`(+ `.sha256` ×2)。

## 风险

- daemon bundle 必须保持字节可复现(esbuild 版本已通过 devDependencies 固定 ——
  与 mesh-runtime 同样的保证)。
- `node .ts`(dev/test)与 `node .cjs`(生产 spawn)之间的行为漂移:
  新鲜度测试加上现有的 daemon 入口覆盖,让测试可以针对真实 bundle 跑一次,
  而不只是针对 stub。
- broker-main 内部的 `import.meta.dirname` 用法在 CJS bundle 里解析结果不同 ——
  esbuild 的 shim 会处理,但切换后应对 status/doctor 的输出路径做一次冒烟检查。
