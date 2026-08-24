import { Bot, type Context } from 'grammy'
import type { InlineKeyboardButton, InlineKeyboardMarkup, Message } from '@grammyjs/types'
import { Database } from './db'
import type { Env } from './env'
import { applyAction, feedbackChatId } from './bot_util'
import { rebalanceQueue, TZ_OFFSET_MS } from './scheduler'
import { escapeHtml, toHtml } from './tg'

const USER_HELP = `
<b><u>СПРАВКА</u></b>
Все сообщения, отправленные в этом чате, будут направлены модераторам.

<b>КАК ЭТО РАБОТАЕТ</b>
 ⟹ Отправь сообщение — модераторы проверят его.
 ⟸ Модератор может задать вопрос — ответь на него функцией "Ответить" (Reply).

<b>ФОРМАТ ЦИТАТ</b>
<blockquote>Текст цитаты</blockquote>
© Автор

<b>КОМАНДЫ</b>
/start — Начать.
/help — Эта справка.
`

const MODERATOR_HELP = `
<b><u>СПРАВКА МОДЕРАТОРА</u></b>
(Использовать как ответ на сообщение в этом чате)

<b>УПРАВЛЕНИЕ ПОСТОМ</b>
/vote [1-5] — Проголосовать (если кнопки скрыты).
/edit [текст] — Изменить текст цитаты.
/ask [текст] — Задать вопрос автору.
/schedule — Принудительно одобрить и поставить в очередь.
/reject — Отклонить или убрать из очереди.
/publish — Опубликовать в канал НЕМЕДЛЕННО.
/block — Забанить автора навсегда.
/use — Сделать предложку из любого сообщения.

<b>ОЧЕРЕДЬ</b>
/queue — вывести всю очередь.
/reschedule — Пересчитать расписание и обновить сообщения.
`

let cachedToken: string | undefined
let cachedBot: Bot | undefined
let initPromise: Promise<Bot> | undefined

function buildBot(env: Env): Bot {
    const bot = new Bot(env.TOKEN)
    registerHandlers(bot, env)
    return bot
}

/**
 * Возвращает инициализированного бота (один на инстанс воркера).
 * grammY требует явный init() перед обработкой апдейтов в serverless-режиме.
 */
export async function getBot(env: Env): Promise<Bot> {
    if (!cachedBot || cachedToken !== env.TOKEN) {
        cachedBot = buildBot(env)
        cachedToken = env.TOKEN
        initPromise = undefined
    }
    if (!initPromise) {
        initPromise = cachedBot
            .init()
            .then(() => cachedBot as Bot)
            .catch((e: unknown) => {
                initPromise = undefined
                throw e
            })
    }
    return initPromise
}

