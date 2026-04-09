from telebot.types import ReactionTypeEmoji, Message

if __name__ == '__main__':
    import dotenv

    dotenv.load_dotenv()

import os

import telebot
from telebot import types

from db import Database
from logger import logger
from bot_util import refresh_admin_message, FEEDBACK_CHAT_ID, update_queue, handle_exception, publish_post

TOKEN = os.getenv('TOKEN')
bot = telebot.TeleBot(TOKEN, parse_mode='HTML')
if __name__ == '__main__':
    bot.delete_webhook()
db = Database()


def is_admin(user_id):
    return bot.get_chat_member(FEEDBACK_CHAT_ID, user_id).status in ['creator', 'administrator']


USER_HELP = """
<b><u>Справка:</u></b>
Все сообщения, отправленные в данном чате, за исключением основных команд, будут направлены в чат модерации и, в случае одобрения, будут опубликованы.

<b>Как это работает</b>:
 ⟹ Ты отправляешь сообщение, а модераторы проверяют его перед публикацией.
 ⟸ Модерация может ответить на твоё сообщение, если нужно что-то уточнить.


Мы очень просим тебя <b><u>присылать правильно отформатированные цитаты</u></b>. Саму фразу оберни в блок цитаты. Далее сделай два переноса строки и, после символа ©, напиши имя автора.

Вот пример: 

<blockquote>Вот сюда помести текст своей цитаты</blockquote>

© Имя автора

<b>Команды:</b>
/start — Начать работу с ботом.
/help — Показать эту справку.
"""

MODERATOR_HELP = """
<b><u>Справка:</u></b>
<b>Управление постом (использовать как ответ на пост):</b>
/vote [1-5] — Проголосовать за пост (если кнопки скрыты).
/edit [текст] — Изменить текст предложенного поста.
/ask [текст] — Задать вопрос автору сообщения.
/reject — Отклонить пост и убрать его из очереди.
/publish — Опубликовать пост в канал немедленно.
/block — Заблокировать автора навсегда.
/use — Создать новый пост из любого сообщения в чате.

<b>Управление очередью:</b>
/queue — Пересчитать расписание и обновить время публикации во всех карточках.
"""


@bot.message_handler(commands=['help'])
def help_(message):
    if message.chat.id == FEEDBACK_CHAT_ID:
        bot.send_message(message.chat.id, MODERATOR_HELP)
    else:
        bot.send_message(message.chat.id, USER_HELP)


@bot.message_handler(commands=['start'])
def start(message):
    bot.send_message(message.chat.id, "Привет! Это бот предложки нашего канала")
    help_(message)


@bot.message_handler(func=lambda m: m.chat.id != FEEDBACK_CHAT_ID, content_types=['text'])
def handle_user_message(message):
    if db.is_blocked(message.from_user.id):
        return

    if message.reply_to_message and message.reply_to_message.from_user.id == bot.get_me().id:
        dialogue = db.get_dialogue(message.reply_to_message.id)

        if dialogue:
            post_ref = f"<code>{dialogue.post_id}</code>"

            bot.send_message(
                FEEDBACK_CHAT_ID,
                f"<b>ОТВЕТ АВТОРА @{message.from_user.username}</b>\n"
                f"(По посту {post_ref})\n\n"
                f"{message.text}",
                reply_to_message_id=dialogue.admin_msg_id,
                parse_mode='HTML'
            )
            bot.reply_to(message, "ОТВЕТ ПЕРЕДАН")
            return

    new_proposal(message)


def new_proposal(message):
    if db.is_blocked(message.from_user.id):
        return

    post_id = f"{message.chat.id}-{message.message_id}"

    db.create_post(post_id, message.from_user.id, message.from_user.username, message.html_text)

    kb = types.InlineKeyboardMarkup()
    btns = [types.InlineKeyboardButton(str(i), callback_data=f"v:{i}:{post_id}") for i in range(1, 6)]
    kb.row(*btns)

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
    db.add_vote(post_id, call.from_user.id, call.from_user.username, int(score))

    refresh_admin_message(bot, db, post_id, call.message.chat.id, call.message.id)
    bot.answer_callback_query(call.id, "Голос принят")


@bot.message_handler(commands=['publish'], func=lambda m: m.chat.id == FEEDBACK_CHAT_ID and m.reply_to_message)
def publish_now_cmd(message):
    post = db.get_post_by_admin_msg(message.reply_to_message.id)
    if not post: return

    publish_post(bot, db, post)


