import os
import time

import telebot
from telebot import types

from db import Database
from logger import logger
from rating import THRESHOLD

if __name__ == '__main__':
    import dotenv

    dotenv.load_dotenv()

TOKEN = os.getenv('TOKEN')
bot = telebot.TeleBot(TOKEN, parse_mode='HTML')
db = Database()

FEEDBACK_CHAT_ID = int(os.getenv('CHAT_ID'))


@bot.message_handler(commands=['start'])
def start(message):
    bot.send_message(message.chat.id, "Привет! Присылай цитату для предложки.")


@bot.message_handler(func=lambda m: m.chat.id != FEEDBACK_CHAT_ID, content_types=['text'])
def new_proposal(message):
    if db.is_blocked(message.from_user.id):
        return

    post_id = f"{message.chat.id}-{message.message_id}"
    db.create_post(post_id, message.from_user.id, message.from_user.username, message.text)

    kb = types.InlineKeyboardMarkup()
    btns = [types.InlineKeyboardButton(str(i), callback_data=f"v:{i}:{post_id}") for i in range(1, 6)]
    kb.row(*btns)

    admin_msg = bot.send_message(
        FEEDBACK_CHAT_ID,
        f"<b>Новый пост от @{message.from_user.username}:</b>\n\n{message.text}\n\n<i>Рейтинг: 0.00 (Голосов: 0)</i>",
        reply_markup=kb
    )
    db.update_post_admin_msg(post_id, admin_msg.message_id)
    bot.reply_to(message, "Пост отправлен модераторам.")


def get_admin_keyboard(post_id, can_schedule=False):
    kb = types.InlineKeyboardMarkup()

    btns = [types.InlineKeyboardButton(str(i), callback_data=f"v:{i}:{post_id}") for i in range(1, 6)]
    kb.row(*btns)

    if can_schedule:
        kb.add(types.InlineKeyboardButton("📅 В очередь (авто)", callback_data=f"schedule:{post_id}"))

    kb.add(types.InlineKeyboardButton("❌ Отклонить", callback_data=f"reject:{post_id}"))

    return kb


@bot.callback_query_handler(func=lambda call: call.data.startswith('v:'))
def handle_vote(call):
    _, score, post_id = call.data.split(':')
    score = int(score)

    db.add_vote(post_id, call.from_user.id, call.from_user.username, score)

    admins = bot.get_chat_administrators(call.message.chat.id)
    total_admins = len([a for a in admins if not a.user.is_bot])

    votes_rows = db.get_post_votes(post_id)
    current_scores = [v.vote for v in votes_rows]

    from rating import get_rating_status
    res = get_rating_status(current_scores, total_admins)

    base_text = call.message.text.split("\n\nОценка")[0]
    status_text = f"\n\nОценка {res['estimation']:.2f}"

    if not res['is_final']:
        status_text += f"\nПрогноз: {res['min_estimation']:.2f} — {res['max_estimation']:.2f}"

    show_schedule = res['is_guaranteed_approved'] or res['is_final'] and res['estimation'] >= THRESHOLD

    if res['is_guaranteed_approved']:
        status_text += "\n<b>✅ Предварительно одобрено</b>"
    elif res['is_guaranteed_rejected']:
        status_text += "\n<b>❌ Предварительно отклонено</b>"

    try:
        bot.edit_message_text(
            base_text + status_text,
            call.message.chat.id,
            call.message.message_id,

            reply_markup=get_admin_keyboard(post_id, can_schedule=show_schedule)
        )
        bot.answer_callback_query(call.id, f"Голос {score} учтен")
    except Exception as e:
        logger.error(f"Error updating vote: {e}")


POST_INTERVAL_SECONDS = 2 * 60 * 60


@bot.callback_query_handler(func=lambda call: call.data.startswith('schedule:'))
def schedule_post(call):
    post_id = call.data.split(':')[1]

    latest_time = db.get_latest_publish_time()
    now = int(time.time())

    if not latest_time or (latest_time / 1000000) < now:
        publish_at = now + 600
    else:
        publish_at = int(latest_time / 1000000) + (2 * 60 * 60)

    db.update_post_status(post_id, 'scheduled', publish_at * 1000000)

    readable_time = time.strftime("%H:%M (%d.%m)", time.localtime(publish_at))

    new_text = call.message.text + f"\n\n<b>💎 Запланировано на {readable_time}</b>"
    bot.edit_message_text(new_text, call.message.chat.id, call.message.message_id, reply_markup=None)
    bot.answer_callback_query(call.id, "Пост в очереди!")


if __name__ == '__main__':
    bot.infinity_polling()
