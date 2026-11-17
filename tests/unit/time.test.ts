import { describe, expect, it } from 'vitest'
import { DEFAULT_REST, taskTotals, type Plan, type Task } from '../../src/shared/domain'
import { inputSchemas } from '../../src/shared/schemas'
import { HOUR, countdown, duration, metrics, parseLocal, planRestIndex, restIndex } from '../../src/shared/time'

const zone = 'Asia/Shanghai'
const ny = 'America/New_York'
const at = (day: number, time: string) => parseLocal(`2026-11-${day}T${time}`, zone)
const rule = (startLocal: string, endLocal: string) => ({ label: '休息', enabled: true, startLocal, endLocal })
const plan: Plan = {
  id: '1', title: '本周产品上线', startedAtMs: at(16, '09:00'), deadlineAtMs: at(20, '18:00'),
  timeZone: zone, state: 'active', deductRest: true, archivedAtMs: null, revision: 1, updatedAtMs: 0
}
const index = planRestIndex(plan, DEFAULT_REST)
const hours = (value: ReturnType<typeof metrics>) =>
  [value.natural, value.usable, value.today, value.elapsed].map(ms => ms / HOUR)

describe('时间口径', () => {
  it('T01 固定样例', () => {
    expect(hours(metrics(plan, at(16, '15:30'), index))).toEqual([98.5, 48.5, 6.5, 5])
  })
  it('T02 关闭休息扣除', () => {
    const noRest = restIndex(plan.startedAtMs, plan.deadlineAtMs, zone, [])
    expect(hours(metrics(plan, at(16, '15:30'), noRest))).toEqual([98.5, 98.5, 8.5, 6.5])
  })
  it.each([
    ['T03', 16, '11:30', 16, '14:00', DEFAULT_REST, 1],
    ['T04', 16, '12:00', 16, '13:30', DEFAULT_REST, 0],
    ['T05', 16, '21:00', 17, '10:00', DEFAULT_REST, 2],
    ['T06', 17, '00:00', 17, '10:00', DEFAULT_REST, 1],
    ['T07', 16, '11:00', 16, '15:00', [rule('12:00', '13:30'), rule('13:00', '14:00')], 2],
    ['T08', 16, '11:00', 16, '15:00', [rule('12:00', '13:00'), rule('13:00', '14:00')], 2],
    ['T15', 16, '00:00', 17, '00:00', [rule('00:00', '14:00'), rule('13:00', '01:00')], 0]
  ] as const)('%s 按真实时间计算休息并集', (_, day, start, finalDay, end, rules, expected) => {
    const a = at(day, start)
    const b = at(finalDay, end)
    expect(restIndex(a, b, zone, [...rules]).usable(a, b) / HOUR).toBe(expected)
  })
  it.each([
    ['T09a', '12:15', 16, '18:00', [5.75, 4.5, 4.5, 3]],
    ['T09b', '12:45', 16, '18:00', [5.25, 4.5, 4.5, 3]],
    ['T10', '15:30', 16, '17:00', [1.5, 1.5, 1.5, 5]],
    ['T11', '21:30', 17, '08:00', [10.5, 0.5, 0.5, 11]],
    ['T12a', '17:00', 16, '17:00', [0, 0, 0, 6.5]],
    ['T12b', '17:30', 16, '17:00', [0, 0, 0, 6.5]],
    ['T13', '23:00', 17, '10:00', [11, 1, 0, 11.5]]
  ] as const)('%s 今日可用与已过去', (_, now, day, end, expected) => {
    const deadlineAtMs = at(day, end)
    const current = { ...plan, deadlineAtMs }
    expect(hours(metrics(current, at(16, now), planRestIndex(current, DEFAULT_REST)))).toEqual(expected)
  })
  it('从当天 9 点起算并扣除计划创建前的休息', () => {
    const current = { ...plan, startedAtMs: at(16, '14:00') }
    expect(metrics(current, at(16, '15:30'), planRestIndex(current, DEFAULT_REST)).elapsed).toBe(5 * HOUR)
  })
  it.each([
    [17, '00:00', 0],
    [17, '08:59', 0],
    [17, '09:00', 0],
    [17, '11:00', 2],
    [20, '20:00', 7.5],
    [21, '11:00', 0]
  ] as const)('每天重新累计已过去时间（%s 日 %s）', (day, time, expectedHours) => {
    expect(metrics(plan, at(day, time), index).elapsed).toBe(expectedHours * HOUR)
  })
  it('T14 休息起止相同校验失败', () => {
    expect(inputSchemas['rest:replace'].safeParse({
      planId: crypto.randomUUID(), expectedRevision: 1, deductRest: true, rules: [rule('12:00', '12:00')]
    }).success).toBe(false)
  })
  it('T16 关闭午休后整个周期重算', () => {
    const nightOnly = restIndex(plan.startedAtMs, plan.deadlineAtMs, zone, [DEFAULT_REST[1]])
    expect(hours(metrics(plan, at(16, '15:30'), nightOnly))).toEqual([98.5, 54.5, 6.5, 6.5])
  })
  it('T17 重新取样当前时间', () => {
    expect(hours(metrics(plan, at(16, '16:30'), index))).toEqual([97.5, 47.5, 5.5, 6])
  })
  it.each([['T18', '2026-03-08', '2026-03-09', 23], ['T19', '2026-11-01', '2026-11-02', 25]])(
    '%s 夏令时转换日', (_, day, next, dayHours) => {
      const a = parseLocal(`${day}T00:00`, ny)
      const b = parseLocal(`${next}T00:00`, ny)
      const current = { ...plan, startedAtMs: a, deadlineAtMs: b, timeZone: ny }
      expect(hours(metrics(current, a, restIndex(a, b, ny, [])))).toEqual([dayHours, dayHours, dayHours, 0])
      expect(restIndex(a, b, ny, [rule('00:00', '04:00')]).usable(a, b) / HOUR).toBe(20)
    }
  )
  it('拒绝用户输入的夏令时歧义，循环休息按兼容策略展开', () => {
    expect(() => parseLocal('2026-03-08T02:15', ny)).toThrow()
    expect(() => parseLocal('2026-11-01T01:15', ny)).toThrow()
    const a = parseLocal('2026-03-08T00:00', ny)
    const b = parseLocal('2026-03-08T04:00', ny)
    expect(restIndex(a, b, ny, [rule('02:15', '03:45')]).usable(a, b) / HOUR).toBe(2.5)
    expect(restIndex(a, b, ny, [rule('02:45', '03:15')]).usable(a, b) / HOUR).toBe(3)
  })
  it('本地日历跳过整日时仍按实际时间扣除跨午夜休息', () => {
    const apia = 'Pacific/Apia'
    const a = parseLocal('2011-12-29T21:00', apia)
    const b = parseLocal('2011-12-31T10:00', apia)
    expect((b - a) / HOUR).toBe(13)
    expect(restIndex(a, b, apia, [rule('22:00', '09:00')]).usable(a, b) / HOUR).toBe(2)
  })
  it('T25 时钟回拨到创建前一天', () => {
    const result = metrics(plan, at(15, '21:00'), index)
    expect(result).toMatchObject({ clockBack: true, today: 0, elapsed: 0 })
    expect(result.usable).toBe(index.usable(plan.startedAtMs, plan.deadlineAtMs))
  })
  it('显示时按指标规则舍入', () => {
    expect(countdown(1).seconds).toBe('01')
    expect(duration(59_999)).toBe('小于 1 分钟')
    expect(duration(60_001, 'up')).toBe('2分钟')
    expect(duration(65 * HOUR + 59_999)).toBe('65小时')
    expect(duration(7 * HOUR + 6 * 60_000)).toBe('7小时06分')
  })
})

describe('任务完成进度', () => {
  const task = (status: Task['status'] = 'todo', deletedAtMs: number | null = null) =>
    ({ status, deletedAtMs }) as Task
  it('按任务状态计算进度，排除已删除任务', () => {
    const tasks = [task(), task('done'), task('done', 1)]
    expect(taskTotals(tasks)).toEqual({ total: 2, completed: 1 })
    tasks[1].status = 'todo'
    expect(taskTotals(tasks)).toEqual({ total: 2, completed: 0 })
  })
  it('空计划的任务数和已完成数都为零', () => {
    expect(taskTotals([])).toEqual({ total: 0, completed: 0 })
  })
})
