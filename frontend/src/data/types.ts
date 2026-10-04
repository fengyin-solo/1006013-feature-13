/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  // 每个动作允许的起始状态：声明了的模块只能逐级流转，跨级与回退一律驳回。
  actionFrom?: Record<string, string[]>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

// 模块级流转钩子：在通用校验之后执行，可做资源冲突检查、补登字段等。
export type TransitionHookResult = {
  ok: boolean
  message?: string
  fields?: Record<string, string | number | boolean>
}

export type TransitionHook = (
  row: EntryRow,
  action: string,
  target: string,
  rows: EntryRow[],
) => TransitionHookResult

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
