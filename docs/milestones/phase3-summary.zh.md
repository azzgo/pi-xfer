> 中文版 · 英文原文：[phase3-summary.md](phase3-summary.md)

# Milestone 3 总结 — Release Note 素材

> Milestone:阶段3 — refine mesh 机制 · 目标:mesh 从「文档化但未实战」走向经受住真实部署的检验。
> 状态:全部特性已实现、验证并验收(P0-A / P0-B / P0-D / P1-C 拒绝 / P1-E,另含插入项与两笔修复)。
> 清单见 `docs/milestones/phase3-features.md`,决策记录见 `docs/adr/0019`。

## 已交付

### 状态可见性(P0-A)

- **`mesh list` 四态交付判定** — `●` running / `◐` sleeping(可投递)/ `○` 池内无 runner / `⚠` 记录矛盾,数据来自 `/actors` + `/envoys` 并行(各 6s);runner 缺失时指名池而非节点。`deriveActorStatus` 不再把 `no_envoys` 误判为 Crashed;`listMeshNodes` 补齐 `pool` 连接键。
- **`mesh status`** — 自节点视角的「我现在能不能收」,`up` 与否都可用。

### 对端真实性与发送可靠性(P0-B)

- **硬性预检** — 发送前 `/actors` + `/envoys` 并行校验,池内无 runner 直接拒绝、无 override;一次发送只花一个引擎往返。部署级缓解保留:外来 `xfer-instance` 冒充是文档化的已接受风险(见 ADR 0019)。
- **三态失败分诊** — enqueue 失败按引擎错误码(不是耗时)分诊:`not-delivered`(引擎明拒,可说「没发出去」)/ `unknown`(客户端停止等待,可能已投递——绝不显示「未投递」、绝不建议重试)/ `failed`。两处 enqueue 汇入同一漏斗;`mesh.log` 记 `verdict=` + `code=`,补上「只有错误行无法事后分诊」的缺口。
- **接收侧去重** — actor state 里 3 条滑动窗口,投递后记录(崩溃重做不丢件);重复消息在写 `/tmp` 文档前丢弃,一行 `mesh duplicate` 日志。恢复探针复用原 handoff id,与窗口天然闭合——「报失败却送达」的活体缺口(probe `mvbsq4ja-5dnpgd`)从两头堵死。

### 传输安全(P0-D + P1-C)

- **ADR 0019** — 不提供应用层加密;TLS 是 endpoint scheme 的函数;admin token 是根凭证;操作者拥有传输;部署形态排序:协议级隧道(Tailscale/EasyTier)> TLS 终结边缘。
- **P1-C E2EE 按 ROI 否决** — 逐项比较后最便宜的方案(Tailscale)保护得最多;信封格式、TOFU 窗口、永久维护面不值。外来 actor 冒充转为已接受风险。

### Cloudflare serverless 节点(P1-E)

- **`examples/cf-serverless-node`** — CF Worker(wasm registry)托管 `xfer-instance` actor,桥接 Durable Object 里的一个存根 agent;echo 先行(无 key 可验),DeepSeek 留接缝。闭环在真实部署三次完整验证(发送 → 引擎 → Worker → DO → 原路回信,回信落本地会话)。**不包含 Pi Durable harness** —— agent 那一半是接缝,不是实现(2026-10-22 由 `examples/pi-durable-cf` 改名)。
- **`docs/guides/cf-serverless-node.md`** — 地图式文档页:两层持久化、serverless actor 纪律、排障速查、边界(好目的地/坏源头;止步 round trip)。
- **十条实测发现全部折回文档** — 引擎钉 `2.3.26`、topology `public_url`、自有域名(workers.dev 部分网络不可达)、`request_lifespan`/`drain_grace_period`、configurePool URL 语义、actor sticky error、池卡死用 PUT 踢池等。

### 插入项:配置安全与可用性

- **token 动态求值** — `mesh.config.json` 的 `token`/`namespace` 对齐 pi `models.json` 三形态:字面量 / `$NAME`|`${NAME}` / `!command`(过 shell、运行时求值不缓存,语义与 pi 逐条对拍 18 例一致)。同步解析/异步求值分界:读配置永不 spawn,真正连引擎才求值。安全边界写明:配置文件写入权 = 代码执行权。
- **URL auth 废弃** — `https://ns:token@host` 不再被读取,报错并给出可粘贴的迁移形状(一个 URL 混三个配置要素被判定为设计错误)。
- **JSON Schema** — `mesh.config.schema.json`,`$schema` 指向仓库 raw 地址即得编辑器补全;`parseMeshConfig` 容忍 `$schema` 有测试固化。
- **`!command` cwd 诊断** — 语义保持 shell 的(继承调用方 cwd),但每条失败信息带 cwd/shell/原始 stderr 与处方;exit-0-空输出-有-stderr 不再被吞;`mesh-describer` 不再把连接失败静默降级。

### 修复(里程碑期间)

- `adapterd.test.ts` 四处「只等 socket 文件出现就 connect」竞态(ECONNREFUSED 约 1/8)→ 等待「connect 成功」,75+20 次连跑零复现。
- wrangler.toml 语法(TOML 非 YAML)、`routes` 写在 `[vars]` 后被吞成变量——同一教训咬了两口,`npm run check` 自检入库。

## 关键决策

- **失败必须说真话**:`unknown` 是承重状态——宁说「不知道到没到」,不说「没到」;时间分不出两种失败,只有引擎错误码能。
- **读配置永不执行命令**:同步解析只记形状,异步求值只发生在真正连引擎的路径上。
- **E2EE 拒绝是终局决策**,写进 ADR 0019,无后继文档;重开需新证据。
- **验证永不对真实部署**(AGENTS.md 结构化:mesh-guard + `NODE_TEST_CONTEXT`);唯一例外 P1-E 的闭环,以人工书面流程执行并在 VERIFICATION.md 记录版本与日期。
- **示例不是扩展**:`examples/` 可带 npm 依赖,不进 npm 包、不构成先例;README 只平铺说支持,横幅放文档页。

## 后续 / 推迟

- CF actor 与手机输入源的定时采集/汇总用法 — 属读者自己的 agent 仓库,按规格不写。
- serverless 池被非法配置锤过后会卡死(需 PUT 踢池)— 根因已修(`20fb171`),文档保留排障行以防外部引擎版本差异。
- 引擎版本与 rivetkit 版本的对齐矩阵 — 仅钉 `2.3.26` 一组,跨大版本不承诺。
