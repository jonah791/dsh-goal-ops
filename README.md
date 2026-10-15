<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 目标生命周期扩展（不改 DSH 核心包）：goal_abandon 放弃原语 —— 以 block + blockedReason.code='abandoned' 承载「主动放弃」，停止自动续跑且原因可辨识
  inject: 'goals','agents','tools'
  tools: goal_abandon
  runtime: host-only
  envDeps: 无
  boundary: **不改 DSH 核心包**（用既有 block 语义承载放弃）；不删除目标（只改 phase）；放弃可反悔（核心 resume 接受 blocked）
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools >=0.1.0-rc.6
-->
# dsh-goal-ops

<p align="center">
  <a href="https://github.com/jonah791/dsh-goal-ops"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-25%20passed-brightgreen" alt="tests">
</p>

**一句话**：给目标补一个「**主动放弃**」原语——`goal_abandon`，**不改 DSH 核心包**。

**为什么值得用**：核心的目标状态机没有「放弃」这个动作（只有 complete / blocked）。但实际工作中「我决定不做了」是一个**真实且需要留痕**的状态——它既不是完成，也不该混进「等外部条件」的 blocked。本插件用 `blocked + blockedReason.code='abandoned'` 承载它：**自动续跑停止**（driver 对 `phase !== 'active'` 直接 return）、**原因可辨识**（与核心的 `model-reported` / `round-limit` 区分开），且**可反悔**（核心的 `update_goal action=resume` 接受 `blocked`）。

## 工具
- `goal_abandon`：放弃当前 goal（不动 DSH 核心包的实现方式：以 goals.block + blockedReason.code='abandoned' 承载放弃语义）。判据：phase 变 blocked 后自动续跑停止（driver 对 phase !== 'active' 直接 return）；放弃原因留在 blockedReason.message，code='abandoned' 与核心的 model-reported / round-limit 可区分。放弃可反悔——核心 update_goal action=resume 接受 blocked。

## 生态契约

> 依据《DSH 插件生态倡议书》三条原则：**组合优先 / 声明清晰 / 兼容优先**。

- **依赖 service**（`inject`）：`goals` · `agents` · `tools` —— 组合行装载时等待这些 service
- **贡献面**：工具 `goal_abandon`；slot 无；service 无
- 组合行 id：`agent-goal-ops`
- **Fabric manifest**：`dsh-plugin.json`（RFC 0001 v0.1 **Draft** 形状）——`id` = `com.jonah791.goal-ops`，required = （无），optional = （无）
- **Fabric 入口**：`src/fabric.ts` → `lib/fabric.js`（骨架，**不依赖 DSH/Cordis**；Fabric SDK 发布后填充实现）

> ⚠ **不是认证**：Fabric 目前只有文档草案（无正式 schema、无 SDK、无 conformance 套件），因此**不得**声称本插件
> 「通过 Fabric 认证」或「已符合 Fabric 标准」。对齐的是 RFC 0001 的 manifest 形状 + 可机械校验的明文规则；
> `dsh-plugin.json` 的 `$schema` 是**自证 draft 的占位**，Phase 0 发布 canonical identifier 后替换。

组合片段（`cordis.patch.yml`）：

```yaml
- insert:
    - id: agent-goal-ops
      name: dsh-goal-ops
      config: {}
```

## 能力边界（诚实声明）

本插件与宿主**同进程、全权限**运行。「能力声明」用于兼容判断、用户确认与审计，**不构成安全沙箱**——不要把它当权限边界。
本插件不导入其他插件或宿主的内部路径（组合优先），也不覆盖别人的内部实现。

### 两个面，别混淆

- **Fabric 契约面**：`dsh-plugin.json` + `src/fabric.ts`（host entrypoint）。这是**前瞻声明**——Fabric 目前只有 RFC Draft，
  没有正式 schema / SDK / conformance 套件，官方 `docs/plugin-development.md` 明示其**尚不能作为依赖或发布目标**；
  `$schema` 是自证 draft 的 `.invalid` 占位（RFC §14-1 未定 canonical identifier），**不是** schema 校验通过，也**不是**认证。
- **DSH/Cordis 面（非标准扩展路径）**：`src/index.ts` + `cordis.patch.yml`——本插件**现在真正可运行**的形态。
  `tools` 不在 Fabric v0.1 的 capability 表内（v0.1 只有 host.info / log / 生命周期取消 + `storage.local` / `commands` / `messages.observe`），
  故这属标准之外的扩展路径：**不得**当作可移植 API，也**不得**成为 Fabric entrypoint 的依赖。

## 构建与挂载

```sh
pnpm build
# 挂载到 web profile（dsh plugin-manager 或 plugin_mount）
```

## 快速开始

**1) 装依赖**：

```jsonc
"dsh-goal-ops": "link:E:/alice/self-plugins/dsh-goal-ops"
```

**2) 挂组合**（⚠ 需 agent 作用域——要拿当前会话的 goal）：

```yaml
- id: agent-goal-ops
  name: dsh-goal-ops
  config: {}
```

**3) 30 秒验证**：在有 active goal 的会话里调 `goal_abandon {reason: "试一下"}` → 应返回 `phase: blocked` 且 `blockedReason.code: abandoned`；随后**自动续跑应停止**（driver 对 `phase !== 'active'` 直接 return）。

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| （见源码 `Config`） | — | 本插件**无必填项** |

## 落盘与自证

**本插件无独立落盘产物**——「放弃」这个动作的痕迹落在**宿主的目标状态**里（`phase` 与 `blockedReason`），可用 `get_goal` 现读。

**判据**：`get_goal` 一条命令答「phase 是什么 / 为什么（`blockedReason.code` 是 `abandoned` 还是 `model-reported` / `round-limit`）」。

## 生效判据与回退

**判据**：行为级——`goal_abandon` 后 `get_goal` 报 `phase: blocked` 且 `code: abandoned`，且**后续不再自动续跑**。
**回退**：① `git revert` + 重建 + 预检重启；② patch 行 `disabled: true`；③ 已放弃的目标可用核心的 `update_goal action=resume` **接回**（放弃可反悔）。

## 测试

```bash
cd self-plugins/dsh-goal-ops && npm test
```

**25 条用例**（跑一次得到）：覆盖 `abandoned` 与 `model-reported` / `round-limit` 的**可区分性** · 无 goal 时的退化路径 · resume 接受 `blocked`（可反悔）· 不改核心包（只走 `goals.block`）。无需网络。

## 设计要点

- **不改 DSH 核心包**：用既有 `block` 语义承载「放弃」——核心升级不需要跟着迁移。
- **语义可辨识**：`blockedReason.code = 'abandoned'` 与核心自己的 `model-reported` / `round-limit` **分得开**——否则「我不想做了」与「等条件」在状态里长得一样。
- **停止自动续跑的判据在核心**：driver 对 `phase !== 'active'` 直接 return ⇒ 不需要本插件额外做任何事。
- **放弃可反悔**：核心的 `update_goal action=resume` 接受 `blocked` ⇒ 留了回头路。

## License

MIT © jonah791

---

本插件属于**爱丽丝 DSH 自研插件生态**（[alice-digital-life](https://github.com/jonah791/alice-digital-life) · 73 个插件 · 8 个模块）：单一职责、独立仓库、独立可用。
