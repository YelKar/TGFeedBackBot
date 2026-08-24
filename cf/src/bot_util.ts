import type { Bot } from 'grammy'
import { getRatingStatus, THRESHOLD } from './rating'
import { rebalanceQueue } from './scheduler'
import { stripHtml } from './tg'
import type { Database } from './db'
import type { Env } from './env'
import type { PostRow, VoteRow } from './types'

export function feedbackChatId(env: Env): number {
    return Number(env.CHAT_ID)
}

export async function verifyTgData(initData: string, token: string): Promise<boolean> {
    try {
        const params = new URLSearchParams(initData)
        const receivedHash = params.get('hash')
        if (!receivedHash) return false
        params.delete('hash')

        const dataCheckString = [...params.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => `${k}=${v}`)
            .join('\n')

        const enc = new TextEncoder()
        const intermediateKey = await crypto.subtle.importKey(
            'raw',
            enc.encode('WebAppData'),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        )
        const secret = await crypto.subtle.sign('HMAC', intermediateKey, enc.encode(token))
        const hmacKey = await crypto.subtle.importKey(
            'raw',
            secret,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        )
        const signature = await crypto.subtle.sign('HMAC', hmacKey, enc.encode(dataCheckString))
        const computed = [...new Uint8Array(signature)]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        return computed === receivedHash
    } catch {
        return false
    }
}

export interface TgWebAppUser {
    id?: number
    username?: string
}

export function getUserFromData(initData: string): TgWebAppUser {
    try {
        const raw = new URLSearchParams(initData).get('user')
        return raw ? JSON.parse(raw) : {}
    } catch {
        return {}
    }
}

const ADMIN_TTL_MS = 600_000 // 10 минут
const adminCache: { count: number; expiresAt: number } = { count: 1, expiresAt: 0 }

export async function getAdminCount(bot: Bot, env: Env): Promise<number> {
    if (Date.now() < adminCache.expiresAt) return adminCache.count
    try {
        const admins = await bot.api.getChatAdministrators(feedbackChatId(env))
        const count = admins.filter((a) => !a.user.is_bot).length
        adminCache.count = count
        adminCache.expiresAt = Date.now() + ADMIN_TTL_MS
        return count
    } catch (e) {
        console.error('Error fetching admins:', e)
        return adminCache.count
    }
}

export interface Analytics {
    res: ReturnType<typeof getRatingStatus>
    votes_list: string
    is_approved: boolean
    is_rejected: boolean
}

/** Чистый расчёт без обращений к БД/API. */
export function calculateAnalytics(votesRows: VoteRow[], totalAdmins: number): Analytics {
    const scores = votesRows.map((v) => v.vote)
    const votesList = votesRows.map((v) => `@${v.admin_username}: ${v.vote}`).join(', ')

    const res = getRatingStatus(scores, totalAdmins)

    return {
        res,
        votes_list: votesList,
        is_approved: res.is_guaranteed_approved || (res.is_final && res.estimation >= THRESHOLD),
        is_rejected: res.is_guaranteed_rejected || (res.is_final && res.estimation < THRESHOLD),
    }
}

export async function getPostAnalytics(bot: Bot, env: Env, db: Database, postId: string): Promise<Analytics> {
    const votesRows = await db.getPostVotes(postId)
    const totalAdmins = await getAdminCount(bot, env)
    return calculateAnalytics(votesRows, totalAdmins)
}

export type Action = 'vote' | 'reject' | 'schedule' | 'publish_now' | 'edit' | 'block'

export interface ActionOpts {
    env: Env
    postId: string
    action: Action
    adminId?: number
    adminUsername?: string
    extraVal?: string | number
}

export async function applyAction(bot: Bot, db: Database, opts: ActionOpts): Promise<boolean> {
    const { env, postId, action } = opts

    const postData = await db.getPost(postId)
    if (!postData) return false

    switch (action) {
        case 'vote': {
            if (opts.adminId === undefined) return false
            const totalAdmins = await getAdminCount(bot, env)
            await db.addVote(postId, opts.adminId, opts.adminUsername ?? null, Number(opts.extraVal))

            // Оптимистичное обновление статуса: гонку параллельных голосов
            // заживляет ежечасная сверка в cron (reconcilePendingStatuses)
            const rows = await db.getPostVotes(postId)
            const ana = calculateAnalytics(rows, totalAdmins)
            if (ana.is_approved) {
                await db.updatePostStatus(postId, 'scheduled')
            } else if (ana.is_rejected) {
                await db.updatePostStatus(postId, 'rejected')
            }
            break
        }
        case 'reject':
            await db.updatePostStatus(postId, 'rejected')
            break
        case 'schedule':
            await db.updatePostStatus(postId, 'scheduled')
            break
        case 'publish_now':
            await publishPost(bot, db, { env, post: postData })
            return true
        case 'edit':
            await db.updatePostText(postId, String(opts.extraVal))
            break
        case 'block':
            await db.blockUser(postData.user_id)
            await db.updatePostStatus(postId, 'rejected')
            break
    }

    if (['vote', 'reject', 'schedule', 'block'].includes(action)) {
        await rebalanceQueue(db)
    }

    await refreshAdminMessage(bot, db, { env, postId })
    return true
}

