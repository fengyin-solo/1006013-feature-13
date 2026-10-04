<template>
  <section class="page" data-module="deice">
    <header class="page-head">
      <div>
        <h2>除冰作业管理</h2>
        <p class="page-desc">
          维护除冰任务，围绕任务编号、航班号、除冰液型号、喷洒量做登记、筛选与状态流转；
          作业时长一律按开始/结束时间重算，登记时手填的旧值不参与合计与导出。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记除冰任务</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="runExport">
      <label class="filter-item">
        <span>除冰液型号</span>
        <select v-model="exportCriteria.fluidType">
          <option value="">全部型号</option>
          <option v-for="type in fluidTypes" :key="type" :value="type">{{ type }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>开始日期</span>
        <input v-model="exportCriteria.from" type="date" />
      </label>
      <label class="filter-item">
        <span>结束日期</span>
        <input v-model="exportCriteria.to" type="date" />
      </label>
      <button class="btn primary" type="submit">导出用量报表</button>
      <button class="btn ghost" type="button" @click="resetExportCriteria">清空条件</button>
      <span v-if="exportProblem" class="error-text">
        {{ exportProblem }}
        <button class="link" type="button" @click="runExport">重试</button>
      </span>
      <span v-else-if="exportNotice" class="success-text">{{ exportNotice }}</span>
    </form>

    <p class="panel-title">用量汇总（与导出文件同一口径：时长按开始/结束时间重算）</p>
    <table class="data-table summary-table">
      <thead>
        <tr>
          <th>除冰液型号</th>
          <th>架次</th>
          <th>喷洒量合计（升）</th>
          <th>作业时长合计（分钟，重算）</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in usageSummary" :key="item.fluidType">
          <td>{{ item.fluidType }}</td>
          <td>{{ item.flights }}</td>
          <td>{{ item.sprayTotal }}</td>
          <td>{{ item.durationTotal }}</td>
        </tr>
        <tr v-if="usageSummary.length" class="totals-row">
          <td>{{ usageTotals.fluidType }}</td>
          <td>{{ usageTotals.flights }}</td>
          <td>{{ usageTotals.sprayTotal }}</td>
          <td>{{ usageTotals.durationTotal }}</td>
        </tr>
        <tr v-if="!usageSummary.length">
          <td colspan="4" class="empty-state">当前导出条件下没有可汇总的除冰作业</td>
        </tr>
      </tbody>
    </table>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in displayRows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!availableActions(row).length" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!displayRows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无除冰作业数据，可先登记除冰任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条除冰作业记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  buildDeiceExport,
  filterDeiceRows,
  formatDuration,
  listFluidTypes,
  recomputeDurationMinutes,
  round1,
  sprayLitersOf,
  startDayOf,
  summarizeDeice,
  summarizeTotals,
} from '@/api/deice-service'
import type { DeiceExportCriteria } from '@/api/deice-service'
import {
  downloadTextFile,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('deice')
const columns = ["任务编号", "航班号", "除冰液型号", "除冰车号", "开始时间", "结束时间", "作业时长(重算)", "喷洒量", "操作人员"]
const actions = meta.actions
const statuses = meta.statuses

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
// 数据版本号：动作流转或重新加载后 +1，让直接读 store 的汇总跟着重算。
const dataVersion = ref(0)

const exportCriteria = ref<DeiceExportCriteria>({ fluidType: '', from: '', to: '' })
const exportError = ref('')
const exportNotice = ref('')

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const displayRows = computed<EntryRow[]>(() =>
  rows.value.map((row) => ({
    ...row,
    '作业时长(重算)': formatDuration(recomputeDurationMinutes(row)),
  })),
)

const fluidTypes = computed(() => {
  dataVersion.value
  return listFluidTypes()
})

const criteriaProblem = computed(() => {
  dataVersion.value
  try {
    filterDeiceRows(exportCriteria.value)
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : '导出条件无效'
  }
})

const exportProblem = computed(() => exportError.value || criteriaProblem.value)

// 页面合计与导出文件共用 filterDeiceRows + summarizeDeice，两边数字必然一致。
const usageSummary = computed(() => {
  dataVersion.value
  if (criteriaProblem.value) {
    return []
  }
  return summarizeDeice(filterDeiceRows(exportCriteria.value))
})
const usageTotals = computed(() => summarizeTotals(usageSummary.value))

const stats = computed(() => {
  dataVersion.value
  const all = filterDeiceRows({ fluidType: '', from: '', to: '' })
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const month = today.slice(0, 7)
  const monthSpray = all.reduce((sum, row) => {
    const day = startDayOf(row)
    const spray = sprayLitersOf(row)
    return day !== null && day.startsWith(month) && spray !== null ? sum + spray : sum
  }, 0)
  return [
    { label: '今日除冰架次', value: all.filter((row) => startDayOf(row) === today).length },
    { label: '除冰中任务', value: all.filter((row) => String(row.status) === '除冰中').length },
    { label: '本月除冰液用量(升)', value: round1(monthSpray) },
  ]
})

// 只能往下走一级：当前状态的下一个状态对应的动作才可点。
function availableActions(row: EntryRow): string[] {
  const next = statuses[statuses.indexOf(String(row.status)) + 1]
  if (!next) {
    return []
  }
  return actions.filter((action) => meta.actionTargets[action] === next)
}

function runExport() {
  exportError.value = ''
  exportNotice.value = ''
  try {
    const file = buildDeiceExport(exportCriteria.value)
    downloadTextFile(file.filename, file.content)
    exportNotice.value = `已生成 ${file.filename}（${file.rowCount} 条明细）`
  } catch (error) {
    exportError.value = error instanceof Error ? error.message : '文件生成失败，请调整条件后重试'
  }
}

function resetExportCriteria() {
  exportCriteria.value = { fluidType: '', from: '', to: '' }
  exportError.value = ''
  exportNotice.value = ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

function openCreate() {
  errorMessage.value = '除冰任务登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    dataVersion.value += 1
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '除冰作业列表读取失败'
  }
}

onMounted(reload)
</script>
