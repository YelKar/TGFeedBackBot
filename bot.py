import os
from datetime import datetime

import telebot
from telebot import types
from telebot.types import ReactionTypeEmoji, Message

from scheduler import rebalance_queue

if __name__ == '__main__':
    import dotenv

    dotenv.load_dotenv()

from db import Database
from logger import logger
from bot_util import (
    FEEDBACK_CHAT_ID,
    handle_exception,
    apply_action
)

# proxy_url = 'socks5h://127.0.0.1:12334'  # Используем socks5h для DNS через прокси
# telebot.apihelper.proxy = {'https': proxy_url}

TOKEN = os.getenv('TOKEN')
bot = telebot.TeleBot(TOKEN, parse_mode='HTML')

if __name__ == '__main__':
    bot.delete_webhook()

db = Database()

USER_HELP = """
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
"""

MODERATOR_HELP = """
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
"""


def is_admin(user_id):
    try:
        status = bot.get_chat_member(FEEDBACK_CHAT_ID, user_id).status
        return status in ['creator', 'administrator']
    except:
        return False


@bot.message_handler(commands=['help'])
def help_cmd(message: Message):
    if message.chat.id == FEEDBACK_CHAT_ID:
        bot.send_message(message.chat.id, MODERATOR_HELP)
    else:
        bot.send_message(message.chat.id, USER_HELP)


@bot.message_handler(commands=['start'])
def start_cmd(message: Message):
    bot.send_message(message.chat.id, "Привет! Это бот предложки.")
    help_cmd(message)


@bot.message_handler(func=lambda m: m.chat.id != FEEDBACK_CHAT_ID, content_types=['text'])
def handle_user_message(message: Message):
    if db.is_blocked(message.from_user.id):
        return

    if message.reply_to_message and message.reply_to_message.from_user.id == bot.get_me().id:
        dialogue = db.get_dialogue(message.reply_to_message.id)
        if dialogue:
            bot.send_message(
                FEEDBACK_CHAT_ID,
                f"<b>ОТВЕТ АВТОРА @{message.from_user.username}</b>\n"
                f"(По посту <code>{dialogue.post_id}</code>)\n\n"
                f"{message.text}",
                reply_to_message_id=dialogue.admin_msg_id,
                parse_mode='HTML'
            )
            bot.reply_to(message, "ПЕРЕДАНО")
            return

    new_proposal(message)


def new_proposal(message: Message):
    if db.is_blocked(message.from_user.id):
        return

    post_id = f"{message.chat.id}-{message.message_id}"
    db.create_post(post_id, message.from_user.id, message.from_user.username, message.html_text)

    kb = types.InlineKeyboardMarkup()
    btns = [types.InlineKeyboardButton(str(i), callback_data=f"v:{i}:{post_id}") for i in range(1, 6)]
    kb.row(*btns)
    kb.add(types.InlineKeyboardButton("ОТКЛОНИТЬ", callback_data=f"reject:{post_id}"))

    admin_msg = bot.send_message(
        FEEDBACK_CHAT_ID,
        f"<b>От @{message.from_user.username}:</b>\n\n{message.html_text}",
        reply_markup=kb
    )
    db.update_post_admin_msg(post_id, admin_msg.message_id)

    if message.chat.id != FEEDBACK_CHAT_ID:
        bot.reply_to(message, "Пост отправлен модераторам")


@bot.callback_query_handler(func=lambda call: call.data.startswith('v:'))
def handle_vote_callback(call):
    _, score, post_id = call.data.split(':')

    apply_action(bot, db, post_id, 'vote', call.from_user.id, call.from_user.username, score)
    bot.answer_callback_query(call.id, f"Голос {score} принят")


@bot.callback_query_handler(func=lambda call: call.data.startswith('reject:'))
def handle_reject_callback(call):
    post_id = call.data.split(':')[1]
    apply_action(bot, db, post_id, 'reject')
    bot.answer_callback_query(call.id, "Отклонено")


@bot.callback_query_handler(func=lambda call: call.data.startswith('schedule:'))
def handle_schedule_callback(call):
    post_id = call.data.split(':')[1]
    apply_action(bot, db, post_id, 'schedule')
    bot.answer_callback_query(call.id, "В очереди")


@bot.message_handler(commands=['publish'], func=lambda m: m.chat.id == FEEDBACK_CHAT_ID and m.reply_to_message)
def publish_now_cmd(message: Message):
    post = db.get_post_by_admin_msg(message.reply_to_message.id)
    if post:
        apply_action(bot, db, post.id, 'publish_now')
    bot.delete_message(message.chat.id, message.id)


@bot.message_handler(commands=['schedule'], func=lambda m: m.chat.id == FEEDBACK_CHAT_ID and m.reply_to_message)
def schedule_cmd(message: Message):
    post = db.get_post_by_admin_msg(message.reply_to_message.id)
    if post:
        apply_action(bot, db, post.id, 'schedule')
    bot.delete_message(message.chat.id, message.id)


