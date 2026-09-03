import type { ActionId, Analytics, Post, PostStatus, RatingStatus } from './types'

const LIMIT = 20
const API_BASE_URL = new URLSearchParams(window.location.search).get('api') ?? ''

function authHeaders(): Record<string, string> {
    return { 'X-Tg-Data': window.Telegram?.WebApp?.initData || '' }
}

function invalid(what: string): never {
    throw new Error(`Invalid API response: ${what}`)
}

function asObject(v: unknown): Record<string, unknown> {
    if (typeof v !== 'object' || v === null) invalid('object')
    return v as Record<string, unknown>
}

function asNumber(v: unknown): number {
    if (typeof v !== 'number' || Number.isNaN(v)) invalid('number')
    return v
}

function asString(v: unknown): string {
    if (typeof v !== 'string') invalid('string')
    return v
}

function asBoolean(v: unknown): boolean {
    if (typeof v !== 'boolean') invalid('boolean')
    return v
}

function parseRatingStatus(v: unknown): RatingStatus {
    const o = asObject(v)
    return {
        estimation: asNumber(o.estimation),
        min_estimation: asNumber(o.min_estimation),
        max_estimation: asNumber(o.max_estimation),
        is_final: asBoolean(o.is_final),
        is_guaranteed_approved: asBoolean(o.is_guaranteed_approved),
        is_guaranteed_rejected: asBoolean(o.is_guaranteed_rejected),
    }
}

function parseAnalytics(v: unknown): Analytics {
    const o = asObject(v)
    return {
        res: parseRatingStatus(o.res),
        votes_list: asString(o.votes_list),
        is_approved: asBoolean(o.is_approved),
        is_rejected: asBoolean(o.is_rejected),
    }
}

const STATUSES: readonly string[] = ['pending', 'scheduled', 'rejected', 'published']

export function parsePost(v: unknown): Post {
    const o = asObject(v)
    const status = asString(o.status)
    if (!STATUSES.includes(status)) invalid('status')
    return {
        id: asString(o.id),
        username: typeof o.username === 'string' ? o.username : '',
        text: asString(o.text),
        status: status as PostStatus,
        publish_at: o.publish_at === null ? null : asNumber(o.publish_at),
        created_at: asNumber(o.created_at),
        media_count: typeof o.media_count === 'number' && !Number.isNaN(o.media_count) ? o.media_count : 0,
        analytics: parseAnalytics(o.analytics),
    }
}

export async function fetchPosts(
    method: 'get_posts' | 'get_my_posts',
    status?: string,
    lastTs?: number | null
): Promise<{ posts: Post[]; role: 'admin' | 'user' }> {
    const qs = [`method=${method}`]
    if (method === 'get_posts' && status) qs.push(`status=${status}`)
    if (lastTs) qs.push(`last_ts=${Math.trunc(lastTs)}`)
    qs.push(`limit=${LIMIT}`)

    const res = await fetch(`${API_BASE_URL}?${qs.join('&')}`, {
        headers: authHeaders(),
    })
    if (res.status === 401) throw new Error('unauthorized')

    const body = asObject(await res.json())
    const rawPosts = Array.isArray(body.posts) ? body.posts : []
    return {
        posts: rawPosts.map((p) => parsePost(p)),
        role: body.role === 'admin' ? 'admin' : 'user',
    }
}

export async function fetchSinglePost(postId: string): Promise<Post | null> {
    try {
        const res = await fetch(`${API_BASE_URL}?method=get_single_post&post_id=${postId}`, {
            headers: authHeaders(),
        })
        return res.ok ? parsePost(await res.json()) : null
    } catch (e) {
        console.error('Sync failed:', e)
        return null
    }
}

export async function sendAction(
    postId: string,
    action: ActionId,
    extra: Record<string, unknown> = {}
): Promise<boolean> {
    try {
        const res = await fetch(`${API_BASE_URL}?method=action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ post_id: postId, action, ...extra }),
        })
        return res.ok
    } catch {
        return false
    }
}
