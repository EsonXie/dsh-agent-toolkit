/** TaskForm 草稿类型（独立文件避免 ScheduleModal ↔ TaskForm 循环导入）。 */
import type { CronTaskView } from './api.ts'

/** 新建/编辑草稿：编辑 = 既有任务视图。 */
export type ScheduleTaskDraft = CronTaskView
