import {Bot, type Context} from 'grammy'
import type {InlineKeyboardMarkup, Message, UserFromGetMe} from '@grammyjs/types'
import {Database} from './db'
import type {Env} from './env'
import {
    applyAction,
    buildArticleHtml,
    feedbackChatId,
    isRichCompatible,
    parsePostMedia,
    refreshAdminMessage,
    resumePublish,
    richMessageFromArticle,
} from './bot_util'
import {rebalanceQueue, TZ_OFFSET_MS} from './scheduler'
import {escapeHtml, stripHtml, toHtml} from './tg'
import type {MediaItem, PostRow} from './types'

const USER_HELP = `
<h1>Справка</h1>
<details open><summary>Формат цитат</summary>
<blockquote>Текст цитаты</blockquote>
<p>© Автор</p>
<p><mark><b>Важно:</b> между автором и цитатой должна быть пустая строка</mark></p>
<p><mark><b>ОЧЕНЬ ВАЖНО:</b> пожалуйста, пишите граммотно, соблюдайте пунктуацию и перед отправкой тщательно проверяйте прафильность того, что вы хотите нам отправить.</mark></p>
<details>
<summary>Опционально</summary>

<p><b>Если в цитате или перед ней хотите указать какое-то пояснение, используйте следующий формат:</b></p>

<p><i>*Текст пояснения перед цитатой (<b>курсивом</b>, это важно)*</i></p>
<blockquote>
Текст цитаты до пояснения<br/>
<i>*Текст пояснения в цитате (<b>курсивом</b>, это важно)*</i><br/>
Текст цитаты после пояснения
</blockquote>

<p><mark>Если хотите добавить пояснение в самом конце (после автора), необходимо оставить пустую строку перед ним</mark></p>

</details>
</details>
<details><summary>Как это работает?</summary>
<p>⟹ Отправили — модераторы проверят и оценят.</p>
<p>⟸ Модератор может задать вопрос — отвечайте через функцию «Ответить» (Reply) на его сообщение.</p>
<p>✅ О результате публикации сообщим отдельно.</p>
</details>
<details><summary>Что можно отправлять?</summary>
<p>✍ Текст — просто напишите его.</p>
<p>📷 Фото или видео с подписью.</p>
<p>🖼 Альбом целиком — с одной общей подписью (если подписей несколько, альбом не примется).</p>
<p>Подпись появится там же, где вы её оставили: над медиа или под ним.</p>
</details>
<p><code>/start</code> — Начать.</p>
<p><code>/help</code> — Эта справка.</p>
</details>
`

const MODERATOR_HELP = `
<h1>Справка модератора</h1>
<details><summary>Управление постом</summary>
<p><code>/vote [1-5]</code> — Проголосовать (если кнопки скрыты).</p>
<p><code>/edit [текст]</code> — Изменить текст/подпись поста. Медиа не трогает.</p>
<p><code>/remove_photo N</code> — Удалить медиа №N.</p>
<p><code>/add_photo [N]</code> — Добавить медиа на позицию N: реплай на карточку, затем прислать фото следующим сообщением.</p>
<p><code>/cancel_add</code> — Отменить ожидание фото для <code>/add_photo</code>.</p>
<p><code>/ask [текст]</code> — Задать вопрос автору.</p>
<p><code>/schedule</code> — Одобрить и поставить в очередь публикаций.</p>
<p><code>/reject</code> — Отклонить или убрать из очереди.</p>
<p><code>/publish</code> — Опубликовать в канал НЕМЕДЛЕННО.</p>
<p><code>/block</code> — Забанить автора навсегда.</p>
<p><code>/use</code> — Предложка из сообщения-реплая (в т.ч. с медиа) либо из текста после команды.</p>
</details>
<details><summary>Очередь и публикации</summary>
<p><code>/queue</code> — Вся очередь публикаций.</p>
<p><code>/waiting</code> — Посты, ожидающие оценки.</p>
<p><code>/reschedule</code> — Пересчитать расписание заново.</p>
<p><code>/resume_publish</code> — Снять аварийную паузу публикации.</p>
<p><code>/reload</code> — Перерисовать карточку поста из БД.</p>
<p><code>/resend_missing</code> — Переотправить потерянные карточки.</p>
</details>
<details><summary>Приватные команды</summary>
<p>Добавьте <code>_p</code> к <b>информационной</b> команде, чтобы ответ видели только Вы и чат не засорялся: 
<br><code>/queue_p</code>, <code>/waiting_p</code>, <code>/help_p</code>.</p>
<p>Добавьте <code>_my</code> к <code>waiting</code>, чтобы каждый получил свои неоценённые посты: 
<br><code>/waiting_my</code> — каждому админу придёт личная подборка ссылок.</p>
</details>
`

let cachedToken: string | undefined
let cachedBot: Bot | undefined
let initPromise: Promise<Bot> | undefined

function buildBot(env: Env, cachedInfo: UserFromGetMe | null): Bot {
    const bot = cachedInfo ? new Bot(env.TOKEN, {botInfo: cachedInfo}) : new Bot(env.TOKEN)
    registerHandlers(bot, env)
    return bot
}

/**
 * Возвращает инициализированного бота (один на инстанс воркера).
 * grammY требует явный init() перед обработкой апдейтов в serverless-режиме.
 */
export async function getBot(env: Env): Promise<Bot> {
    if (cachedBot && cachedToken === env.TOKEN && initPromise) return initPromise

    const bootstrap = new Database(env.DB)
    const cachedInfo = await bootstrap.getConfig('bot_info')

    cachedBot = buildBot(env, cachedInfo)
    cachedToken = env.TOKEN

    if (cachedInfo) {
        // Кэш валиден только для текущего TOKEN; при ротации токена удалить ключ bot_info из config
        initPromise = Promise.resolve(cachedBot)
        return initPromise
    }

    initPromise = cachedBot
        .init()
        .then(async () => {
            try {
                await bootstrap.setConfig('bot_info', cachedBot!.botInfo)
            } catch (e) {
                console.warn('Failed to cache bot_info:', e)
            }
            return cachedBot as Bot
        })
        .catch((e: unknown) => {
            initPromise = undefined
            throw e
        })
    return initPromise
}

