import type { Bot } from 'grammy'
import type { InputMedia } from '@grammyjs/types'
import { getRatingStatus, THRESHOLD } from './rating'
import { rebalanceQueue } from './scheduler'
import { stripHtml } from './tg'
import type { Database } from './db'
import type { Env } from './env'
import type { MediaItem, PostRow, PublishState, VoteRow } from './types'

export type { MediaItem }

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
    const [votesRows, totalAdmins] = await Promise.all([db.getPostVotes(postId), getAdminCount(bot, env)])
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
    if (!postData) {
        return false
    }

    switch (action) {
        case 'vote': {
            if (opts.adminId === undefined) {
                return false
            }
            const totalAdmins = await getAdminCount(bot, env)

            // Сериализация через ModerationHub: пересчёт и смена статуса
            // выполняются атомарно относительно других голосов этого поста
            const hubId = env.MODERATION.idFromName(postId)
            const res = await env.MODERATION.get(hubId).fetch('https://moderation.internal/vote', {
                method: 'POST',
                body: JSON.stringify({
                    postId,
                    adminId: opts.adminId,
                    adminUsername: opts.adminUsername ?? null,
                    val: Number(opts.extraVal),
                    totalAdmins,
                }),
            })
            if (!res.ok) throw new Error(`ModerationHub error ${res.status}`)
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
    const isFinal = ['scheduled', 'rejected', 'published'].includes(postData.status)

    const kb = getAdminKeyboard(postId, isFinal)
    kb.inline_keyboard.push([
        {
            text: 'Скопировать',
            copy_text: { text: stripHtml(postData.text) },
        },
    ])

    const statusLine = `Статус: <b>${STATUS_MAP[postData.status] ?? postData.status}</b>`
    const votesLines: string[] = []
    if (ana.votes_list) {
        votesLines.push(`Оценки: ${ana.votes_list} (Средняя: ${ana.res.estimation.toFixed(2)})`)
    }
    if (postData.status === 'pending' && !ana.res.is_final) {
        votesLines.push(`Прогноз: ${ana.res.min_estimation.toFixed(2)} — ${ana.res.max_estimation.toFixed(2)}`)
    }

    const mediaItems = parsePostMedia(postData.media)

    if (isRichCompatible(mediaItems)) {
        const built = buildArticleHtml(postData.text, mediaItems)
        if (built) {
            const seqPart = postData.sequence_number ? ` [${postData.sequence_number}]` : ''
            const headerHtml = `<p><b>От @${postData.username}${seqPart}:</b></p>`
            const statusSuffix = `<br/><p>${statusLine}</p>` + votesLines.map((l) => `<p>${l}</p>`).join('')
            try {
                await bot.api.raw.editMessageText({
                    chat_id: feedbackChatId(env),
                    message_id: postData.admin_msg_id,
                    rich_message: {
                        html: headerHtml + built.html + statusSuffix,
                        media: built.media_refs,
                    },
                    reply_markup: kb,
                })
                return
            } catch (e) {
                if (e instanceof Error && e.message.includes('message is not modified')) return
                console.warn('Rich edit failed, falling back to text card:', e)
            }
        }
    }

    const seqPart = postData.sequence_number ? ` [${postData.sequence_number}]` : ''
    const textParts = [
        `<b>От @${postData.username}${seqPart}:</b>`,
        postData.text,
    ]

    const mediaCount = postMediaCount(postData.media)
    if (mediaCount > 0) textParts.push(`📷 Медиа: ${mediaCount}`)

    textParts.push(statusLine, ...votesLines)
    const newText = textParts.join('\n\n')

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

export type PublishablePost = Pick<PostRow, 'id' | 'text' | 'user_id' | 'admin_msg_id' | 'media'>

export function parsePostMedia(raw: string | null): MediaItem[] {
    if (!raw) return []
    try {
        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed
            .filter((m): m is MediaItem =>
                typeof m === 'object' &&
                m !== null &&
                typeof (m as MediaItem).file_id === 'string' &&
                typeof (m as MediaItem).type === 'string'
            )
            .map((m) => ({
                type: m.type,
                file_id: m.file_id,
                ...(typeof (m as MediaItem).caption_above === 'boolean'
                    ? { caption_above: (m as MediaItem).caption_above }
                    : {}),
            }))
    } catch {
        return []
    }
}

export function postMediaCount(raw: string | null): number {
    return parsePostMedia(raw).length
}

export interface BuiltArticle {
    html: string
    media_refs: (
        | { id: string; media: { type: 'photo'; media: string } }
        | { id: string; media: { type: 'video'; media: string } }
    )[]
}

/**
 * Собирает HTML статьи для Rich Messages.
 * groupCaptionHtml — единая подпись ко всей группе медиа (позиция по caption_above первого элемента).
 * При двух и более медиа они оборачиваются в tg-slideshow (карусель).
 * Возвращает null, если типы медиа нельзя показать внутри статьи (документы, аудио).
 */
export function buildArticleHtml(groupCaptionHtml: string, items: MediaItem[]): BuiltArticle | null {
    if (items.length === 0) return null
    if (!items.every((m) => m.type === 'photo' || m.type === 'video')) return null

    const refs: BuiltArticle['media_refs'] = []
    let slideshow = ''

    items.forEach((item, i) => {
        const id = `p${i + 1}`
        refs.push(
            item.type === 'photo'
                ? { id, media: { type: 'photo', media: item.file_id } }
                : { id, media: { type: 'video', media: item.file_id } }
        )

        const tag =
            item.type === 'photo'
                ? `<img src="tg://photo?id=${id}"/>`
                : `<video src="tg://video?id=${id}"></video>`
        slideshow += tag
    })

    const mediaHtml =
        items.length === 1
            ? slideshow
            : `<tg-slideshow>${slideshow}</tg-slideshow>`

    const capPart = (() => {
        if (!groupCaptionHtml) return ''
        const parts = groupCaptionHtml.split(/\n{2,}/)
        return parts
            .map((part) => {
                const trimmed = part.trim()
                if (!trimmed) return ''
                if (/<(blockquote|pre)\b/.test(trimmed)) {
                    const idx = trimmed.indexOf('<blockquote')
                    const preIdx = trimmed.indexOf('<pre')
                    const blockIdx =
                        idx === -1 ? preIdx : preIdx === -1 ? idx : Math.min(idx, preIdx)
                    if (blockIdx > 0) {
                        const before = trimmed.slice(0, blockIdx).trim()
                        const block = trimmed.slice(blockIdx).replace(/\n/g, '<br/>')
                        const beforeHtml = before ? `<p>${before.replace(/\n/g, '<br/>')}</p>` : ''
                        return beforeHtml + block
                    }
                    return trimmed.replace(/\n/g, '<br/>')
                }
                return `<p>${trimmed.replace(/\n/g, '<br/>')}</p>`
            })
            .join('')
    })()

    const above = items[0].caption_above === true
    const html = above ? capPart + mediaHtml : mediaHtml + capPart

    return { html, media_refs: refs }
}

export function isRichCompatible(items: MediaItem[]): boolean {
    return items.length > 0 && items.every((m) => m.type === 'photo' || m.type === 'video')
}

export function richMessageFromArticle(built: BuiltArticle): { html: string; media: BuiltArticle['media_refs'] } {
    return { html: built.html, media: built.media_refs }
}

const PUBLISH_STATE_KEY = 'publish_state'
const MAX_PUBLISH_FAILURES = 3

function emptyPublishState(): PublishState {
    return { consecutive_failures: 0, paused: false, last_error: null, failed_post_id: null }
}

export async function getPublishState(db: Database): Promise<PublishState> {
    return (await db.getConfig('publish_state')) ?? emptyPublishState()
}

function describeError(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e)
    // grammY оборачивает описание Telegram в скобках — достаём суть
    const m = raw.match(/\((\d{3}: .+)\)/)
    return m ? m[1] : raw
}

function isD1Error(description: string): boolean {
    return /D1_ERROR|D1.*timeout|exceeded timeout|storage operation exceeded/i.test(description)
}

function failureHint(description: string): string {
    if (isD1Error(description)) return 'база D1 временно перегружена — повторится автоматически, пауза не ставится'
    if (/chat not found/i.test(description)) return 'бот не админ канала публикации или неверный CHANNEL_ID'
    if (/not enough rights|not a member|kicked/i.test(description))
        return 'нет прав на отправку в канал: проверьте роль бота'
    if (/parse entities/i.test(description)) return 'не удалось разобрать HTML поста'
    if (/blocked|deactivated/i.test(description)) return 'канал недоступен или бот заблокирован'
    return 'смотрите документацию Bot API по этой ошибке'
}

async function notifyAdmins(bot: Bot, env: Env, html: string): Promise<void> {
    try {
        await bot.api.sendMessage(feedbackChatId(env), html, { parse_mode: 'HTML' })
    } catch (e) {
        console.error('Failed to notify admins:', e)
    }
}

interface PublishOpts {
    env: Env
    post: PublishablePost
}

/**
 * Ручная публикация игнорирует паузу: это явное действие админа,
 * а её успех заодно снимает предохранитель.
 */
export async function publishPost(bot: Bot, db: Database, opts: PublishOpts): Promise<void> {
    const { env, post } = opts
    try {
        const mediaItems = parsePostMedia(post.media ?? null)

        // Канал публикуем только простыми сообщениями;
        // rich-статья предназначена исключительно для чата модерации
        await sendToChannel(bot, env, post.text, mediaItems)
        await finalizePublished(bot, db, env, post)
    } catch (e) {
        console.error('Publish error:', e)
        await handlePublishFailure(bot, db, env, post.id, describeError(e))
    }
}

async function finalizePublished(bot: Bot, db: Database, env: Env, post: PublishablePost): Promise<void> {
    await db.updatePostStatus(post.id, 'published', Date.now())

    const st = await getPublishState(db)
    if (st.consecutive_failures > 0 || st.paused) {
        await db.setConfig(PUBLISH_STATE_KEY, emptyPublishState())
        await notifyAdmins(bot, env, '✅ <b>Публикация снова работает</b>')
    }

    await Promise.allSettled([
        bot.api.sendMessage(post.user_id, '🎉 Ваш пост опубликован!').catch((e) => console.warn(`Failed to notify author ${post.user_id}:`, e)),
        rebalanceQueue(db).catch((e) => console.error('rebalance failed', e)),
        post.admin_msg_id ? refreshAdminMessage(bot, db, { env, postId: post.id }).catch((e) => console.error('refresh failed', e)) : Promise.resolve(),
    ])
}

async function sendToChannel(
    bot: Bot,
    env: Env,
    text: string,
    mediaItems: MediaItem[]
): Promise<void> {
    const channel = env.CHANNEL_ID

    if (mediaItems.length === 0) {
        try {
            await bot.api.sendMessage(channel, text, { parse_mode: 'HTML' })
        } catch {
            await bot.api.sendMessage(channel, stripHtml(text))
        }
        return
    }

    if (mediaItems.length === 1) {
        const m = mediaItems[0]
        try {
            await sendSingleMedia(bot, channel, m, text)
            return
        } catch {
            await sendSingleMedia(bot, channel, m, stripHtml(text), false)
            return
        }
    }

    const captionAbove = mediaItems[0].caption_above === true

    const buildGroup = (caption: string, parseMode: boolean) =>
        mediaItems.map((m, i) => ({
            type: m.type,
            media: m.file_id,
            ...(i === 0
                ? {
                      caption,
                      show_caption_above_media: m.caption_above === true,
                      ...(parseMode ? { parse_mode: 'HTML' as const } : {}),
                  }
                : {}),
        })) as unknown as Parameters<typeof bot.api.sendMediaGroup>[1]

    try {
        await bot.api.sendMediaGroup(channel, buildGroup(text, true))
    } catch {
        await bot.api.sendMediaGroup(channel, buildGroup(stripHtml(text), false))
    }
}

async function sendSingleMedia(
    bot: Bot,
    channel: string,
    m: MediaItem,
    caption: string,
    parseMode = true
): Promise<void> {
    const options = {
        caption,
        show_caption_above_media: m.caption_above === true,
        ...(parseMode ? { parse_mode: 'HTML' as const } : {}),
    }
    switch (m.type) {
        case 'photo':
            return void (await bot.api.sendPhoto(channel, m.file_id, options))
        case 'video':
            return void (await bot.api.sendVideo(channel, m.file_id, options))
        case 'document':
            return void (await bot.api.sendDocument(channel, m.file_id, options))
        case 'audio':
            return void (await bot.api.sendAudio(channel, m.file_id, options))
    }
}

async function handlePublishFailure(
    bot: Bot,
    db: Database,
    env: Env,
    postId: string,
    description: string
): Promise<void> {
    if (isD1Error(description)) {
        await notifyAdmins(
            bot,
            env,
            `⚠️ <b>D1 таймаут</b> [${postId}]\n${description}\nПодсказка: ${failureHint(description)}`
        )
        return
    }

    const st = await getPublishState(db)
    st.consecutive_failures += 1
    st.last_error = description
    st.failed_post_id = postId

    const attempt = st.consecutive_failures
    const pauseNow = !st.paused && attempt >= MAX_PUBLISH_FAILURES
    if (pauseNow) st.paused = true
    await db.setConfig(PUBLISH_STATE_KEY, st)

    let msg =
        `🚨 <b>ОШИБКА ПУБЛИКАЦИИ</b> [${postId}]\n` +
        `Причина: ${description}\n` +
        `Подсказка: ${failureHint(description)}\n` +
        `Попытка ${attempt} из ${MAX_PUBLISH_FAILURES}`
    if (pauseNow) {
        msg +=
            '\n\n⏸ <b>Публикация ПРИОСТАНОВЛЕНА</b> — крон больше не пытается.\n' +
            'После исправления пришлите /resume_publish'
    }
    await notifyAdmins(bot, env, msg)
}

export async function resumePublish(db: Database): Promise<string> {
    const st = await getPublishState(db)
    if (!st.paused && st.consecutive_failures === 0) {
        return 'Публикация и не была приостановлена'
    }
    await db.setConfig(PUBLISH_STATE_KEY, emptyPublishState())
    return '▶️ Публикация возобновлена'
}

export async function resendMissingAdminMessages(bot: Bot, db: Database, env: Env): Promise<number> {
    const missing = await db.getPostsWithMissingAdminMsg()
    let sent = 0
    for (const post of missing.slice(0, 2)) {
        try {
            const mediaItems = parsePostMedia(post.media)
            const built = isRichCompatible(mediaItems) ? buildArticleHtml(post.text, mediaItems) : null
            const kb = getAdminKeyboard(post.id, false)
            kb.inline_keyboard.push([{ text: 'Скопировать', copy_text: { text: stripHtml(post.text) } }])
            let adminMsgId: number | undefined
            if (built) {
                const article = richMessageFromArticle(built)
                const msg = await bot.api.raw.sendRichMessage({
                    chat_id: feedbackChatId(env),
                    rich_message: { html: `<p><b>От @${post.username}:</b></p>` + article.html, media: article.media },
                    reply_markup: kb,
                })
                adminMsgId = msg.message_id
            } else {
                const msg = await bot.api.sendMessage(
                    feedbackChatId(env),
                    `<b>От @${post.username}:</b>\n\n${post.text}`,
                    { parse_mode: 'HTML', reply_markup: kb }
                )
                adminMsgId = msg.message_id
            }
            await db.updatePostAdminMsg(post.id, adminMsgId)
            sent++
        } catch {}
    }
    return sent
}
