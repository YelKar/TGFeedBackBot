import { Database } from './db'
import type { Env } from './env'
import { getRatingStatus, THRESHOLD } from './rating'
import type { VoteRow } from './types'

export interface VotePayload {
    postId: string
    adminId: number
    adminUsername: string | null
    val: number
    totalAdmins: number
}

function decideStatus(votesRows: VoteRow[], totalAdmins: number): 'scheduled' | 'rejected' | null {
    const scores = votesRows.map((v) => v.vote)
    const res = getRatingStatus(scores, totalAdmins)

    if (res.is_guaranteed_approved || (res.is_final && res.estimation >= THRESHOLD)) {
        return 'scheduled'
    }
    if (res.is_guaranteed_rejected || (res.is_final && res.estimation < THRESHOLD)) {
        return 'rejected'
    }
    return null
}

/**
 * Сериализует применение голосов: blockConcurrencyWhile не пускает
 * следующий запрос, пока не завершён текущий read-modify-write.
 * Один инстанс на пост (idFromName(postId)).
 */
export class ModerationHub {
    constructor(
        private readonly ctx: DurableObjectState,
        private readonly env: Env
    ) {}

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url)
        if (request.method === 'POST' && url.pathname === '/vote') {
            const payload = (await request.json()) as VotePayload
            const result = await this.applyVote(payload)
            return Response.json(result)
        }
        return new Response('Not Found', { status: 404 })
    }

    private async applyVote(payload: VotePayload): Promise<{ applied: true; newStatus: string | null }> {
        return this.ctx.blockConcurrencyWhile(async () => {
            const db = new Database(this.env.DB)

            await db.addVote(payload.postId, payload.adminId, payload.adminUsername, payload.val)
            const rows = await db.getPostVotes(payload.postId)

            const newStatus = decideStatus(rows, payload.totalAdmins)
            if (newStatus) {
                await db.updatePostStatus(payload.postId, newStatus)
            }

            return { applied: true as const, newStatus }
        })
    }
}