function registerHandlers(bot: Bot, env: Env): void {
    bot.use(async (ctx, next) => {
        const msg = ctx.msg
        if (!msg?.text?.startsWith('/')) {
            await next()
            return
        }
        const text = msg.text
        const atIdx = text.indexOf('@')
        const spaceIdx = text.indexOf(' ')
        if (atIdx !== -1 && (spaceIdx === -1 || atIdx < spaceIdx)) {
            const atEnd = text.slice(atIdx).search(/\s|$/)
            const end = atIdx + (atEnd === -1 ? text.length - atIdx : atEnd)
            const atLen = end - atIdx
            msg.text = text.slice(0, atIdx) + text.slice(end)
            const entities = msg.entities as unknown as { offset: number }[] | undefined
            if (entities) {
                for (const e of entities) {
                    if (e.offset > atIdx) e.offset -= atLen
                }
            }
        }
        await next()
    })

    const db = new Database(env.DB)
    const FB = (): number => feedbackChatId(env)

    async function isAdmin(userId: number): Promise<boolean> {
        try {
            const member = await bot.api.getChatMember(FB(), userId)
            return ['creator', 'administrator'].includes(member.status)
        } catch {
            return false
        }
    }

    /** Команда модератора: в чате модерации, ответом на карточку поста. */
    const inModThread = (ctx: Context): boolean =>
        !!ctx.msg && ctx.chat?.id === FB() && !!ctx.msg.reply_to_message

    /** Текст после /use (может быть многострочным). */
    const useBody = (ctx: Context): string =>
        (ctx.msg?.text ?? '').replace(/^\/use(?:@\w+)?\s*/, '').trim()

    const stripCmd = (text: string, name: string): string =>
        text.replace(new RegExp(`^/${name}(?:@\\w+)?\\s*`), '').trim()

    async function findPost(ctx: Context): Promise<Awaited<ReturnType<Database['getPostByAdminMsg']>>> {
        const rtm = ctx.msg?.reply_to_message
        if (!rtm) return null
        return db.getPostByAdminMsg(rtm.message_id)
    }

    async function handleHelp(ctx: Context, isPrivate: boolean): Promise<void> {
        const html = ctx.chat?.id === FB() ? MODERATOR_HELP : USER_HELP
        if (isPrivate) {
            await ctx.deleteMessage().catch(() => {
            })
            await bot.api.sendMessage(ctx.chat!.id, stripHtml(html), {
                receiver_user_id: ctx.from!.id,
            })
            return
        }
        await bot.api.raw.sendRichMessage({
            chat_id: ctx.chat!.id,
            rich_message: {html},
        })
    }

    bot.command('start', async (ctx) => {
        await ctx.reply('Привет! Это бот предложки.')
        await handleHelp(ctx, false)
    })
    bot.command('start_p').filter(async (ctx) => !!ctx.from, async (ctx) => handleHelp(ctx, true))
    bot.command('help', async (ctx) => handleHelp(ctx, false))
    bot.command('help_p').filter(async (ctx) => !!ctx.from, async (ctx) => handleHelp(ctx, true))
    bot.hears(/^\/help(?:@\w+)?(?:_p)?\b/, async (ctx) => {
        if (!ctx.from) return
        const isPrivate = /_p\b/.test(ctx.msg?.text ?? '')
        if (isPrivate && ctx.msg?.text?.includes('_p')) await handleHelp(ctx, true)
    })
    bot.hears(/^\/start(?:@\w+)?(?:_p)?\b/, async (ctx) => {
        if (!ctx.from) return
        const isPrivate = /_p\b/.test(ctx.msg?.text ?? '')
        if (isPrivate) {
            await ctx.reply('Привет! Это бот предложки.')
            await handleHelp(ctx, true)
        }
    })

    interface ProposalSrc {
        chatId: number
        messageId: number
        userId: number
        username: string
    }

    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

    async function submitProposal(src: ProposalSrc, html: string, mediaJson: string | null): Promise<void> {
        if (await db.isBlocked(src.userId)) return

        const postId = `${src.chatId}-${src.messageId}`
        await db.createPost(postId, src.userId, src.username, html, mediaJson)

        const kb: InlineKeyboardMarkup = {
            inline_keyboard: [
                [1, 2, 3, 4, 5].map((i) => ({text: String(i), callback_data: `v:${i}:${postId}`})),
            ],
        }

        const mediaItems = mediaJson ? parsePostMedia(mediaJson) : []
        const built = isRichCompatible(mediaItems) ? buildArticleHtml(html, mediaItems) : null

        let adminMsgId: number | undefined
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                if (built) {
                    try {
                        const article = richMessageFromArticle(built)
                        const richMsg = await bot.api.raw.sendRichMessage({
                            chat_id: FB(),
                            rich_message: {
                                html: `<p><b>От @${src.username || 'unknown'}:</b></p>` + article.html,
                                media: article.media,
                            },
                            reply_markup: kb,
                        })
                        adminMsgId = richMsg.message_id
                    } catch {
                        const adminMsg = await bot.api.sendMessage(
                            FB(),
                            `<b>От @${src.username || 'unknown'}:</b>\n\n${html}\n\n📷 Медиа: ${mediaItems.length}`,
                            {parse_mode: 'HTML', reply_markup: kb}
                        )
                        adminMsgId = adminMsg.message_id
                    }
                } else {
                    const mediaCount = mediaItems.length
                    const mediaBadge = mediaCount > 0 ? `\n\n📷 Медиа: ${mediaCount}` : ''
                    const adminMsg = await bot.api.sendMessage(
                        FB(),
                        `<b>От @${src.username || 'unknown'}:</b>\n\n${html}${mediaBadge}`,
                        {parse_mode: 'HTML', reply_markup: kb}
                    )
                    adminMsgId = adminMsg.message_id
                }
                await db.updatePostAdminMsg(postId, adminMsgId)
                break
            } catch (e) {
                if (attempt === 2) throw e
                await sleep(300 * (attempt + 1))
            }
        }

        if (src.chatId !== FB()) {
            await bot.api.sendMessage(src.chatId, 'Пост отправлен модераторам', {
                reply_parameters: {message_id: src.messageId},
            })
        }
    }

    async function newProposal(msg: Message): Promise<void> {
        if (!msg.from || !msg.text) return
        await submitProposal(
            {
                chatId: msg.chat.id,
                messageId: msg.message_id,
                userId: msg.from.id,
                username: msg.from.username ?? '',
            },
            toHtml(msg.text, msg.entities ?? []),
            null
        )
    }

    function extractMedia(msg: Message): {
        type: MediaItem['type']
        file_id: string
        captionHtml: string
        captionAbove: boolean
    } | null {
        const captionHtml = toHtml(msg.caption ?? '', msg.caption_entities ?? [])
        const captionAbove = msg.show_caption_above_media === true
        if (msg.photo) {
            const best = msg.photo[msg.photo.length - 1]
            return {type: 'photo', file_id: best.file_id, captionHtml, captionAbove}
        }
        if (msg.video?.file_id)
            return {type: 'video', file_id: msg.video.file_id, captionHtml, captionAbove}
        if (msg.document?.file_id)
            return {type: 'document', file_id: msg.document.file_id, captionHtml, captionAbove}
        if (msg.audio?.file_id)
            return {type: 'audio', file_id: msg.audio.file_id, captionHtml, captionAbove}
        return null
    }

    async function finalizeAlbum(groupId: string): Promise<void> {
        try {
            const rows = await db.getMediaGroupItems(groupId)
            if (rows.length === 0) return
            await db.deleteMediaGroupItems(groupId)

            const captioned = rows.filter((r) => r.caption)
            const last = rows[rows.length - 1]

            if (captioned.length > 1) {
                await bot.api.sendMessage(
                    last.chat_id,
                    '⚠️ У альбома должна быть одна общая подпись или без неё.\nОтправьте альбом заново.',
                    {reply_parameters: {message_id: last.message_id}}
                )
                return
            }

            const groupCaption = captioned[0]?.caption ?? ''
            const captionAbove = captioned.length > 0 && captioned[0].caption_above === 1
            const media: MediaItem[] = rows.map((r, i) => ({
                type: r.type as MediaItem['type'],
                file_id: r.file_id,
                ...(i === 0 && captionAbove ? {caption_above: true} : {}),
            }))

            await submitProposal(
                {
                    chatId: last.chat_id,
                    messageId: last.message_id,
                    userId: last.user_id,
                    username: last.username,
                },
                groupCaption,
                JSON.stringify(media)
            )
        } catch (e) {
            console.error('Album finalize failed:', e)
        }
    }

    const pendingAddPhoto = new Map<number, { postId: string; beforeIndex: number | null; expiresAt: number }>()
    const PENDING_TTL_MS = 5 * 60_000

    function extractFileId(msg: Message): { type: 'photo' | 'video'; file_id: string } | null {
        if (msg.photo) return {type: 'photo', file_id: msg.photo[msg.photo.length - 1].file_id}
        if (msg.video?.file_id) return {type: 'video', file_id: msg.video.file_id}
        return null
    }

    bot.on(['message:photo', 'message:video']).filter(
        (ctx) => {
            const pending = ctx.from ? pendingAddPhoto.get(ctx.from.id) : undefined
            return !!pending && pending.expiresAt > Date.now()
        },
        async (ctx) => {
            const from = ctx.from!
            const pending = pendingAddPhoto.get(from.id)!
            pendingAddPhoto.delete(from.id)

            if (!ctx.msg.from) return
            const extracted = extractFileId(ctx.msg)
            if (!extracted) {
                await ctx.reply('Нужен именно файл фото или видео.')
                return
            }

            const post = await db.getPost(pending.postId)
            if (!post) {
                await ctx.reply('Пост не найден.')
                return
            }

            const items = parsePostMedia(post.media)
            if (items.length >= 10) {
                await ctx.reply('Максимум 10 медиа в посте.')
                return
            }

            const insertIdx =
                pending.beforeIndex !== null ? Math.min(Math.max(pending.beforeIndex - 1, 0), items.length) : items.length
            items.splice(insertIdx, 0, extracted)
            await db.updatePostMedia(post.id, JSON.stringify(items))
            await refreshAdminMessage(bot, db, {env, postId: post.id})
            await ctx.reply(`✅ Медиа добавлено на позицию ${insertIdx + 1}`)
        }
    )

    bot.on(['message:photo', 'message:video', 'message:document', 'message:audio']).filter(
        (ctx) => ctx.chat?.id !== FB(),
        async (ctx) => {
            const msg = ctx.msg
            if (!msg.from) return

            const extracted = extractMedia(msg)
            if (!extracted) return

            const groupId = msg.media_group_id ?? null
            if (!groupId) {
                await submitProposal(
                    {
                        chatId: msg.chat.id,
                        messageId: msg.message_id,
                        userId: msg.from.id,
                        username: msg.from.username ?? '',
                    },
                    extracted.captionHtml,
                    JSON.stringify([
                        {
                            type: extracted.type,
                            file_id: extracted.file_id,
                            ...(extracted.captionHtml ? {caption_html: extracted.captionHtml} : {}),
                            caption_above: extracted.captionAbove,
                        },
                    ])
                )
                return
            }

            await db.addMediaGroupItem({
                groupId,
                type: extracted.type,
                fileId: extracted.file_id,
                caption: extracted.captionHtml || null,
                captionAbove: extracted.captionAbove,
                chatId: msg.chat.id,
                messageId: msg.message_id,
                userId: msg.from.id,
                username: msg.from.username ?? '',
            })

            await sleep(2200)
            const lastAt = await db.getMediaGroupLastAt(groupId)
            if (lastAt === null || Date.now() - lastAt < 1800) return
            await finalizeAlbum(groupId)
        }
    )

    bot.on('message:text').filter((ctx) => ctx.chat?.id !== FB(), async (ctx) => {
        const from = ctx.from
        if (!from) return
        if (await db.isBlocked(from.id)) return

        const msg = ctx.msg
        const rtm = msg.reply_to_message
        if (rtm && rtm.from?.id === bot.botInfo.id) {
            const dialogue = await db.getDialogue(rtm.message_id)
            if (dialogue) {
                const cleanChatIdAns = String(FB()).replace('-100', '')
                const postForAnswer = await db.getPost(dialogue.post_id)
                const displayId = postForAnswer?.sequence_number ? `#${postForAnswer.sequence_number}` : dialogue.post_id
                const answerHtml = toHtml(msg.text ?? '', msg.entities ?? []).replace(/\n/g, '<br/>')
                try {
                    await bot.api.raw.sendRichMessage({
                        chat_id: FB(),
                        rich_message: {
                            html: `<h2>Ответ автора @${from.username}</h2><p>По посту <a href="https://t.me/c/${cleanChatIdAns}/${postForAnswer?.admin_msg_id}">${displayId}</a></p><hr/><p>${answerHtml}</p>`,
                        },
                        reply_parameters: {message_id: dialogue.admin_msg_id},
                    })
                } catch {
                    await bot.api.sendMessage(
                        FB(),
                        `<b>Ответ автора @${from.username}</b>\nПо посту <a href="https://t.me/c/${cleanChatIdAns}/${postForAnswer?.admin_msg_id}">${displayId}</a>\n\n${escapeHtml(msg.text ?? '')}`,
                        {parse_mode: 'HTML', reply_to_message_id: dialogue.admin_msg_id}
                    )
                }
                await ctx.reply('Сообщение передано')
                return
            }
        }

        await newProposal(msg)
    })

    bot.callbackQuery(/^v:(\d+):(.+)$/, async (ctx) => {
        const t0 = Date.now()
        const match = ctx.match
        if (!match) return
        try {
            await applyAction(bot, db, {
                env,
                postId: match[2],
                action: 'vote',
                adminId: ctx.from.id,
                adminUsername: ctx.from.username,
                extraVal: Number(match[1]),
            })
        } finally {
            await ctx.answerCallbackQuery(`Голос ${match[1]} принят`)
        }
    })

    bot.callbackQuery(/^reject:(.+)$/, async (ctx) => {
        const match = ctx.match
        if (!match) return
        try {
            await applyAction(bot, db, {env, postId: match[1], action: 'reject'})
        } finally {
            await ctx.answerCallbackQuery('Отклонено')
        }
    })

    bot.callbackQuery(/^schedule:(.+)$/, async (ctx) => {
        const match = ctx.match
        if (!match) return
        try {
            await applyAction(bot, db, {env, postId: match[1], action: 'schedule'})
        } finally {
            await ctx.answerCallbackQuery('В очереди')
        }
    })

    bot.command('publish').filter(inModThread, async (ctx) => {
        const post = await findPost(ctx)
        if (post) {
            await applyAction(bot, db, {env, postId: post.id, action: 'publish_now'})
        }
        await ctx.deleteMessage()
    })

    bot.command('schedule').filter(inModThread, async (ctx) => {
        const post = await findPost(ctx)
        if (post) {
            await applyAction(bot, db, {env, postId: post.id, action: 'schedule'})
        }
        await ctx.deleteMessage()
    })

    bot.command('reject').filter(inModThread, async (ctx) => {
        const post = await findPost(ctx)
        if (post) {
            await applyAction(bot, db, {env, postId: post.id, action: 'reject'})
        }
        await ctx.deleteMessage()
    })

    bot.command('block').filter(inModThread, async (ctx) => {
        const from = ctx.from
        if (!from) return
        const post = await findPost(ctx)
        if (post && (await isAdmin(from.id))) {
            await applyAction(bot, db, {env, postId: post.id, action: 'block'})
            await ctx.deleteMessage()
            await ctx.reply(`Пользователь ${post.user_id} заблокирован`)
        }
    })

    async function voteLogic(msg: Message): Promise<void> {
        const rtm = msg.reply_to_message
        if (!rtm || !msg.text || !msg.from) return
        const post = await db.getPostByAdminMsg(rtm.message_id)
        if (!post) return

        try {
            const score = parseInt(stripCmd(msg.text, 'vote'), 10)
            if (!(score >= 1 && score <= 5)) throw new RangeError(String(score))
            await applyAction(bot, db, {
                env,
                postId: post.id,
                action: 'vote',
                adminId: msg.from.id,
                adminUsername: msg.from.username,
                extraVal: score,
            })
            await bot.api.deleteMessage(msg.chat.id, msg.message_id)
        } catch {
            await bot.api.sendMessage(msg.chat.id, 'Введи число от 1 до 5', {
                reply_parameters: {message_id: msg.message_id},
            })
        }
    }

    bot.command('vote').filter(inModThread, async (ctx) => voteLogic(ctx.msg))

    async function editLogic(msg: Message): Promise<void> {
        const rtm = msg.reply_to_message
        if (!rtm || !msg.text) return
        const post = await db.getPostByAdminMsg(rtm.message_id)
        if (!post) return

        const m = msg.text.match(/^\/edit(?:@\w+)?\s*/)
        if (!m) return
        const contentStart = m[0].length
        const rawTail = msg.text.slice(contentStart)
        const trimmedContent = rawTail.trim()
        if (!trimmedContent) return
        const endOffset = contentStart + rawTail.length - (rawTail.length - rawTail.trimEnd().length)
        const adjustedEntities = (msg.entities ?? [])
            .filter((e) => e.offset >= contentStart && e.offset < endOffset)
            .map((e) => ({
                ...e,
                offset: e.offset - contentStart,
                length: Math.min(e.length, endOffset - e.offset),
            }))
            .filter((e) => e.length > 0)

        const htmlContent = toHtml(trimmedContent, adjustedEntities)
        if (htmlContent) {
            await applyAction(bot, db, {env, postId: post.id, action: 'edit', extraVal: htmlContent})
        }
        await bot.api.deleteMessage(msg.chat.id, msg.message_id)
    }

    bot.command('edit').filter(inModThread, async (ctx) => editLogic(ctx.msg))

    bot.on('edited_message:text').filter(
        (ctx) =>
            ctx.chat?.id === FB() &&
            !!ctx.msg.reply_to_message &&
            (/^\/vote(?:@\w+)?\b/.test(ctx.msg.text) || /^\/edit(?:@\w+)?\b/.test(ctx.msg.text)),
        async (ctx) => {
            const text = ctx.msg.text
            if (/^\/vote(?:@\w+)?\b/.test(text)) await voteLogic(ctx.msg)
            else await editLogic(ctx.msg)
        }
    )

    bot.command('ask').filter(inModThread, async (ctx) => {
        try {
            const msg = ctx.msg
            const post = await findPost(ctx)
            if (!post) {
                console.warn('/ask: post not found for reply_to_message_id', ctx.msg.reply_to_message?.message_id)
                return
            }
            const text = stripCmd(msg.text ?? '', 'ask')
            if (!text) {
                console.warn('/ask: empty text after stripCmd', msg.text)
                return
            }

            const [userIdStr, origMsgIdStr] = post.id.split('-')
            let sent: { message_id: number }
            try {
                sent = await bot.api.raw.sendRichMessage({
                    chat_id: Number(userIdStr),
                    rich_message: {
                        html: `<h2>Сообщение от модератора</h2><p>${escapeHtml(text)}</p><footer><mark>Ответьте на это сообщение <b>функцией ответить / reply</b></mark></footer>`,
                    },
                    reply_parameters: {message_id: Number(origMsgIdStr)},
                })
            } catch {
                sent = await bot.api.sendMessage(
                    Number(userIdStr),
                    `<b>Сообщение от модератора:</b>\n\n${escapeHtml(text)}\n\nОтветьте на это сообщение функцией ответить / reply`,
                    {
                        parse_mode: 'HTML',
                        reply_parameters: {message_id: Number(origMsgIdStr)},
                    }
                )
            }
            await db.addDialogue(sent.message_id, msg.message_id, post.id)
            await bot.api.setMessageReaction(msg.chat.id, msg.message_id, [
                {type: 'emoji', emoji: '👍'},
            ])
        } catch (e) {
            console.error('/ask failed:', e)
        }
    })

    bot.command('use').filter(
        (ctx) => !!ctx.from && (!!ctx.msg?.reply_to_message || useBody(ctx).length > 0),
        async (ctx) => {
            const rtm = ctx.msg?.reply_to_message
            const from = ctx.from
            if (!from) return
            if (!(await isAdmin(from.id))) return

            if (rtm) {
                const extracted = extractMedia(rtm)
                if (extracted && rtm.from) {
                    await submitProposal(
                        {
                            chatId: rtm.chat.id,
                            messageId: rtm.message_id,
                            userId: rtm.from.id,
                            username: rtm.from.username ?? '',
                        },
                        extracted.captionHtml,
                        JSON.stringify([{type: extracted.type, file_id: extracted.file_id}])
                    )
                } else {
                    await newProposal(rtm)
                }
            } else {
                const msg = ctx.msg
                const m = msg.text?.match(/^\/use(?:@\w+)?\s*/)
                if (!m) return
                const contentStart = m[0].length
                const rawTail = msg.text!.slice(contentStart)
                const trimmedContent = rawTail.trim()
                if (!trimmedContent) return
                const endOffset = contentStart + rawTail.length - (rawTail.length - rawTail.trimEnd().length)
                const adjustedEntities = (msg.entities ?? [])
                    .filter((e) => e.offset >= contentStart && e.offset < endOffset)
                    .map((e) => ({
                        ...e,
                        offset: e.offset - contentStart,
                        length: Math.min(e.length, endOffset - e.offset),
                    }))
                    .filter((e) => e.length > 0)
                const htmlContent = toHtml(trimmedContent, adjustedEntities)
                if (!htmlContent) return
                await submitProposal(
                    {
                        chatId: msg.chat.id,
                        messageId: msg.message_id,
                        userId: from.id,
                        username: from.username ?? '',
                    },
                    htmlContent,
                    null
                )
            }
            await ctx.deleteMessage()
        }
    )

    const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    const p2 = (n: number): string => String(n).padStart(2, '0')

    function localDate(ms: number): Date {
        return new Date(ms + TZ_OFFSET_MS)
    }

    async function handleQueue(ctx: Context, isPrivate: boolean): Promise<void> {
        if (!ctx.chat || !ctx.from) return
        if (!(await isAdmin(ctx.from.id))) return
        const queue = await db.getScheduledQueue()
        if (queue.length === 0) {
            const extra: Record<string, unknown> = isPrivate ? {receiver_user_id: ctx.from.id} : {}
            if (isPrivate) await ctx.deleteMessage().catch(() => {
            })
            await bot.api.raw.sendRichMessage({
                chat_id: ctx.chat.id,
                rich_message: {html: `<p>📭 <b>Очередь пуста</b></p>`},
                ...extra,
            })
            return
        }
        const cleanChatId = String(FB()).replace('-100', '')
        let html = `<h1>📊 Очередь публикаций (${queue.length})</h1>`
        let currentDay: string | null = null
        for (const p of queue) {
            if (!p.publish_at) continue
            const d = localDate(p.publish_at)
            const dayStr = `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)} ${WD[(d.getUTCDay() + 6) % 7]}`
            const timeStr = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
            if (dayStr !== currentDay) {
                html += `<hr/><h2>📅 ${dayStr}</h2>`
                currentDay = dayStr
            }
            const linkHtml = p.admin_msg_id && p.sequence_number
                ? `<a href="https://t.me/c/${cleanChatId}/${p.admin_msg_id}">[${p.sequence_number}]</a>`
                : '—'
            html += `<p><b>${linkHtml}</b> <code>${timeStr}</code> — @${p.username}</p>`
        }
        if (isPrivate) {
            await ctx.deleteMessage().catch(() => {
            })
            const lines = [`<b>📊 Очередь публикаций (${queue.length})</b>`]
            let pDay: string | null = null
            for (const p of queue) {
                if (!p.publish_at) continue
                const d = localDate(p.publish_at)
                const dayStr = `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)} ${WD[(d.getUTCDay() + 6) % 7]}`
                const timeStr = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
                if (dayStr !== pDay) {
                    lines.push(`\n📅 <b>${dayStr}</b>`)
                    pDay = dayStr
                }
                const link = p.admin_msg_id && p.sequence_number
                    ? `<a href="https://t.me/c/${cleanChatId}/${p.admin_msg_id}">[${p.sequence_number}]</a>`
                    : '—'
                lines.push(`<b>${link}</b> <code>${timeStr}</code> @${p.username}`)
            }
            await bot.api.sendMessage(ctx.chat.id, lines.join('\n'), {
                parse_mode: 'HTML',
                link_preview_options: {is_disabled: true},
                receiver_user_id: ctx.from.id,
            })
            return
        }
        await bot.api.raw.sendRichMessage({
            chat_id: ctx.chat.id,
            rich_message: {html},
        })
    }

    bot.command('queue').filter(async (ctx) => !!ctx.from && (await isAdmin(ctx.from.id)), async (ctx) => handleQueue(ctx, false))
    bot.command('queue_p').filter(async (ctx) => !!ctx.from && (await isAdmin(ctx.from.id)), async (ctx) => handleQueue(ctx, true))
    bot.hears(/^\/queue(?:@\w+)?_p\b/, async (ctx) => {
        if (!ctx.from || !(await isAdmin(ctx.from.id))) return
        await handleQueue(ctx, true)
    })

    async function handleWaiting(ctx: Context, isPrivate: boolean): Promise<void> {
        if (!ctx.chat || !ctx.from) return
        if (!(await isAdmin(ctx.from.id))) return
        const pending = await db.getFilteredPosts({status: 'pending', limit: 20})
        if (pending.length === 0) {
            if (isPrivate) {
                await ctx.deleteMessage().catch(() => {
                })
                await bot.api.sendMessage(ctx.chat.id, '✅ <b>Очередь оценки пуста</b>', {
                    parse_mode: 'HTML',
                    receiver_user_id: ctx.from.id,
                })
            } else {
                await bot.api.raw.sendRichMessage({
                    chat_id: ctx.chat.id,
                    rich_message: {html: `<p>✅ <b>Очередь оценки пуста</b></p>`},
                })
            }
            return
        }
        const cleanChatId = String(FB()).replace('-100', '')
        const votes = await db.getVotesForPosts(pending.map((p) => p.id))
        const votesByPost = new Map<string, Set<string>>()
        for (const v of votes) {
            const s = votesByPost.get(v.post_id) ?? new Set<string>()
            if (v.admin_username) s.add(v.admin_username)
            votesByPost.set(v.post_id, s)
        }
        let adminUsernames: string[] = []
        try {
            const admins = await bot.api.getChatAdministrators(FB())
            adminUsernames = admins.filter((m) => !m.user.is_bot && m.user.username).map((m) => m.user.username!)
        } catch {
        }
        let html: string
        if (!isPrivate) {
            const byAuthor = new Map<string, typeof pending>()
            for (const p of [...pending].reverse()) {
                const arr = byAuthor.get(p.username) ?? []
                arr.push(p)
                byAuthor.set(p.username, arr)
            }
            html = `<h1>⏳ Ожидают оценки (${pending.length})</h1>`
            for (const [username, posts] of byAuthor) {
                html += `<h2>@${username}</h2>`
                if (posts.length === 1) {
                    const p = posts[0]
                    const d = localDate(p.created_at)
                    const dateStr = `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
                    if (p.admin_msg_id && p.sequence_number) {
                        const url = `https://t.me/c/${cleanChatId}/${p.admin_msg_id}`
                        html += `<p><a href="${url}">[${p.sequence_number}]</a> — ${dateStr}</p>`
                    } else {
                        html += `<p>🔘 — ${dateStr}</p>`
                    }
                    const voted = votesByPost.get(p.id) ?? new Set<string>()
                    const notRated = adminUsernames.filter((u) => !voted.has(u))
                    if (notRated.length > 0) {
                        html += `<p>не оценили: ${notRated.map((u) => `@${u}`).join(', ')}</p>`
                    }
                } else {
                    let i = 0
                    html += `<ol>`
                    for (const p of posts) {
                        i++
                        const d = localDate(p.created_at)
                        const dateStr = `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
                        html += `<li value="${i}">`
                        if (p.admin_msg_id) {
                            const url = `https://t.me/c/${cleanChatId}/${p.admin_msg_id}`
                            html += `<a href="${url}">${cleanChatId}-${p.admin_msg_id}</a> — ${dateStr}`
                        } else {
                            html += `🔘 — ${dateStr}`
                        }
                        const voted = votesByPost.get(p.id) ?? new Set<string>()
                        const notRated = adminUsernames.filter((u) => !voted.has(u))
                        if (notRated.length > 0) {
                            html += `<br>не оценили: ${notRated.map((u) => `@${u}`).join(', ')}`
                        }
                        html += `</li>`
                    }
                    html += `</ol>`
                }
            }
        } else {
            const lines: string[] = [`<b>⏳ Ожидают оценки (${pending.length})</b>`]
            const byAuthorElse = new Map<string, typeof pending>()
            for (const p of [...pending].reverse()) {
                const arr = byAuthorElse.get(p.username) ?? []
                arr.push(p)
                byAuthorElse.set(p.username, arr)
            }
            for (const [username, posts] of byAuthorElse) {
                lines.push(`\n<b>@${username}</b>`)
                if (posts.length === 1) {
                    const p = posts[0]
                    const d = localDate(p.created_at)
                    const dateStr = `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
                    const link = p.admin_msg_id && p.sequence_number
                        ? `<a href="https://t.me/c/${cleanChatId}/${p.admin_msg_id}">[${p.sequence_number}]</a>`
                        : '🔘'
                    lines.push(`${link} — ${dateStr}`)
                    const voted = votesByPost.get(p.id) ?? new Set<string>()
                    const notRated = adminUsernames.filter((u) => !voted.has(u))
                    if (notRated.length > 0) {
                        lines.push(`не оценили: ${notRated.map((u) => `@${u}`).join(', ')}`)
                    }
                } else {
                    let i = 0
                    for (const p of posts) {
                        i++
                        const d = localDate(p.created_at)
                        const dateStr = `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
                        const link = p.admin_msg_id && p.sequence_number
                            ? `<a href="https://t.me/c/${cleanChatId}/${p.admin_msg_id}">[${p.sequence_number}]</a>`
                            : '🔘'
                        lines.push(`${i}. ${link} — ${dateStr}`)
                    }
                    const allNotRated = new Set<string>()
                    for (const p of posts) {
                        const voted = votesByPost.get(p.id) ?? new Set<string>()
                        for (const u of adminUsernames) if (!voted.has(u)) allNotRated.add(u)
                    }
                    if (allNotRated.size > 0) {
                        lines.push(`не оценили: ${[...allNotRated].map((u) => `@${u}`).join(', ')}`)
                    }
                }
            }
            html = lines.join('\n')
        }
        if (isPrivate) {
            await ctx.deleteMessage().catch(() => {
            })
            await bot.api.sendMessage(ctx.chat.id, html, {
                parse_mode: 'HTML',
                link_preview_options: {is_disabled: true},
                receiver_user_id: ctx.from.id,
            })
            return
        }
        await bot.api.raw.sendRichMessage({
            chat_id: ctx.chat.id,
            rich_message: {html},
        })
    }

    bot.command('waiting').filter(async (ctx) => !!ctx.from && (await isAdmin(ctx.from.id)), async (ctx) => handleWaiting(ctx, false))
    bot.command('waiting_p').filter(async (ctx) => !!ctx.from && (await isAdmin(ctx.from.id)), async (ctx) => handleWaiting(ctx, true))
    bot.hears(/^\/waiting(?:@\w+)?_p\b/, async (ctx) => {
        if (!ctx.from || !(await isAdmin(ctx.from.id))) return
        await handleWaiting(ctx, true)
    })
    bot.hears(/^\/waiting_my(?:@\w+)?\b/, async (ctx) => {
        if (!ctx.from || !(await isAdmin(ctx.from.id))) return
        if (!ctx.chat) return
        const pending = await db.getFilteredPosts({status: 'pending', limit: 20})
        const votes = await db.getVotesForPosts(pending.map((p) => p.id))
        const votesByPost = new Map<string, Set<string>>()
        for (const v of votes) {
            const s = votesByPost.get(v.post_id) ?? new Set<string>()
            if (v.admin_username) s.add(v.admin_username)
            votesByPost.set(v.post_id, s)
        }
        let admins: { id: number; username: string }[] = []
        try {
            const members = await bot.api.getChatAdministrators(FB())
            admins = members
                .filter((m) => !m.user.is_bot && m.user.username)
                .map((m) => ({id: m.user.id, username: m.user.username!}))
        } catch {
        }
        const cleanChatId = String(FB()).replace('-100', '')
        await ctx.deleteMessage().catch(() => {
        })
        for (const admin of admins) {
            const personal = pending.filter((p) => !(votesByPost.get(p.id)?.has(admin.username)))
            if (personal.length === 0) continue
            const lines = [`<b>⏳ Твои неоценённые (${personal.length})</b>`]
            for (const p of [...personal].reverse()) {
                const d = localDate(p.created_at)
                const dateStr = `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
                const linkHtml = p.admin_msg_id && p.sequence_number
                    ? `<a href="https://t.me/c/${cleanChatId}/${p.admin_msg_id}">[${p.sequence_number}]</a>`
                    : '—'
                lines.push(`${linkHtml} @${p.username} — ${dateStr}`)
            }
            await bot.api.sendMessage(FB(), lines.join('\n'), {
                parse_mode: 'HTML',
                link_preview_options: {is_disabled: true},
                receiver_user_id: admin.id,
            })
        }
    })

    bot.command('reschedule').filter(async (ctx) => !!ctx.from && (await isAdmin(ctx.from.id)), async (ctx) => {
        await rebalanceQueue(db)
        await ctx.deleteMessage().catch(() => {
        })
        const queue = await db.getScheduledQueue()
        if (queue.length === 0) {
            await bot.api.sendMessage(ctx.chat!.id, '📭 <b>Очередь пуста</b> — обновлена', {
                parse_mode: 'HTML',
            })
            return
        }
        const cleanChatId = String(FB()).replace('-100', '')
        const lines = [`<b>📊 Очередь публикаций (${queue.length})</b> — обновлена`]
        let currentDay: string | null = null
        for (const p of queue) {
            if (!p.publish_at) continue
            const d = localDate(p.publish_at)
            const dayStr = `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)} ${WD[(d.getUTCDay() + 6) % 7]}`
            const timeStr = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
            if (dayStr !== currentDay) {
                lines.push(`\n📅 <b>${dayStr}</b>`)
                currentDay = dayStr
            }
            const linkHtml = p.admin_msg_id
                ? `<a href="https://t.me/c/${cleanChatId}/${p.admin_msg_id}">🔗</a>`
                : '🔘'
            lines.push(`<b>[${p.sequence_number ?? '—'}]</b> <code>${timeStr}</code> ${linkHtml} @${p.username}`)
        }
        await bot.api.sendMessage(ctx.chat!.id, lines.join('\n'), {
            parse_mode: 'HTML',
            link_preview_options: {is_disabled: true},
        })
    })

    bot.command('resume_publish').filter(async (ctx) => !!ctx.from && (await isAdmin(ctx.from.id)), async (ctx) => {
        await ctx.reply(await resumePublish(db))
    })

    async function resendMissingForPost(post: PostRow): Promise<void> {
        const mediaItems = post.media ? parsePostMedia(post.media) : []
        const built = isRichCompatible(mediaItems) ? buildArticleHtml(post.text, mediaItems) : null
        const kb: InlineKeyboardMarkup = {
            inline_keyboard: [
                [1, 2, 3, 4, 5].map((i) => ({text: String(i), callback_data: `v:${i}:${post.id}`})),
            ],
        }
        let adminMsgId: number | undefined
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                if (built) {
                    try {
                        const article = richMessageFromArticle(built)
                        const richMsg = await bot.api.raw.sendRichMessage({
                            chat_id: FB(),
                            rich_message: {
                                html: `<p><b>От @${post.username || 'unknown'}:</b></p>` + article.html,
                                media: article.media,
                            },
                            reply_markup: kb,
                        })
                        adminMsgId = richMsg.message_id
                    } catch {
                        const adminMsg = await bot.api.sendMessage(
                            FB(),
                            `<b>От @${post.username || 'unknown'}:</b>\n\n${post.text}\n\n📷 Медиа: ${mediaItems.length}`,
                            {parse_mode: 'HTML', reply_markup: kb}
                        )
                        adminMsgId = adminMsg.message_id
                    }
                } else {
                    const adminMsg = await bot.api.sendMessage(
                        FB(),
                        `<b>От @${post.username || 'unknown'}:</b>\n\n${post.text}`,
                        {parse_mode: 'HTML', reply_markup: kb}
                    )
                    adminMsgId = adminMsg.message_id
                }
                await db.updatePostAdminMsg(post.id, adminMsgId)
                break
            } catch (e) {
                if (attempt === 2) throw e
                await sleep(300 * (attempt + 1))
            }
        }
    }

    bot.command('resend_missing').filter(async (ctx) => !!ctx.from && (await isAdmin(ctx.from.id)), async (ctx) => {
        const missing = await db.getPostsWithMissingAdminMsg()
        if (missing.length === 0) {
            await ctx.reply('✅ Пропущенных карточек нет')
            return
        }
        let ok = 0
        for (const post of missing) {
            try {
                await resendMissingForPost(post)
                ok++
            } catch {
            }
        }
        await ctx.reply(`♻️ Переотправлено ${ok}/${missing.length} карточек`)
    })

    bot.command('reload').filter(inModThread, async (ctx) => {
        if (!ctx.from || !(await isAdmin(ctx.from.id))) return
        const post = await findPost(ctx)
        if (!post) return
        await refreshAdminMessage(bot, db, {env, postId: post.id})
        await ctx.deleteMessage().catch(() => {
        })
        await bot.api.sendMessage(ctx.chat!.id, 'Карточка обновлена', {
            receiver_user_id: ctx.from.id,
        })
    })

    bot.command('remove_photo').filter(inModThread, async (ctx) => {
        if (!ctx.from || !(await isAdmin(ctx.from.id))) return
        const post = await findPost(ctx)
        if (!post) return

        const items = parsePostMedia(post.media)
        if (items.length === 0) {
            await ctx.reply('В посте нет медиа')
            return
        }
        const rawArg = stripCmd(ctx.msg!.text!, 'remove_photo')
        const n = rawArg ? parseInt(rawArg, 10) : items.length === 1 ? 1 : NaN
        if (!(n >= 1 && n <= items.length)) {
            await ctx.reply(`Номер от 1 до ${items.length}`)
            return
        }
        items.splice(n - 1, 1)
        await db.updatePostMedia(post.id, JSON.stringify(items))
        await refreshAdminMessage(bot, db, {env, postId: post.id})
        await ctx.deleteMessage()
    })

    bot.command('add_photo').filter(inModThread, async (ctx) => {
        if (!ctx.from || !(await isAdmin(ctx.from.id))) return
        const post = await findPost(ctx)
        if (!post) return
        if (!pendingAddPhoto) return

        const arg = stripCmd(ctx.msg!.text!, 'add_photo')
        const beforeIndex = arg ? parseInt(arg, 10) : null
        const items = parsePostMedia(post.media)

        if (arg && !(beforeIndex! >= 1 && beforeIndex! <= items.length + 1)) {
            await ctx.reply(`Позиция от 1 до ${items.length + 1}`)
            return
        }

        pendingAddPhoto.set(ctx.from.id, {
            postId: post.id,
            beforeIndex,
            expiresAt: Date.now() + PENDING_TTL_MS,
        })
        await ctx.reply(
            `Пришлите фото или видео следующим сообщением — оно встанет на позицию ${
                beforeIndex ?? items.length + 1
            }.\n/cancel_add — отмена.`
        )
    })

    bot.command('cancel_add', async (ctx) => {
        if (ctx.from && pendingAddPhoto.delete(ctx.from.id)) {
            await ctx.reply('Добавление отменено.')
        }
    })

    bot.catch((err) => {
        console.error('Bot update error:', err.error)
    })
}