const STATUS_MAP: Record<string, string> = {
    pending: '⏳ В ОЖИДАНИИ',
    scheduled: '📅 ОДОБРЕНО (В очереди)',
    rejected: '❌ ОТКЛОНЕНО',
    published: '✅ ОПУБЛИКОВАНО',
}

type InlineButton = { text: string; callback_data: string } | { text: string; copy_text: { text: string } }

function getAdminKeyboard(postId: string, isFinal: boolean): { inline_keyboard: InlineButton[][] } {
    const rows: InlineButton[][] = []
    if (!isFinal) {
        rows.push([1, 2, 3, 4, 5].map((i) => ({ text: String(i), callback_data: `v:${i}:${postId}` })))
    }
    rows.push([{ text: 'ОТКЛОНИТЬ', callback_data: `reject:${postId}` }])
    return { inline_keyboard: rows }
}

interface RefreshOpts {
    env: Env
    postId: string
}

export async function refreshAdminMessage(bot: Bot, db: Database, opts: RefreshOpts): Promise<void> {
    const { env, postId } = opts
    const postData = await db.getPost(postId)
    if (!postData || !postData.admin_msg_id) return

    const ana = await getPostAnalytics(bot, env, db, postId)

    const seqPart = postData.sequence_number ? ` [${postData.sequence_number}]` : ''
    const textParts = [
        `<b>От @${postData.username}${seqPart}:</b>`,
        postData.text,
        `Статус: <b>${STATUS_MAP[postData.status] ?? postData.status}</b>`,
    ]

    if (ana.votes_list) {
        textParts.push(`Оценки: ${ana.votes_list} (Средняя: ${ana.res.estimation.toFixed(2)})`)
    }

    if (postData.status === 'pending' && !ana.res.is_final) {
        textParts.push(`Прогноз: ${ana.res.min_estimation.toFixed(2)} — ${ana.res.max_estimation.toFixed(2)}`)
    }

    const newText = textParts.join('\n\n')
    const isFinal = ['scheduled', 'rejected', 'published'].includes(postData.status)

    const kb = getAdminKeyboard(postId, isFinal)
    kb.inline_keyboard.push([
        {
            text: 'Скопировать',
            copy_text: { text: stripHtml(postData.text) },
        },
    ])

    try {
        await bot.api.editMessageText(feedbackChatId(env), postData.admin_msg_id, newText, {
            parse_mode: 'HTML',
            reply_markup: kb,
        })
    } catch (e) {
        if (!(e instanceof Error && e.message.includes('message is not modified'))) {
            console.error('UI Update Error:', e)
        }
    }
}

export type PublishablePost = Pick<PostRow, 'id' | 'text' | 'user_id' | 'admin_msg_id'>

export async function publishPost(
    bot: Bot,
    db: Database,
    opts: { env: Env; post: PublishablePost }
): Promise<void> {
    const { env, post } = opts
    try {
        await bot.api.sendMessage(Number(env.CHANNEL_ID), post.text)

        await db.updatePostStatus(post.id, 'published', Date.now())

        try {
            await bot.api.sendMessage(post.user_id, '🎉 Ваш пост опубликован!')
        } catch (e) {
            console.warn(`Failed to notify author ${post.user_id}:`, e)
        }

        await rebalanceQueue(db)

        if (post.admin_msg_id) {
            await refreshAdminMessage(bot, db, { env, postId: post.id })
        }
    } catch (e) {
        console.error('Publish error:', e)
        await notifyInternalError(bot, env)
    }
}

async function notifyInternalError(bot: Bot, env: Env): Promise<void> {
    try {
        await bot.api.sendMessage(feedbackChatId(env), '<b>Внутренняя ошибка</b>', {
            parse_mode: 'HTML',
        })
    } catch {
        // некуда сообщать
    }
}

/** Заживляет пропущенные при гонке голосования переходы pending → scheduled/rejected. */
export async function reconcilePendingStatuses(bot: Bot, db: Database, env: Env): Promise<number> {
    const totalAdmins = await getAdminCount(bot, env)
    const entries = await db.getPendingPostsWithVotes()
    let changed = 0

    for (const { post, votes } of entries) {
        const ana = calculateAnalytics(votes, totalAdmins)

        let newStatus: 'scheduled' | 'rejected' | null = null
        if (ana.is_approved) newStatus = 'scheduled'
        else if (ana.is_rejected) newStatus = 'rejected'

        if (newStatus) {
            await db.updatePostStatus(post.id, newStatus)
            changed++
            await refreshAdminMessage(bot, db, { env, postId: post.id })
        }
    }

    if (changed > 0) {
        await rebalanceQueue(db)
    }
    return changed
}
