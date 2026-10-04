/**
 * 业务验收：goal_abandon（跑 lib/ 产物，与运行时同源）。
 *
 * 用 **fake ctx**（goals / agents service 可控）—— 零真实 goal、零副作用、可离线跑。
 * 覆盖：工具注册 / 正路径参数透传 / reason 必填 / phase 门 / CAS / 降级不炸 / block 抛错可见。
 * ⚠ 未覆盖（诚实标注）：真实 `ctx.goals` service 的行为 —— 那需要挂载后线上验收（见 docs/semantic.md §8）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const ACTIVE = { id: 'g-1', revision: 3, phase: 'active', objective: '测试目标' }

function harness(over = {}) {
  const tools = new Map()
  const calls = { block: [] }
  // cordis 的 ctx.logger 既可被调用（取子 logger）也可直接 .info ⇒ mock 同时满足两种形状
  const logger = Object.assign(() => logger, { info() {}, warn() {}, error() {}, debug() {} })
  // ⚠ 传 null（不是 undefined）表示「当前会话没有 goal」——用 undefined 会命中默认分支（undefined === undefined）
  const goal = over.goal === undefined ? { ...ACTIVE } : over.goal
  const goals = {
    get: over.getThrows
      ? () => { throw new Error('get 炸了') }
      : () => goal,
    block: (agent, ref, reason) => {
      calls.block.push({ agent, ref, reason })
      if (over.blockThrows) throw new Error('block 炸了')
      return { ...goal, phase: 'blocked', revision: ref.revision + 1, blockedReason: reason }
    },
  }
  const agents = {
    currentInitiator: over.initiatorThrows
      ? () => { throw new Error('agent initiator scope is disposed') }
      : () => (over.noAgent ? undefined : { id: 'session-x' }),
  }
  apply({ tools: { register: (t) => tools.set(t.name, t) }, logger, goals, agents }, { enabled: true })
  return { tools, calls, run: (args) => tools.get('goal_abandon').execute(args) }
}

test('apply 注册 goal_abandon 一个工具', () => {
  const h = harness()
  assert.deepEqual([...h.tools.keys()], ['goal_abandon'])
})

test('正路径：透传 code=abandoned + message=reason，返回 phase=blocked', async () => {
  const h = harness()
  const r = await h.run({ reason: '主线改了，不再追这个目标' })
  assert.equal(r.ok, true)
  assert.equal(r.result.abandoned, true)
  assert.equal(r.result.goal.phase, 'blocked')
  assert.equal(r.result.goal.code, 'abandoned')
  assert.equal(r.result.goal.message, '主线改了，不再追这个目标')
  assert.equal(h.calls.block.length, 1, '必须恰好调一次 block')
  const call = h.calls.block[0]
  assert.equal(call.reason.code, 'abandoned', 'code 是「放弃」的可辨识标记')
  assert.equal(call.reason.message, '主线改了，不再追这个目标')
  assert.deepEqual(call.ref, { id: 'g-1', revision: 3 }, '缺省用当前 id/revision（等价 CAS）')
})

test('尸体样本：reason 空/纯空白 ⇒ 拒绝且【零调用】（防无原因放弃）', async () => {
  for (const reason of ['', '   ', '\n\t']) {
    const h = harness()
    const r = await h.run({ reason })
    assert.equal(r.ok, false, 'reason=' + JSON.stringify(reason) + ' 必须拒绝')
    assert.match(r.result.error, /reason 必填/)
    assert.equal(h.calls.block.length, 0, '拒绝时不得触碰 goal')
  }
  // ⚠ 缺 reason 这条路径由 **harness 参数校验层**拦下（ToolArgsError: missing required property）
  //    ⇒ 走不到本工具的判据。这里断言的是「响亮失败」这件事本身，而不是本工具返回 ok:false。
  const h2 = harness()
  let threw = false
  try {
    await h2.run({})
  } catch (err) {
    threw = true
    assert.match(String(err instanceof Error ? err.message : err), /missing required property "reason"/)
  }
  assert.equal(threw, true, '缺 required 参数必须响亮失败')
  assert.equal(h2.calls.block.length, 0)
})

test('尸体样本：phase 非 active ⇒ 拒绝且零调用（含 hint）', async () => {
  for (const phase of ['blocked', 'complete', 'paused']) {
    const h = harness({ goal: { ...ACTIVE, phase } })
    const r = await h.run({ reason: '随便' })
    assert.equal(r.ok, false, 'phase=' + phase + ' 不可放弃')
    assert.equal(r.result.phase, phase)
    assert.ok(typeof r.result.hint === 'string' && r.result.hint.length > 0, '必须给下一步提示')
    assert.equal(h.calls.block.length, 0)
  }
})

test('尸体样本：CAS 不匹配 ⇒ 拒绝且零调用（防并发错杀）', async () => {
  const h = harness()
  const badRev = await h.run({ reason: 'x', revision: 99 })
  assert.equal(badRev.ok, false)
  assert.match(badRev.result.error, /CAS 不匹配/)
  assert.equal(badRev.result.current.revision, 3, '回报当前值供重试')
  const badId = await h.run({ reason: 'x', goal_id: 'g-other' })
  assert.equal(badId.ok, false)
  assert.equal(h.calls.block.length, 0)
})

test('尸体样本：无 goal ⇒ 拒绝且零调用', async () => {
  const h = harness({ goal: null })
  const r = await h.run({ reason: 'x' })
  assert.equal(r.ok, false)
  assert.match(r.result.error, /没有 goal/)
  assert.equal(h.calls.block.length, 0)
})

test('降级不炸：currentInitiator 抛错 / 返回 undefined ⇒ ok:false + 原因可见', async () => {
  const thrown = harness({ initiatorThrows: true })
  const r1 = await thrown.run({ reason: 'x' })
  assert.equal(r1.ok, false)
  assert.match(r1.result.error, /拿不到当前会话主体/)
  assert.match(r1.result.error, /scope is disposed/, '原始原因必须透出')
  assert.equal(thrown.calls.block.length, 0)

  const none = harness({ noAgent: true })
  const r2 = await none.run({ reason: 'x' })
  assert.equal(r2.ok, false)
  assert.match(r2.result.error, /作用域/)
  assert.equal(none.calls.block.length, 0)
})

test('不静默成功：goals.get 抛错 / goals.block 抛错 ⇒ ok:false 且错误可见', async () => {
  const getter = harness({ getThrows: true })
  const r1 = await getter.run({ reason: 'x' })
  assert.equal(r1.ok, false)
  assert.match(r1.result.error, /读取 goal 失败/)

  const blocker = harness({ blockThrows: true })
  const r2 = await blocker.run({ reason: 'x' })
  assert.equal(r2.ok, false, 'block 失败不得报成功')
  assert.match(r2.result.error, /放弃失败/)
  assert.match(r2.result.error, /block 炸了/)
})

test('enabled=false ⇒ 挂载但不贡献工具（配置被消费）', () => {
  const tools = new Map()
  const logger = Object.assign(() => logger, { info() {}, warn() {}, error() {}, debug() {} })
  apply({ tools: { register: (t) => tools.set(t.name, t) }, logger, goals: {}, agents: {} }, { enabled: false })
  assert.equal(tools.size, 0)
})