function registerHandlers(bot: Bot, env: Env): void {
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

    async function findPost(ctx: Context): Promise<Awaited<ReturnType<Database['getPostByAdminMsg']>>> {
        const rtm = ctx.msg?.reply_to_message
        if (!rtm) return null
        return db.getPostByAdminMsg(rtm.message_id)
    }

    bot.command('start', async (ctx) => {
        await ctx.reply('Привет! Это бот предложки.')
        await ctx.reply(ctx.chat?.id === FB() ? MODERATOR_HELP : USER_HELP, { parse_mode: 'HTML' })
    })

    bot.command('help', async (ctx) => {
        await ctx.reply(ctx.chat?.id === FB() ? MODERATOR_HELP : USER_HELP, { parse_mode: 'HTML' })
    })

    async function newProposal(msg: Message): Promise<void> {
        if (!msg.from || !msg.text) return
        if (await db.isBlocked(msg.from.id)) return

        const postId = `${msg.chat.id}-${msg.message_id}`
        const html = toHtml(msg.text, msg.entities ?? [])
        await db.createPost(postId, msg.from.id, msg.from.username ?? '', html)

        const kb: InlineKeyboardMarkup = {
            inline_keyboard: [
                [1, 2, 3, 4, 5].map((i) => ({ text: String(i), callback_data: `v:${i}:${postId}` })),
                [{ text: 'ОТКЛОНИТЬ', callback_data: `reject:${postId}` }],
            ],
        }

        const adminMsg = await bot.api.sendMessage(
            FB(),
            `<b>От @${msg.from.username ?? 'unknown'}:</b>\n\n${html}`,
            { parse_mode: 'HTML', reply_markup: kb }
        )
        await db.updatePostAdminMsg(postId, adminMsg.message_id)

        if (msg.chat.id !== FB()) {
            await bot.api.sendMessage(msg.chat.id, 'Пост отправлен модераторам', {
                reply_parameters: { message_id: msg.message_id },
            })
        }
    }

    bot.on('message:text').filter((ctx) => ctx.chat?.id !== FB(), async (ctx) => {
        const from = ctx.from
        if (!from) return
        if (await db.isBlocked(from.id)) return

        const msg = ctx.msg
        const rtm = msg.reply_to_message
        if (rtm && rtm.from?.id === bot.botInfo.id) {
            const dialogue = await db.getDialogue(rtm.message_id)
            if (dialogue) {
                await bot.api.sendMessage(
                    FB(),
                    `<b>ОТВЕТ АВТОРА @${from.username}</b>\n` +
                        `(По посту <code>${dialogue.post_id}</code>)\n\n${escapeHtml(msg.text)}`,
                    { parse_mode: 'HTML', reply_to_message_id: dialogue.admin_msg_id }
                )
                await ctx.reply('ПЕРЕДАНО')
                return
            }
        }

        await newProposal(msg)
    })

    bot.callbackQuery(/^v:(\d+):(.+)$/, async (ctx) => {
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
            await applyAction(bot, db, { env, postId: match[1], action: 'reject' })
        } finally {
            await ctx.answerCallbackQuery('Отклонено')
        }
    })

    bot.callbackQuery(/^schedule:(.+)$/, async (ctx) => {
        const match = ctx.match
        if (!match) return
        try {
            await applyAction(bot, db, { env, postId: match[1], action: 'schedule' })
        } finally {
            await ctx.answerCallbackQuery('В очереди')
        }
    })

    bot.command('publish').filter(inModThread, async (ctx) => {
        const post = await findPost(ctx)
        if (post) {
            await applyAction(bot, db, { env, postId: post.id, action: 'publish_now' })
        }
        await ctx.deleteMessage()
    })

    bot.command('schedule').filter(inModThread, async (ctx) => {
        const post = await findPost(ctx)
        if (post) {
            await applyAction(bot, db, { env, postId: post.id, action: 'schedule' })
        }
        await ctx.deleteMessage()
    })

    bot.command('reject').filter(inModThread, async (ctx) => {
        const post = await findPost(ctx)
        if (post) {
            await applyAction(bot, db, { env, postId: post.id, action: 'reject' })
        }
        await ctx.deleteMessage()
    })

    bot.command('block').filter(inModThread, async (ctx) => {
        const from = ctx.from
        if (!from) return
        const post = await findPost(ctx)
        if (post && (await isAdmin(from.id))) {
            await applyAction(bot, db, { env, postId: post.id, action: 'block' })
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
            const score = parseInt(msg.text.replace('/vote', '').trim(), 10)
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
                reply_parameters: { message_id: msg.message_id },
            })
        }
    }

    bot.command('vote').filter(inModThread, async (ctx) => voteLogic(ctx.msg))

    async function editLogic(msg: Message): Promise<void> {
        const rtm = msg.reply_to_message
        if (!rtm || !msg.text) return
        const post = await db.getPostByAdminMsg(rtm.message_id)
        if (!post) return

        const newContent = msg.text.replace('/edit', '').trim()
        if (newContent) {
            await applyAction(bot, db, { env, postId: post.id, action: 'edit', extraVal: newContent })
        }
        await bot.api.deleteMessage(msg.chat.id, msg.message_id)
    }

    bot.command('edit').filter(inModThread, async (ctx) => editLogic(ctx.msg))

    bot.on('edited_message:text').filter(
        (ctx) =>
            ctx.chat?.id === FB() &&
            !!ctx.msg.reply_to_message &&
            (/^\/vote\b/.test(ctx.msg.text) || /^\/edit\b/.test(ctx.msg.text)),
        async (ctx) => {
            const text = ctx.msg.text
            if (text.startsWith('/vote')) await voteLogic(ctx.msg)
            else await editLogic(ctx.msg)
        }
    )

    bot.command('ask').filter(inModThread, async (ctx) => {
        try {
            const msg = ctx.msg
            const post = await findPost(ctx)
            if (!post) return
            const text = (msg.text ?? '').replace('/ask', '').trim()
            if (!text) return

            const [userIdStr, origMsgIdStr] = post.id.split('-')
            const sent = await bot.api.sendMessage(
                Number(userIdStr),
                `${escapeHtml(text)}\n\n<i>(Ответьте на это)</i>`,
                {
                    parse_mode: 'HTML',
                    reply_to_message_id: Number(origMsgIdStr),
                }
            )
            await db.addDialogue(sent.message_id, msg.message_id, post.id)
            await bot.api.setMessageReaction(msg.chat.id, msg.message_id, [
                { type: 'emoji', emoji: '👍' },
            ])
        } catch (e) {
            console.error('/ask failed:', e)
        }
    })

    bot.command('use').filter(
        (ctx) => !!ctx.msg?.reply_to_message && !!ctx.from,
        async (ctx) => {
            const rtm = ctx.msg?.reply_to_message
            const from = ctx.from
            if (!rtm || !from) return
            if (!(await isAdmin(from.id))) return
            await newProposal(rtm)
            await ctx.deleteMessage()
        }
    )

    const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    const p2 = (n: number): string => String(n).padStart(2, '0')

    function localDate(ms: number): Date {
        return new Date(ms + TZ_OFFSET_MS)
    }

    bot.command('queue').filter(async (ctx) => !!ctx.from && (await isAdmin(ctx.from.id)), async (ctx) => {
        if (!ctx.chat) return
        const queue = await db.getScheduledQueue()
        if (queue.length === 0) {
            await ctx.reply('📭 <b>Очередь пуста</b>', { parse_mode: 'HTML' })
            return
        }

        const cleanChatId = String(FB()).replace('-100', '')
        const lines = [`<b>📊 Очередь публикаций (${queue.length})</b>`]
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

        await bot.api.sendMessage(ctx.chat.id, lines.join('\n'), {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
        })
    })

    bot.command('reschedule').filter(async (ctx) => !!ctx.from && (await isAdmin(ctx.from.id)), async (ctx) => {
        await rebalanceQueue(db)
        await ctx.deleteMessage()
        await ctx.reply('Очередь обновлена')
    })

    bot.catch((err) => {
        console.error('Bot update error:', err.error)
    })
}
