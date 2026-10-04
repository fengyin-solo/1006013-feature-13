import { listRows } from '@/data/local-store'
import type { EntryRow, TransitionHook } from '@/data/types'

// 除冰模块的专属口径与规则都收在这一处：页面合计、导出文件、状态流转共用同一份实现，
// 保证「页面上看到的合计」与「导出的用量」永远一致。

export const DEICE_MODULE_KEY = 'deice'

const FIELD_FLUID = '除冰液型号'
const FIELD_SPRAY = '喷洒量'
const FIELD_TRUCK = '除冰车号'
const FIELD_START = '开始时间'
const FIELD_END = '结束时间'
const FIELD_TASK_NO = '任务编号'
const FIELD_BIZ_STATUS = '任务状态'

// 在办状态：除冰车还被占用、任务尚未闭环。
const ACTIVE_STATUSES = ['除冰中', '待确认']

const ACTION_START = '开始除冰'
const ACTION_SUBMIT = '提交确认'

export type DeiceReportCriteria = {
  fluidType: string
  dateFrom: string
  dateTo: string
}

export type DeiceUsageSummaryRow = {
  fluidType: string
  taskCount: number
  sprayLiters: number
  durationMinutes: number
}

export type DeiceUsageReport = {
  filename: string
  content: string
  matched: number
  summary: DeiceUsageSummaryRow[]
}

// ---- 时间解析与格式化 ----

export function parseDeiceTime(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null
  }
  const text = String(value).trim()
  if (!text) {
    return null
  }
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(text)
  if (match) {
    const [, year, month, day, hour, minute, second] = match
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour ?? 0),
      Number(minute ?? 0),
      Number(second ?? 0),
    )
    return Number.isNaN(date.getTime()) ? null : date
  }
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function formatDeiceTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// ---- 唯一口径：作业时长与喷洒量 ----

// 作业时长（分钟）：只按开始与结束时间重算，登记时手填的「作业时长」旧值一律不采用。
// 缺时间、或结束早于开始，都视为算不出，返回 null；页面与导出对 null 的处理保持一致。
export function deiceDurationMinutes(row: EntryRow): number | null {
  const start = parseDeiceTime(row[FIELD_START])
  const end = parseDeiceTime(row[FIELD_END])
  if (!start || !end) {
    return null
  }
  const minutes = Math.round((end.getTime() - start.getTime()) / 60000)
  return minutes >= 0 ? minutes : null
}

// 喷洒量（升）：登记值不是数字时按 0 计，页面与导出同一口径。
export function deiceSprayLiters(row: EntryRow): number {
  const value = Number(row[FIELD_SPRAY])
  return Number.isFinite(value) ? value : 0
}

export function deiceFluidType(row: EntryRow): string {
  const fluidType = String(row[FIELD_FLUID] ?? '').trim()
  return fluidType || '未登记'
}

// ---- 除冰车冲突：同一除冰车同一时段只允许一条在办任务，先开始先占车 ----

type DeiceWindow = { start: Date | null; end: Date | null }

function deiceWindow(row: EntryRow, fallbackStart?: Date): DeiceWindow {
  return {
    start: parseDeiceTime(row[FIELD_START]) ?? fallbackStart ?? null,
    end: parseDeiceTime(row[FIELD_END]),
  }
}

// 没有开始时间按最早算、没有结束时间按仍在进行算，宁严勿宽。
function windowsOverlap(a: DeiceWindow, b: DeiceWindow): boolean {
  const aStart = a.start ? a.start.getTime() : Number.NEGATIVE_INFINITY
  const aEnd = a.end ? a.end.getTime() : Number.POSITIVE_INFINITY
  const bStart = b.start ? b.start.getTime() : Number.NEGATIVE_INFINITY
  const bEnd = b.end ? b.end.getTime() : Number.POSITIVE_INFINITY
  return aStart < bEnd && bStart < aEnd
}

