import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 除冰模块的专用口径与规则。页面上的合计和导出的文件都从这里取数，
// 保证「页面上看到的」与「导出去的」是同一份结果。

export const DEICE_KEY = 'deice'

// 除冰车被占用的状态：开始除冰后到确认完成前，这辆车都算在办，别的任务不能再用它。
const TRUCK_BUSY_STATUSES = ['除冰中', '待确认']

const TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export type DeiceExportCriteria = {
  /** 除冰液型号，空串表示全部型号 */
  fluidType: string
  /** 开始日期 YYYY-MM-DD，空串表示不限 */
  from: string
  /** 结束日期 YYYY-MM-DD，空串表示不限 */
  to: string
}

export type DeiceSummaryRow = {
  fluidType: string
  flights: number
  /** 喷洒量合计（升） */
  sprayTotal: number
  /** 作业时长合计（分钟），按开始/结束时间重算 */
  durationTotal: number
}

export type DeiceExportFile = {
  filename: string
  content: string
  rowCount: number
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null
  }
  const match = TIME_PATTERN.exec(value.trim())
  if (!match) {
    return null
  }
  const [, year, month, day, hour, minute] = match
  const time = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  ).getTime()
  return Number.isNaN(time) ? null : time
}

/** 任务开始日期（YYYY-MM-DD），没有开始时间或格式不对时返回 null。 */
export function startDayOf(row: EntryRow): string | null {
  const value = row['开始时间']
  if (typeof value !== 'string') {
    return null
  }
  const match = TIME_PATTERN.exec(value.trim())
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

/**
 * 作业时长唯一口径：一律用开始时间与结束时间重算（分钟）。
 * 登记时手填的「作业时长」旧值不参与任何展示、合计与导出。
 */
export function recomputeDurationMinutes(row: EntryRow): number | null {
  const start = parseTime(row['开始时间'])
  const end = parseTime(row['结束时间'])
  if (start === null || end === null || end < start) {
    return null
  }
  return Math.round((end - start) / 60000)
}

export function formatDuration(minutes: number | null): string {
  return minutes === null ? '—' : `${minutes}分钟`
}

/** 喷洒量（升），空值或无法解析时返回 null。 */
export function sprayLitersOf(row: EntryRow): number | null {
  const value = row['喷洒量']
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  const text = String(value ?? '').trim()
  if (!text) {
    return null
  }
  const num = Number(text)
  return Number.isFinite(num) ? num : null
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * 动作前置校验：同一除冰车同一时段只允许一条在办任务。
 * 谁先开始谁占车（先到先得），后来的任务在这里被拦下并说明占车的是谁。
 */
export function deiceActionGuard(rows: EntryRow[], row: EntryRow, action: string): string | null {
  if (action !== '开始除冰') {
    return null
  }
  const truck = String(row['除冰车号'] ?? '').trim()
  if (!truck) {
    return null
  }
  const holder = rows.find(
    (item) =>
      Number(item.id) !== Number(row.id) &&
      String(item['除冰车号'] ?? '').trim() === truck &&
      TRUCK_BUSY_STATUSES.includes(String(item.status)),
  )
  if (!holder) {
    return null
  }
  const label = holder['任务编号'] ?? holder.id
  return `除冰车「${truck}」正在执行 ${label}（${holder.status}），同一时段只允许一条在办任务，等它确认完成后再开始`
}

/** 按型号与时间范围筛出可导出的作业明细；条件本身有问题时抛错说明原因。 */
export function filterDeiceRows(criteria: DeiceExportCriteria): EntryRow[] {
  const from = criteria.from.trim()
  const to = criteria.to.trim()
  if (from && !DAY_PATTERN.test(from)) {
    throw new Error(`开始日期「${from}」格式不对，应为 YYYY-MM-DD，未生成文件`)
  }
  if (to && !DAY_PATTERN.test(to)) {
    throw new Error(`结束日期「${to}」格式不对，应为 YYYY-MM-DD，未生成文件`)
  }
  if (from && to && from > to) {
    throw new Error(`时间范围起止颠倒：开始日期 ${from} 晚于结束日期 ${to}，未生成文件`)
  }
  const fluidType = criteria.fluidType.trim()
  return listRows(DEICE_KEY).filter((row) => {
    if (fluidType && String(row['除冰液型号'] ?? '').trim() !== fluidType) {
      return false
    }
    if (!from && !to) {
      return true
    }
    const day = startDayOf(row)
    if (day === null) {
      return false // 划了时间范围但没有开始时间的记录无法归属，剔除
    }
    if (from && day < from) {
      return false
    }
    if (to && day > to) {
      return false
    }
    return true
  })
}

/** 按型号汇总：架次、喷洒量合计，并把重算后的作业时长合计也算进去。 */
export function summarizeDeice(rows: EntryRow[]): DeiceSummaryRow[] {
  const byType = new Map<string, DeiceSummaryRow>()
  for (const row of rows) {
    const fluidType = String(row['除冰液型号'] ?? '').trim() || '未登记型号'
    let bucket = byType.get(fluidType)
    if (!bucket) {
      bucket = { fluidType, flights: 0, sprayTotal: 0, durationTotal: 0 }
      byType.set(fluidType, bucket)
    }
    bucket.flights += 1
    const spray = sprayLitersOf(row)
    if (spray !== null) {
      bucket.sprayTotal = round1(bucket.sprayTotal + spray)
    }
    const duration = recomputeDurationMinutes(row)
    if (duration !== null) {
      bucket.durationTotal += duration
    }
  }
  return [...byType.values()].sort((a, b) => a.fluidType.localeCompare(b.fluidType, 'zh-Hans-CN'))
}

export function summarizeTotals(items: DeiceSummaryRow[]): DeiceSummaryRow {
  return {
    fluidType: '总计',
    flights: items.reduce((sum, item) => sum + item.flights, 0),
    sprayTotal: round1(items.reduce((sum, item) => sum + item.sprayTotal, 0)),
    durationTotal: items.reduce((sum, item) => sum + item.durationTotal, 0),
  }
}

export function listFluidTypes(): string[] {
  const types = new Set<string>()
  for (const row of listRows(DEICE_KEY)) {
    const type = String(row['除冰液型号'] ?? '').trim()
    if (type) {
      types.add(type)
    }
  }
  return [...types].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csvLine(values: unknown[]): string {
  return values.map(csvCell).join(',')
}

function filenamePart(text: string): string {
  return text.replace(/[\\/:*?"<>|\s]+/g, '-')
}

/**
 * 生成用量报表文件：作业明细 + 按型号汇总。
 * 任何一步出问题都抛错说明原因，绝不交出只有表头的空壳文件。
 */
export function buildDeiceExport(criteria: DeiceExportCriteria): DeiceExportFile {
  const rows = filterDeiceRows(criteria)
  if (rows.length === 0) {
    const fluid = criteria.fluidType.trim() || '全部型号'
    const range = `${criteria.from.trim() || '不限'} 至 ${criteria.to.trim() || '不限'}`
    throw new Error(`${fluid}在 ${range} 内没有除冰作业记录，未生成文件`)
  }
  const summary = summarizeDeice(rows)
  const totals = summarizeTotals(summary)
  const lines: string[] = [
    csvLine(['任务编号', '航班号', '除冰液型号', '除冰车号', '开始时间', '结束时间', '作业时长(分钟,重算)', '喷洒量(升)', '操作人员', '任务状态']),
  ]
  for (const row of rows) {
    lines.push(
      csvLine([
        row['任务编号'],
        row['航班号'],
        row['除冰液型号'],
        row['除冰车号'],
        row['开始时间'],
        row['结束时间'],
        recomputeDurationMinutes(row) ?? '',
        sprayLitersOf(row) ?? '',
        row['操作人员'],
        row.status,
      ]),
    )
  }
  lines.push('')
  lines.push(csvLine(['按型号汇总', '架次', '喷洒量合计(升)', '作业时长合计(分钟,重算)']))
  for (const item of summary) {
    lines.push(csvLine([item.fluidType, item.flights, item.sprayTotal, item.durationTotal]))
  }
  lines.push(csvLine([totals.fluidType, totals.flights, totals.sprayTotal, totals.durationTotal]))
  const fluid = filenamePart(criteria.fluidType.trim() || '全部型号')
  const from = filenamePart(criteria.from.trim() || '不限')
  const to = filenamePart(criteria.to.trim() || '不限')
  return {
    filename: `除冰作业用量-${fluid}-${from}至${to}.csv`,
    content: `\uFEFF${lines.join('\r\n')}`,
    rowCount: rows.length,
  }
}
