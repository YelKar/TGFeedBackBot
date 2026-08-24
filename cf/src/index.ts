import type { Update } from '@grammyjs/types'
import type { Env } from './env'
import { getBot } from './bot'
import { Database } from './db'
import type { Action } from './bot_util'
import {
    applyAction,
    calculateAnalytics,
    feedbackChatId,
    getAdminCount,
    getPostAnalytics,
    getUserFromData,
    publishPost,
    reconcilePendingStatuses,
    verifyTgData,
} from './bot_util'
import type { PostRow } from './types'

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Tg-Data, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
    })
}

async function handleApi(req: Request, env: Env): Promise<Response> {
    const initData =
        req.headers.get('X-Tg-Data') ?? req.headers.get('authorization') ?? ''

    if (!initData || !(await verifyTgData(initData, env.TOKEN))) {
        return json({ error: 'Unauthorized' }, 401)
    }

    const user = getUserFromData(initData)
    if (!user.id) return json({ error: 'Unauthorized' }, 401)
    const userId: number = user.id

    const db = new Database(env.DB)
    const bot = await getBot(env)

    let isAdmin = false
    try {
        const member = await bot.api.getChatMember(feedbackChatId(env), userId)
        isAdmin = ['creator', 'administrator'].includes(member.status)
    } catch {
        isAdmin = false
    }

    const url = new URL(req.url)
    const method = url.searchParams.get('method')
    const limit = Number(url.searchParams.get('limit') ?? 10)
    const lastTsRaw = url.searchParams.get('last_ts')
    const lastTs = lastTsRaw ? Number(lastTsRaw) : null

    if (method === 'get_posts' || method === 'get_my_posts') {
        const posts =
            !isAdmin || method === 'get_my_posts'
                ? await db.getFilteredPosts({ userId, limit, lastTs })
                : await db.getFilteredPosts({
                      status: (url.searchParams.get('status') as PostRow['status']) ?? 'pending',
                      limit,
                      lastTs,
                  })

        if (posts.length === 0) {
            return json({ posts: [], role: isAdmin ? 'admin' : 'user' })
        }

        const allVotes = await db.getVotesForPosts(posts.map((p) => p.id))
        const votesByPost = new Map<string, typeof allVotes>()
        for (const v of allVotes) {
            const list = votesByPost.get(v.post_id) ?? []
            list.push(v)
            votesByPost.set(v.post_id, list)
        }

        const totalAdmins = await getAdminCount(bot, env)
        const fullData = posts.map((p) => ({
            id: p.id,
            username: p.username,
            text: p.text,
            status: p.status,
            publish_at: p.publish_at !== null ? p.publish_at / 1000 : null,
            created_at: p.created_at / 1000,
            analytics: calculateAnalytics(votesByPost.get(p.id) ?? [], totalAdmins),
        }))

        return json({ posts: fullData, role: isAdmin ? 'admin' : 'user' })
    }

    if (method === 'get_single_post') {
        const postId = url.searchParams.get('post_id')
        const post = postId ? await db.getPost(postId) : null
        if (!post) return json({}, 404)
        const ana = await getPostAnalytics(bot, env, db, post.id)
        return json({
            id: post.id,
            username: post.username,
            text: post.text,
            status: post.status,
            publish_at: post.publish_at !== null ? post.publish_at / 1000 : null,
            created_at: post.created_at / 1000,
            analytics: ana,
        })
    }

    if (method === 'action') {
        const body = (await req.json().catch(() => ({}))) as {
            post_id?: string
            action?: string
            val?: string
            text?: string
        }
        await applyAction(bot, db, {
            env,
            postId: body.post_id ?? '',
            action: body.action as Action,
            adminId: userId,
            adminUsername: user.username,
            extraVal: body.val ?? body.text,
        })
        return json({ ok: true })
    }

    return json({}, 404)
}

async function runScheduled(env: Env): Promise<void> {
    const db = new Database(env.DB)
    const bot = await getBot(env)

    const nowMs = Date.now()
    const due = await db.getPostsToPublish(nowMs)
    for (const post of due) {
        await publishPost(bot, db, { env, post })
    }

    // Ежечасная сверка pending-статусов (страховка от гонки при голосовании)
    if (new Date(nowMs).getUTCMinutes() === 0) {
        const fixed = await reconcilePendingStatuses(bot, db, env)
        if (fixed > 0) console.log(`Reconciled ${fixed} pending posts`)
    }
}

export default {
    async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })

        const url = new URL(req.url)

        if (req.method === 'POST' && url.pathname === '/webhook') {
            if (env.WEBHOOK_SECRET && req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
                return new Response('Forbidden', { status: 403 })
            }
            try {
                const update = (await req.json()) as Update
                ctx.waitUntil(
                    getBot(env)
                        .then((bot) => bot.handleUpdate(update))
                        .catch((e: unknown) => console.error('Update failed:', e))
                )
            } catch (e) {
                console.error('Webhook parse error:', e)
                return new Response('Bad Request', { status: 400 })
            }
            return new Response('OK')
        }

        if (url.pathname === '/api') {
            try {
                return await handleApi(req, env)
            } catch (e) {
                console.error('API error:', e)
                return json({ error: 'Internal' }, 500)
            }
        }

        return new Response('Not Found', { status: 404 })
    },

    async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
        ctx.waitUntil(runScheduled(env).catch((e: unknown) => console.error('Scheduled error:', e)))
    },
}