export function findTruckConflict(rows: EntryRow[], candidate: EntryRow, now: Date): EntryRow | null {
  const truck = String(candidate[FIELD_TRUCK] ?? '').trim()
  if (!truck) {
    return null
  }
  const candidateWindow = deiceWindow(candidate, now)
  for (const row of rows) {
    if (Number(row.id) === Number(candidate.id)) {
      continue
    }
    if (String(row[FIELD_TRUCK] ?? '').trim() !== truck) {
      continue
    }
    if (!ACTIVE_STATUSES.includes(String(row.status))) {
      continue
    }
    if (windowsOverlap(candidateWindow, deiceWindow(row))) {
      return row
    }
  }
  return null
}

// 流转钩子：开始除冰先查车再补登开始时间，提交确认补登结束时间。只补空值，不覆盖已有时间。
export const deiceTransitionHook: TransitionHook = (row, action, target, rows) => {
  const fields: Record<string, string> = { [FIELD_BIZ_STATUS]: target }
  if (action === ACTION_START) {
    const now = new Date()
    const conflict = findTruckConflict(rows, row, now)
    if (conflict) {
      return {
        ok: false,
        message: `除冰车「${String(row[FIELD_TRUCK])}」此时段已有在办任务 ${String(conflict[FIELD_TASK_NO] ?? conflict.id)}（${String(conflict.status)}），同一除冰车同一时段只允许一条在办任务，先开始先占车`,
      }
    }
    if (!parseDeiceTime(row[FIELD_START])) {
      fields[FIELD_START] = formatDeiceTime(now)
    }
  }
  if (action === ACTION_SUBMIT && !parseDeiceTime(row[FIELD_END])) {
    fields[FIELD_END] = formatDeiceTime(new Date())
  }
  return { ok: true, fields }
}

// ---- 报表条件：除冰液型号 + 时间范围（按开始时间过滤，含边界） ----

function parseDateOnly(text: string, endOfDay: boolean): Date | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text.trim())
  if (!match) {
    return null
  }
  const [, year, month, day] = match
  return endOfDay
    ? new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999)
    : new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0)
}

export function deiceCriteriaError(criteria: DeiceReportCriteria): string | null {
  const from = criteria.dateFrom ? parseDateOnly(criteria.dateFrom, false) : null
  const to = criteria.dateTo ? parseDateOnly(criteria.dateTo, true) : null
  if (criteria.dateFrom && !from) {
    return '开始日期无法识别，请重新选择'
  }
  if (criteria.dateTo && !to) {
    return '结束日期无法识别，请重新选择'
  }
  if (from && to && from.getTime() > to.getTime()) {
    return '时间范围无效：开始日期晚于结束日期'
  }
  return null
}

export function filterDeiceForReport(rows: EntryRow[], criteria: DeiceReportCriteria): EntryRow[] {
  if (deiceCriteriaError(criteria)) {
    return []
  }
  const fluidType = criteria.fluidType.trim()
  const from = criteria.dateFrom ? parseDateOnly(criteria.dateFrom, false) : null
  const to = criteria.dateTo ? parseDateOnly(criteria.dateTo, true) : null
  return rows.filter((row) => {
    if (fluidType && deiceFluidType(row) !== fluidType) {
      return false
    }
    if (from || to) {
      const start = parseDeiceTime(row[FIELD_START])
      if (!start) {
        return false
      }
      if (from && start.getTime() < from.getTime()) {
        return false
      }
      if (to && start.getTime() > to.getTime()) {
        return false
      }
    }
    return true
  })
}

// ---- 汇总：喷洒量按型号汇总，重算后的作业时长一并计入 ----

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

export function summarizeDeiceUsage(rows: EntryRow[]): DeiceUsageSummaryRow[] {
  const byType = new Map<string, DeiceUsageSummaryRow>()
  for (const row of rows) {
    const fluidType = deiceFluidType(row)
    const bucket = byType.get(fluidType) ?? { fluidType, taskCount: 0, sprayLiters: 0, durationMinutes: 0 }
    bucket.taskCount += 1
    bucket.sprayLiters += deiceSprayLiters(row)
    bucket.durationMinutes += deiceDurationMinutes(row) ?? 0
    byType.set(fluidType, bucket)
  }
  return [...byType.values()]
    .map((item) => ({ ...item, sprayLiters: round1(item.sprayLiters) }))
    .sort((a, b) => a.fluidType.localeCompare(b.fluidType, 'zh-Hans-CN'))
}

