import type { PostRow, SchedulerConfig } from './types'

export const TZ_OFFSET_MS = 3 * 3600_000

export interface QueueDb {
    getConfig<T>(key: string): Promise<T | null>
    getLatestPublishedMs(): Promise<number | null>
    getScheduledQueue(): Promise<PostRow[]>
    updatePostsBatch(updates: { id: string; publish_at: number; sequence_number: number }[]): Promise<void>
}

interface LocalParts {
    y: number
    m: number
    d: number
    h: number
    min: number
    s: number
}

function localParts(ms: number): LocalParts {
    const d = new Date(ms + TZ_OFFSET_MS)
    return {
        y: d.getUTCFullYear(),
        m: d.getUTCMonth(),
        d: d.getUTCDate(),
        h: d.getUTCHours(),
        min: d.getUTCMinutes(),
        s: d.getUTCSeconds(),
    }
}

function makeLocal(y: number, m: number, d: number, h: number, min: number, s: number): number {
    return Date.UTC(y, m, d, h, min, s) - TZ_OFFSET_MS
}

export function calculateNextTime(afterMs: number, config: SchedulerConfig): number {
    let current = afterMs
    for (;;) {
        const { y, m, d } = localParts(current)

        const slots: number[] = []
        for (const slot of config.preferred_slots) {
            const [h, min] = slot.split(':').map(Number)
            if (config.window_start <= h && h < config.window_end) {
                slots.push(makeLocal(y, m, d, h, min, 0))
            }
        }
        slots.sort((a, b) => a - b)

        if (slots.length === 0) {
            throw new Error('Ни один preferred_slots не попадает в окно window_start–window_end')
        }

        const found = slots.find((slot) => slot >= current + config.min_interval * 1000)
        if (found !== undefined) return found

        current = makeLocal(y, m, d + 1, config.window_start, 0, 0) - config.min_interval * 1000
    }
}

function dayKey(ms: number): number {
    return Math.floor((ms + TZ_OFFSET_MS) / 86_400_000)
}

export interface QueueUpdate {
    id: string
    publish_at: number
    sequence_number: number
}

export async function rebalanceQueue(db: QueueDb, nowMs: number = Date.now()): Promise<void> {
    const config = await db.getConfig<SchedulerConfig>('scheduler')
    if (!config) return

    const lastPublishMs = await db.getLatestPublishedMs()
    const dayStats = new Map<number, number>()

    let currentPoint: number
    if (lastPublishMs !== null) {
        currentPoint = Math.max(nowMs, lastPublishMs)
        if (dayKey(lastPublishMs) === dayKey(nowMs)) {
            dayStats.set(dayKey(nowMs), 1)
        }
    } else {
        currentPoint = nowMs
    }

    const scheduledPosts = [...(await db.getScheduledQueue())].sort(
        (a, b) => a.created_at - b.created_at
    )

    const updates: QueueUpdate[] = []

    for (const post of scheduledPosts) {
        for (;;) {
            const nextTime = calculateNextTime(currentPoint, config)
            const key = dayKey(nextTime)
            const count = dayStats.get(key) ?? 0

            if (count < config.posts_per_day) {
                updates.push({
                    id: post.id,
                    publish_at: nextTime,
                    sequence_number: updates.length + 1,
                })
                dayStats.set(key, count + 1)
                currentPoint = nextTime
                break
            }
            // Дневной лимит исчерпан — прыгаем на конец локального дня и ищем слот заново
            const p = localParts(nextTime)
            currentPoint = makeLocal(p.y, p.m, p.d, 23, 59, 59)
        }
    }

    if (updates.length > 0) {
        await db.updatePostsBatch(updates)
    }
}
