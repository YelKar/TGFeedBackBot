import { describe, expect, it } from 'vitest'
import { calculateNextTime, rebalanceQueue, TZ_OFFSET_MS, type QueueDb } from '../src/scheduler'
import type { PostRow, SchedulerConfig } from '../src/types'

const CONFIG: SchedulerConfig = {
    preferred_slots: ['10:00', '18:00'],
    min_interval: 3600,
    window_start: 9,
    window_end: 22,
    posts_per_day: 2,
}

const dt = (d: number, h: number, min: number): number =>
    Date.UTC(2026, 7, d, h, min) - TZ_OFFSET_MS // локальное (+03) время 23–24 авг 2026

describe('calculateNextTime', () => {
    it('берёт поздний слот того же дня', () => {
        const t = calculateNextTime(dt(23, 12, 0), CONFIG)
        expect(new Date(t + TZ_OFFSET_MS).getUTCHours()).toBe(18)
    })

    it('берёт первый слот окна', () => {
        const t = calculateNextTime(dt(23, 7, 0), CONFIG)
        expect(new Date(t + TZ_OFFSET_MS).getUTCHours()).toBe(10)
    })

    it('уважает min_interval', () => {
        // слот 10:00 раньше чем 09:30 + интервал → берём 18:00
        const t = calculateNextTime(dt(23, 9, 30), CONFIG)
        expect(new Date(t + TZ_OFFSET_MS).getUTCHours()).toBe(18)
    })

    it('уходит на следующий день, если слоты кончились', () => {
        const t = calculateNextTime(dt(23, 20, 0), { ...CONFIG, preferred_slots: ['10:00'] })
        const local = new Date(t + TZ_OFFSET_MS)
        expect(local.getUTCDate()).toBe(24)
        expect(local.getUTCHours()).toBe(10)
    })

    it('слоты вне окна публикации дают ошибку, а не бесконечный цикл', () => {
        expect(() =>
            calculateNextTime(dt(23, 12, 0), { ...CONFIG, preferred_slots: ['23:30'] })
        ).toThrow()
    })
})

class FakeDb implements QueueDb {
    updates: { id: string; publish_at: number }[] | null = null

    constructor(
        private readonly config: SchedulerConfig | null,
        private readonly posts: PostRow[],
        private readonly lastPublishMs: number | null = null
    ) {}

    async getConfig(_: 'scheduler'): Promise<SchedulerConfig | null> {
        return this.config
    }

    async getLatestPublishedMs(): Promise<number | null> {
        return this.lastPublishMs
    }

    async getScheduledQueue(): Promise<PostRow[]> {
        return [...this.posts]
    }

    async updatePostsBatch(u: { id: string; publish_at: number }[]): Promise<void> {
        this.updates = u
    }
}

function post(id: string, createdAtMs: number): PostRow {
    return {
        id,
        user_id: 1,
        username: 'u',
        text: 't',
        status: 'scheduled',
        created_at: createdAtMs,
        admin_msg_id: null,
        publish_at: null,
        sequence_number: null,
        media: null,
    }
}

const localDay = (ms: number): number => Math.floor((ms + TZ_OFFSET_MS) / 86_400_000)

describe('rebalanceQueue', () => {
    it('без конфига ничего не делает', async () => {
        const db = new FakeDb(null, [])
        await rebalanceQueue(db)
        expect(db.updates).toBeNull()
    })

    it('соблюдает дневной лимит и порядок очереди', async () => {
        const now = dt(23, 12, 0)
        const db = new FakeDb(CONFIG, [post('p0', now), post('p1', now), post('p2', now)])
        await rebalanceQueue(db, now)

        expect(db.updates).not.toBeNull()
        const updates = db.updates as { id: string; publish_at: number }[]
        expect(updates).toHaveLength(3)

        const days = updates.map((u) => localDay(u.publish_at))
        expect(days.filter((d) => d === localDay(now))).toHaveLength(1) // лимит дня исчерпан
        expect(new Set(days).size).toBe(2)

        const times = updates.map((u) => u.publish_at)
        expect(times).toEqual([...times].sort((a, b) => a - b)) // монотонность
    })

    it('точка отсчёта — время последней публикации', async () => {
        const now = dt(23, 12, 0)
        const lastPublish = dt(23, 11, 0)
        const db = new FakeDb(CONFIG, [post('p1', now)], lastPublish)
        await rebalanceQueue(db, now)

        const updates = db.updates as { publish_at: number }[]
        const t = new Date(updates[0].publish_at + TZ_OFFSET_MS)
        expect(t.getUTCDate()).toBe(23)
        expect(t.getUTCHours()).toBe(18) // после публикации в 11:00 следующий слот — 18:00
    })
})