POST_INTERVAL_SECONDS = 2 * 60 * 60


@bot.callback_query_handler(func=lambda call: call.data.startswith('schedule:'))
def schedule_post(call):
    post_id = call.data.split(':')[1]

    db.update_post_status(post_id, 'scheduled')

    update_queue(bot, db)

    bot.answer_callback_query(call.id, "Пост в очереди")


@bot.message_handler(commands=['ask'], func=lambda m: m.chat.id == FEEDBACK_CHAT_ID and m.reply_to_message)
def ask_author(message):
    try:
        post = db.get_post_by_admin_msg(message.reply_to_message.id)
        if not post: return

        text_to_user = message.text.replace('/ask', '', 1).strip()
        if not text_to_user: return

        user_id, original_msg_id = map(int, post.id.split('-'))

        sent_msg = bot.send_message(
            chat_id=user_id,
            text=f"{text_to_user}\n\n<i>(Ответьте на это сообщение)</i>",
            reply_to_message_id=original_msg_id,
            parse_mode='HTML'
        )

        db.add_dialogue(sent_msg.message_id, message.message_id, post.id)

        bot.set_message_reaction(message.chat.id, message.id, [ReactionTypeEmoji('👍')])


    except Exception as e:
        handle_exception(e, bot, message)


@bot.message_handler(commands=['vote'], func=lambda m: m.chat.id == FEEDBACK_CHAT_ID and m.reply_to_message)
@bot.edited_message_handler(commands=['vote'], func=lambda m: m.chat.id == FEEDBACK_CHAT_ID and m.reply_to_message)
def vote_cmd(message):
    post = db.get_post_by_admin_msg(message.reply_to_message.id)
    if not post: return

    try:
        score = int(message.text.replace('/vote', '').strip())
        if not (1 <= score <= 5): raise ValueError
    except:
        bot.reply_to(message, "Введите число от 1 до 5")
        return

    db.add_vote(post.id, message.from_user.id, message.from_user.username, score)
    refresh_admin_message(bot, db, post.id, message.chat.id, message.reply_to_message.id)
    bot.delete_message(message.chat.id, message.id)


@bot.message_handler(commands=['reject'], func=lambda m: m.chat.id == FEEDBACK_CHAT_ID and m.reply_to_message)
def reject_cmd(message):
    post = db.get_post_by_admin_msg(message.reply_to_message.id)
    if not post: return

    db.update_post_status(post.id, 'rejected')

    update_queue(bot, db)

    refresh_admin_message(bot, db, post.id, message.chat.id, message.reply_to_message.id)
    bot.delete_message(message.chat.id, message.id)


@bot.edited_message_handler(commands=['edit'], func=lambda m: m.chat.id == FEEDBACK_CHAT_ID and m.reply_to_message)
@bot.message_handler(commands=['edit'], func=lambda m: m.chat.id == FEEDBACK_CHAT_ID and m.reply_to_message)
def edit_post_cmd(message):
    post = db.get_post_by_admin_msg(message.reply_to_message.id)
    if not post: return

    new_content = message.html_text.replace('/edit', '', 1).strip()
    if not new_content: return

    db.update_post_text(post.id, new_content)

    refresh_admin_message(bot, db, post.id, message.chat.id, message.reply_to_message.id)
    bot.delete_message(message.chat.id, message.id)


@bot.message_handler(commands=['use'])
def queue_cmd(message: Message):
    if message.reply_to_message is None:
        return

    if not is_admin(message.from_user.id):
        return

    new_proposal(message.reply_to_message)
    bot.delete_message(message.chat.id, message.id)


@bot.message_handler(commands=['block'])
def block_cmd(message: Message):
    if message.reply_to_message is None:
        return

    post = db.get_post_by_admin_msg(message.reply_to_message.id)
    if not post: return

    db.block_user(post.user_id)
    bot.delete_message(message.chat.id, message.id)
    bot.send_message(message.chat.id, f"Пользователь {post.user_id} заблокирован")


@bot.message_handler(commands=["queue"])
def queue_cmd(message: Message):
    if not is_admin(message.from_user.id):
        return

    update_queue(bot, db)
    bot.delete_message(message.chat.id, message.id)
    bot.send_message(message.chat.id, "Очередь обновлена")


if __name__ == '__main__':
    logger.info("Starting bot...")
    bot.infinity_polling()
