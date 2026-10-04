<template>
  <section class="page" data-module="deice">
    <header class="page-head">
      <div>
        <h2>除冰作业管理</h2>
        <p class="page-desc">维护除冰任务，围绕任务编号、航班号、除冰液型号、喷洒量做登记、筛选与状态流转；用量报表按型号与时间范围导出，口径与页面合计一致。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记除冰任务</button>
        <button class="btn" type="button" @click="exportRows">导出除冰作业清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="report-panel">
      <h3 class="report-title">除冰液用量报表</h3>
      <form class="filter-bar" @submit.prevent="runExport">
        <label class="filter-item">
          <span>除冰液型号</span>
          <select v-model="exportCriteria.fluidType">
            <option value="">全部型号</option>
            <option v-for="fluidType in fluidOptions" :key="fluidType" :value="fluidType">
              {{ fluidType }}
            </option>
          </select>
        </label>
        <label class="filter-item">
          <span>开始日期</span>
          <input v-model="exportCriteria.dateFrom" type="date" />
        </label>
        <label class="filter-item">
          <span>结束日期</span>
          <input v-model="exportCriteria.dateTo" type="date" />
        </label>
        <button class="btn primary" type="submit">导出用量报表</button>
        <button v-if="exportError" class="btn" type="button" @click="runExport">重试</button>
      </form>
      <p v-if="criteriaError" class="error-text">{{ criteriaError }}</p>
      <p v-if="exportError" class="error-text">导出失败：{{ exportError }}，可调整条件后重试。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th>除冰液型号</th>
            <th>任务数</th>
            <th>喷洒量合计（升）</th>
            <th>作业时长合计（分钟，按起止时间重算）</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in usageSummary" :key="item.fluidType">
            <td>{{ item.fluidType }}</td>
            <td>{{ item.taskCount }}</td>
            <td>{{ item.sprayLiters }}</td>
            <td>{{ item.durationMinutes }}</td>
          </tr>
          <tr v-if="usageSummary.length" class="total-row">
            <td>{{ usageTotal.fluidType }}</td>
            <td>{{ usageTotal.taskCount }}</td>
            <td>{{ usageTotal.sprayLiters }}</td>
            <td>{{ usageTotal.durationMinutes }}</td>
          </tr>
          <tr v-if="!usageSummary.length">
            <td colspan="4" class="empty-state">当前条件下没有可汇总的除冰作业</td>
          </tr>
        </tbody>
      </table>
      <p class="report-note">合计口径：作业时长一律按开始与结束时间重算，不采用登记时手填的旧值；导出文件与本表合计一致。</p>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

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
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ displayValue(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
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
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  deiceCriteriaError,
  deiceDurationMinutes,
  deiceFluidType,
  deiceSprayLiters,
  downloadDeiceUsageReport,
  filterDeiceForReport,
  parseDeiceTime,
  summarizeDeiceTotal,
  summarizeDeiceUsage,
} from '@/api/deice'
import type { DeiceReportCriteria } from '@/api/deice'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('deice')
const columns = meta.fields
const actions = meta.actions
const statuses = meta.statuses

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 统计卡片与报表、导出共用 deice.ts 里的同一套口径。
const stats = computed(() => {
  const now = new Date()
  const startedAt = rows.value.map((row) => parseDeiceTime(row['开始时间']))
  const todayCount = startedAt.filter(
    (time) =>
      time &&
      time.getFullYear() === now.getFullYear() &&
      time.getMonth() === now.getMonth() &&
      time.getDate() === now.getDate(),
  ).length
  const monthSpray = rows.value.reduce((sum, row, index) => {
    const time = startedAt[index]
    if (time && time.getFullYear() === now.getFullYear() && time.getMonth() === now.getMonth()) {
      return sum + deiceSprayLiters(row)
    }
    return sum
  }, 0)
  return [
    { label: '今日除冰架次', value: todayCount },
    { label: '除冰中任务', value: rows.value.filter((row) => String(row.status) === statuses[1]).length },
    { label: '本月除冰液用量', value: `${Math.round(monthSpray * 10) / 10} 升` },
  ]
})

// 用量报表：筛选条件、实时合计与导出文件同一份口径（deice.ts）。
const exportCriteria = ref<DeiceReportCriteria>({ fluidType: '', dateFrom: '', dateTo: '' })
const exportError = ref('')
const criteriaError = computed(() => deiceCriteriaError(exportCriteria.value))
const fluidOptions = computed(() =>
  [...new Set(rows.value.map((row) => deiceFluidType(row)))].sort((a, b) =>
    a.localeCompare(b, 'zh-Hans-CN'),
  ),
)
const usageSummary = computed(() =>
  criteriaError.value ? [] : summarizeDeiceUsage(filterDeiceForReport(rows.value, exportCriteria.value)),
)
const usageTotal = computed(() => summarizeDeiceTotal(usageSummary.value))

function runExport() {
  exportError.value = ''
  try {
    downloadDeiceUsageReport(exportCriteria.value)
  } catch (error) {
    exportError.value = error instanceof Error ? error.message : '用量报表生成失败'
  }
}

function displayValue(row: EntryRow, column: string) {
  if (column === '作业时长') {
    const minutes = deiceDurationMinutes(row)
    return minutes === null ? '—' : `${minutes} 分钟`
  }
  const value = row[column]
  return value === undefined || value === null || value === '' ? '—' : value
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
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
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '除冰作业列表读取失败'
  }
}

onMounted(reload)
</script>
