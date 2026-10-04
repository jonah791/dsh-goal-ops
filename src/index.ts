/**
 * dsh-goal-ops：目标生命周期扩展（**不改 DSH 核心包**）。
 *
 * 提供 `goal_abandon` 放弃原语：核心的 `update_goal` 只有 complete / blocked 两个终态，
 * 「主动放弃」无处表达。本插件以 `goals.block(ref, { code: 'abandoned', message })` 承载它 ——
 * 用**自定义 code** 在既有 `blocked` 相位里区分语义，不新增相位（那要改核心）。
 *
 * 为什么这样就够（源码判据，非推断）：
 *   · `GoalBlockReason.code` 是自由字符串（`goal/src/types.ts:52`），投影 schema 亦接受任意 code；
 *   · `GoalService.block()` 的契约即「mark blocked **and disarm it**」（`goal/src/index.ts:409`）；
 *   · driver 在 `goal-round-driver/src/index.ts:165` 硬判 `goal.phase !== 'active' || activation !== 'armed' → return`
 *     ⇒ 放弃后**自动续跑停止**；
 *   · `resume` 的 resumable 含 `blocked`（`goal/src/index.ts:368`）⇒ 放弃**可反悔**。
 *
 * 边界（诚实标注）：phase 仍是 `blocked`（四态枚举在核心，插件加不了第五态）；
 * 「放弃」与核心的 `model-reported` / `round-limit` 靠 `blockedReason.code` 区分。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'agent-goal-ops'
export const inject = ['goals', 'agents', 'tools'] as const

export interface Config {
  enabled: boolean
}
export const Config = z.object({
  enabled: z.boolean().default(true),
})

/** 核心 goal 视图（只声明本插件用到的字段；跨包不 import ⇒ 版本解耦） */
interface GoalViewLoose {
  id: string
  revision: number
  phase: string
  objective: string
  blockedReason?: { code: string; message: string }
}

/**
 * 宽松读取核心 service —— 形状由核心消费方的实际用法界定
 * （`tool-goal/src/index.ts` 的 `ctx.goals.get/create/edit/pause/resume/complete/block`
 * 与 `ctx.agents.currentInitiator()`），不 import 核心包以免版本耦合。
 */
interface GoalOpsServices {
  goals: {
    get(agent: unknown): GoalViewLoose | undefined
    block(agent: unknown, ref: { id: string; revision: number }, reason: { code: string; message: string }): GoalViewLoose
  }
  agents: { currentInitiator(): unknown }
}

/** `catch` 里拿到的永远是 unknown —— 必须窄化才能取 message。 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function apply(ctx: Context, config: Config): void {
  // enabled 必须在 apply() 里被消费：显式 false 时挂载但不贡献任何工具。
  // 只认 === false（未配置 / undefined 视为启用），避免把「没写」误判成「关掉」。
  if (config.enabled === false) return
  const logger = ctx.logger('agent-goal-ops')
  const svc = ctx as unknown as GoalOpsServices

  ctx.tools.register(defineTool({
    name: 'goal_abandon',
    description: '放弃当前 goal（不改 DSH 核心包：以 goals.block + blockedReason.code=\'abandoned\' 承载「主动放弃」语义）。判据：phase 变 blocked 后自动续跑停止（driver 对 phase !== \'active\' 直接 return），且已 disarm；放弃原因写入 blockedReason.message，code=\'abandoned\' 与核心的 model-reported / round-limit 可区分。放弃可反悔 —— 核心 update_goal action=resume 接受 blocked。',
    parameters: {
      reason: { type: 'string', required: true, description: '放弃原因（必填，写入 blockedReason.message）' },
      goal_id: { type: 'string', description: '目标 id（缺省=当前会话的 goal）' },
      revision: { type: 'number', description: 'CAS revision（缺省=当前 goal 的 revision）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, result: { type: 'json', required: true } },
      },
      render: (_a, v) => {
        const r = (v.result ?? {}) as { error?: string; abandoned?: boolean; goal?: { id?: string; phase?: string; code?: string; message?: string }; note?: string }
        if (!v.ok) return [{ type: 'text', text: '✗ ' + (r.error ?? '失败') }]
        const g = r.goal ?? {}
        return [{ type: 'text', text: `已放弃 ${g.id} [${g.phase}] code=${g.code} — ${g.message ?? ''}\n${r.note ?? ''}` }]
      },
    },
    // 出参 JSON-safe 归一：各分支形状不同、可选字段推断为 undefined（JsonValue 索引签名不收）⇒ 显式 any，
    // 运行时形状由 output.schema（additionalProperties:false）兜底校验。
    async execute(args): Promise<any> {
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      if (reason === '') {
        return { ok: false, result: { error: 'reason 必填：放弃必须留下原因（写入 blockedReason.message）' } }
      }

      let agent: unknown
      try {
        agent = svc.agents.currentInitiator()
      } catch (err) {
        return { ok: false, result: { error: '拿不到当前会话主体：' + messageOf(err) } }
      }
      if (!agent) {
        return { ok: false, result: { error: '当前不在任何会话主体作用域内，无法定位 goal' } }
      }

      let current: GoalViewLoose | undefined
      try {
        current = svc.goals.get(agent)
      } catch (err) {
        return { ok: false, result: { error: '读取 goal 失败：' + messageOf(err) } }
      }
      if (!current) {
        return { ok: false, result: { error: '当前会话没有 goal（先用核心 create_goal 建一个）' } }
      }

      // CAS：缺省用当前值，显式给了就必须与当前一致（防并发下的错杀）
      const id = typeof args.goal_id === 'string' && args.goal_id !== '' ? args.goal_id : current.id
      const given = typeof args.revision === 'number' && Number.isSafeInteger(args.revision) && args.revision > 0
        ? args.revision
        : null
      const revision = given === null ? current.revision : given
      if (id !== current.id || revision !== current.revision) {
        return {
          ok: false,
          result: {
            error: 'CAS 不匹配：goal_id/revision 与当前不符（先 get_goal 取最新再重试）',
            current: { id: current.id, revision: current.revision, phase: current.phase },
          },
        }
      }

      if (current.phase !== 'active') {
        const hint = current.phase === 'blocked'
          ? '它已经是 blocked：若 blockedReason.code=abandoned 则此前已放弃过；要重启用核心 update_goal action=resume（resumable 含 blocked）'
          : 'paused 用核心 update_goal action=resume；complete 是终态（都不可放弃）'
        return { ok: false, result: { error: '只有 active 的 goal 可放弃；当前 phase=' + current.phase, phase: current.phase, hint } }
      }

      let view: GoalViewLoose
      try {
        view = svc.goals.block(agent, { id, revision }, { code: 'abandoned', message: reason })
      } catch (err) {
        return { ok: false, result: { error: '放弃失败：' + messageOf(err) } }
      }

      return {
        ok: true,
        result: {
          abandoned: true,
          goal: {
            id: view.id,
            revision: view.revision,
            phase: view.phase,
            objective: view.objective,
            code: view.blockedReason ? view.blockedReason.code : null,
            message: view.blockedReason ? view.blockedReason.message : null,
          },
          note: '已停止自动续跑（phase=blocked 且已 disarm）；反悔用核心 update_goal action=resume',
        },
      }
    },
  }))

  logger.info('goal-ops 就绪：goal_abandon 已注册')
}