export function summarizeDeiceTotal(summary: DeiceUsageSummaryRow[]): DeiceUsageSummaryRow {
  return {
    fluidType: '总计',
    taskCount: summary.reduce((sum, item) => sum + item.taskCount, 0),
    sprayLiters: round1(summary.reduce((sum, item) => sum + item.sprayLiters, 0)),
    durationMinutes: summary.reduce((sum, item) => sum + item.durationMinutes, 0),
  }
}

// ---- 报表生成与下载：失败只留原因，不留空壳文件 ----

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csvLine(cells: (string | number)[]): string {
  return cells.map(csvCell).join(',')
}

// 生成用量报表：条件无效、范围内没有明细等情况都抛出带原因的错误，不产出任何文件内容。
export function buildDeiceUsageReport(criteria: DeiceReportCriteria): DeiceUsageReport {
  const criteriaError = deiceCriteriaError(criteria)
  if (criteriaError) {
    throw new Error(criteriaError)
  }
  const matched = filterDeiceForReport(listRows(DEICE_MODULE_KEY), criteria)
  if (matched.length === 0) {
    throw new Error('当前除冰液型号与时间范围内没有除冰作业明细，未生成文件')
  }
  const summary = summarizeDeiceUsage(matched)
  const total = summarizeDeiceTotal(summary)
  const fluidType = criteria.fluidType.trim() || '全部'
  const lines: string[] = [
    csvLine(['除冰液用量报表']),
    csvLine(['导出时间', formatDeiceTime(new Date())]),
    csvLine(['除冰液型号', fluidType]),
    csvLine(['时间范围', `${criteria.dateFrom || '不限'} 至 ${criteria.dateTo || '不限'}`]),
    '',
    csvLine(['按型号汇总（作业时长按开始与结束时间重算）']),
    csvLine(['除冰液型号', '任务数', '喷洒量合计(升)', '作业时长合计(分钟)']),
    ...summary.map((item) => csvLine([item.fluidType, item.taskCount, item.sprayLiters, item.durationMinutes])),
    csvLine([total.fluidType, total.taskCount, total.sprayLiters, total.durationMinutes]),
    '',
    csvLine(['作业明细']),
    csvLine(['任务编号', '航班号', '除冰液型号', '喷洒量(升)', '除冰车号', '开始时间', '结束时间', '作业时长(分钟)', '操作人员', '任务状态']),
    ...matched.map((row) =>
      csvLine([
        String(row[FIELD_TASK_NO] ?? row.id),
        String(row['航班号'] ?? ''),
        deiceFluidType(row),
        deiceSprayLiters(row),
        String(row[FIELD_TRUCK] ?? ''),
        String(row[FIELD_START] ?? ''),
        String(row[FIELD_END] ?? ''),
        deiceDurationMinutes(row) ?? '',
        String(row['操作人员'] ?? ''),
        String(row.status ?? ''),
      ]),
    ),
  ]
  const stamp = (text: string) => text.replace(/-/g, '')
  const rangePart = criteria.dateFrom || criteria.dateTo
    ? `${criteria.dateFrom ? stamp(criteria.dateFrom) : '起'}-${criteria.dateTo ? stamp(criteria.dateTo) : '止'}`
    : '全部时段'
  return {
    filename: `除冰液用量报表-${fluidType}-${rangePart}.csv`,
    content: `\uFEFF${lines.join('\n')}`,
    matched: matched.length,
    summary,
  }
}

// 先完整生成再下载：生成失败时不会创建任何空文件，调用方拿到错误原因后可重试。
export function downloadDeiceUsageReport(criteria: DeiceReportCriteria): DeiceUsageReport {
  const report = buildDeiceUsageReport(criteria)
  const blob = new Blob([report.content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = report.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return report
}
