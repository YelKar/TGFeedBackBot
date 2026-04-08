import os

import telebot
from telebot import types

from db import Database

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


@bot.callback_query_handler(func=lambda call: call.data.startswith('v:'))
def handle_vote(call):
    _, score, post_id = call.data.split(':')
    score = int(score)

    db.add_vote(post_id, call.from_user.id, call.from_user.username, score)

    votes = db.get_post_votes(post_id)
    scores = [v.vote for v in votes]
    avg = sum(scores) / len(scores)

    new_text = f"{call.message.text.split('Рейтинг:')[0]}Рейтинг: {avg:.2f} (Голосов: {len(scores)})"

    try:
        bot.edit_message_text(new_text, call.message.chat.id, call.message.message_id,
                              reply_markup=call.message.reply_markup)
        bot.answer_callback_query(call.id, f"Оценка {score} принята!")
    except Exception:
        bot.answer_callback_query(call.id, "Голос учтен")


if __name__ == '__main__':
    bot.infinity_polling()

if __name__ == '__main__':
    bot.infinity_polling()
