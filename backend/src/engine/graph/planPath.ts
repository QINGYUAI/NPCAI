/**
 * [M4.5.1.b Q-b4=a] plan 节点三路分支决策（纯函数，可单测）
 *
 * 优先级硬序：event > goal > schedule > idle
 *   - event：本 tick 有任何可见 scene_event（eventItems 非空），忽略 goal/schedule
 *   - goal：无 event + 存在 activeGoal + 目标 priority ≥ 日程 priority（无日程视为 0）
 *   - schedule：无 event + （无 goal 或 goal priority 被日程盖过）+ 有 scheduledActivity
 *   - idle：三者皆无
 *
 * 独立成文件的理由：
 *   - 让 runGraph 只做"透传 + 选择性注入"，分支判定集中一处；
 *   - 单测可脱离 DB / LLM / scheduler 整体环境（见 tests/engine-plan-path.test.ts）；
 *   - 未来加第四路（例如情感驱动）只需扩本函数签名，调用方零改动。
 */

/** 三路分支输出码；idle 表示"既无事件也无 goal 也无日程"，plan prompt 完全退化到 M4.4.0 行为 */
export type PlanPath = 'event' | 'goal' | 'schedule' | 'idle';

/** 决策所需的最小输入集（均可选，全 undefined/null 时退化为 idle） */
export interface ComputePlanPathInput {
  /** eventItems 长度；>0 即视为"本 tick 有事件" */
  hasEvents: boolean;
  /** 来自 fetchActiveGoalForNpc；null 表示 GOAL_ENABLED=false 或无活动目标 */
  activeGoal: { id: number; title: string; priority: number } | null | undefined;
  /** 来自 scheduler.resolveScheduledActivity；null 表示该小时无日程或 SCHEDULE_ENABLED=false */
  scheduledActivity: { activity: string; location: string | null; priority: number } | null | undefined;
}

/**
 * 纯函数：按"event > goal > schedule > idle"硬优先级返回 plan_path。
 * - goal 与 schedule 比较仅看 priority；平手时"goal 先赢"（保证主动目标可抢占日程）
 * - activeGoal.priority 应为 1..10 范围（crud 已约束）；传入非法值也照常比较，不抛错
 */
export function computePlanPath(input: ComputePlanPathInput): PlanPath {
  if (input.hasEvents) return 'event';
  const goal = input.activeGoal ?? null;
  const sched = input.scheduledActivity ?? null;
  if (goal) {
    const goalPriority = Number(goal.priority) || 0;
    const schedPriority = sched ? Number(sched.priority) || 0 : 0;
    if (goalPriority >= schedPriority) return 'goal';
  }
  if (sched) return 'schedule';
  return 'idle';
}