@bot.message_handler(commands=['reject'], func=lambda m: m.chat.id == FEEDBACK_CHAT_ID and m.reply_to_message)
def reject_cmd(message: Message):
    post = db.get_post_by_admin_msg(message.reply_to_message.id)
    if post:
        apply_action(bot, db, post.id, 'reject')
    bot.delete_message(message.chat.id, message.id)


@bot.message_handler(commands=['vote'], func=lambda m: m.chat.id == FEEDBACK_CHAT_ID and m.reply_to_message)
@bot.edited_message_handler(commands=['vote'], func=lambda m: m.chat.id == FEEDBACK_CHAT_ID and m.reply_to_message)
def vote_cmd(message: Message):
    post = db.get_post_by_admin_msg(message.reply_to_message.id)
    if not post: return
    try:
        score = int(message.text.replace('/vote', '').strip())
        if not (1 <= score <= 5): raise ValueError
        apply_action(bot, db, post.id, 'vote', message.from_user.id, message.from_user.username, score)
        bot.delete_message(message.chat.id, message.id)
    except:
        bot.reply_to(message, "Введи число от 1 до 5")


@bot.message_handler(commands=['edit'], func=lambda m: m.chat.id == FEEDBACK_CHAT_ID and m.reply_to_message)
@bot.edited_message_handler(commands=['edit'], func=lambda m: m.chat.id == FEEDBACK_CHAT_ID and m.reply_to_message)
def edit_post_cmd(message: Message):
    post = db.get_post_by_admin_msg(message.reply_to_message.id)
    if not post: return
    new_content = message.html_text.replace('/edit', '', 1).strip()
    if new_content:
        apply_action(bot, db, post.id, 'edit', extra_val=new_content)
    bot.delete_message(message.chat.id, message.id)


@bot.message_handler(commands=['ask'], func=lambda m: m.chat.id == FEEDBACK_CHAT_ID and m.reply_to_message)
def ask_author_cmd(message: Message):
    try:
        post = db.get_post_by_admin_msg(message.reply_to_message.id)
        if not post: return
        text = message.text.replace('/ask', '', 1).strip()
        if not text: return

        user_id, original_msg_id = map(int, post.id.split('-'))
        sent = bot.send_message(
            user_id,
            f"{text}\n\n<i>(Ответьте на это)</i>",
            reply_to_message_id=original_msg_id,
            parse_mode='HTML'
        )
        db.add_dialogue(sent.message_id, message.message_id, post.id)
        bot.set_message_reaction(message.chat.id, message.id, [ReactionTypeEmoji('👍')])
    except Exception as e:
        handle_exception(e, bot, message)


@bot.message_handler(commands=['use'])
def use_cmd(message: Message):
    if message.reply_to_message and is_admin(message.from_user.id):
        new_proposal(message.reply_to_message)
        bot.delete_message(message.chat.id, message.id)


@bot.message_handler(commands=['block'])
def block_cmd(message: Message):
    if message.reply_to_message:
        post = db.get_post_by_admin_msg(message.reply_to_message.id)
        if post and is_admin(message.from_user.id):
            apply_action(bot, db, post.id, 'block')
            bot.delete_message(message.chat.id, message.id)
            bot.send_message(message.chat.id, f"Пользователь {post.user_id} заблокирован")


@bot.message_handler(commands=["queue"])
def queue_cmd(message: Message):
    if not is_admin(message.from_user.id): return

    queue = db.get_scheduled_queue()
    if not queue:
        return bot.send_message(message.chat.id, "📭 <b>Очередь пуста</b>")

    clean_chat_id = str(FEEDBACK_CHAT_ID).replace("-100", "")

    lines = [f"<b>📊 Очередь публикаций ({len(queue)})</b>"]
    current_day = None

    from scheduler import TZ_OFFSET

    for p in queue:
        dt = datetime.fromtimestamp(p.publish_at / 1000000, tz=TZ_OFFSET)
        day_str = dt.strftime("%d.%m %a")
        time_str = dt.strftime("%H:%M")

        if day_str != current_day:
            lines.append(f"\n📅 <b>{day_str}</b>")
            current_day = day_str

        if p.get('admin_msg_id'):
            link = f"https://t.me/c/{clean_chat_id}/{p.admin_msg_id}"
            link_html = f"<a href='{link}'>🔗</a>"
        else:
            link_html = "🔘"

        lines.append(f"<b>[{p.sequence_number}]</b> <code>{time_str}</code> {link_html} @{p.username}")

    bot.send_message(message.chat.id, "\n".join(lines), parse_mode='HTML',
                     disable_web_page_preview=True)


@bot.message_handler(commands=["reschedule"])
def force_queue_cmd(message: Message):
    if is_admin(message.from_user.id) or True:
        rebalance_queue(db)
        bot.delete_message(message.chat.id, message.id)
        bot.send_message(message.chat.id, "Очередь обновлена")


if __name__ == '__main__':
    logger.info("Bot is starting (Polling)...")
    bot.infinity_polling()
