import os

import callback_keyboard
from callback_keyboard import CallbackTypes
from logger import logger

if __name__ == '__main__':
    from dotenv import load_dotenv

    load_dotenv(".env")


from telebot import TeleBot, types
import util
from answers import answers


# Get env vars
logger.info("Loading environment variables")

TOKEN = os.getenv('TOKEN')
assert TOKEN is not None, "env variable 'TOKEN' must be set"

FEEDBACK_CHAT_ID = int(os.getenv('CHAT_ID'))
CHANNEL_ID = int(os.getenv('CHANNEL_ID'))
assert FEEDBACK_CHAT_ID != 0, "env variable 'CHAT_ID' must be set"


# Add handlers
logger.info("Defining handlers")

bot = TeleBot(TOKEN, parse_mode='HTML')


@bot.message_handler(commands=['start'])
def start(message: types.Message):
    logger.info(f"User @{message.from_user.username}#{message.from_user.id} started a conversation")

    if message.chat.id != FEEDBACK_CHAT_ID:
        bot.send_message(message.chat.id, answers['start_prefix'])
    help_(message)
    if message.chat.id != FEEDBACK_CHAT_ID:
        bot.send_message(message.chat.id, answers['start_suffix'])


@bot.message_handler(commands=['help'])
def help_(message: types.Message):
    if message.chat.id == FEEDBACK_CHAT_ID:
        bot.send_message(message.chat.id, answers['feedback_chat_help'].format(bot=bot.get_me().username))
    else:
        bot.send_message(message.chat.id, answers['user_help'])
    bot.send_message(message.chat.id, answers['help'])

    logger.info(f"User @{message.from_user.username}#{message.from_user.id} got a support message")


@bot.message_handler(
    func=lambda message:
        message.chat.id == FEEDBACK_CHAT_ID
        and message.reply_to_message is not None
)
def return_proposal(message: types.Message):
    msg_info_match = util.POST_ID_REGEXP.match(message.reply_to_message.text)
    if (
        bot.get_me().id == message.reply_to_message.from_user.id
        and msg_info_match is not None
    ):
        bot.send_message(
            msg_info_match.group('user_id'),
            f"{message.text}\n",
            reply_to_message_id=msg_info_match.group('message_id')
        )
        logger.info(f"Moderator @{message.from_user.username}#{message.from_user.id} "
                    f"sent a message to the author @{msg_info_match.group('username')}#{msg_info_match.group('user_id')}")

@bot.message_handler(content_types=util.CONTENT_TYPES)
def new_proposal(message: types.Message):
    if message.chat.id != FEEDBACK_CHAT_ID:
        new_proposal_message = bot.forward_message(FEEDBACK_CHAT_ID, message.chat.id, message.message_id)
        post_id = util.POST_ID_TEMPLATE.format(
            username=message.from_user.username,
            chat_id=message.chat.id,
            message_id=message.message_id
        )

        bot.send_message(
            FEEDBACK_CHAT_ID,
            answers["got_proposal"].format(
                username=message.from_user.username,
                post_id=post_id,
            ),
            reply_markup=callback_keyboard.create_post_control_keyboard(message.from_user.username, message.chat.id, message.message_id),
            reply_to_message_id=new_proposal_message.id,
        )

        bot.send_message(
            message.chat.id,
            answers["sent_proposal"].format(
                post_id=post_id,
            ),
        )

        logger.info(f"User @{message.from_user.username}#{message.from_user.id} sent the post for moderation")


def check_callback(callback_type: str):
    def g(call: types.CallbackQuery):
        match = callback_keyboard.RegularExpressions.callback.fullmatch(call.data)
        return match is not None and match.group("callback") == callback_type and call.message.chat.id == FEEDBACK_CHAT_ID
    return g


@bot.callback_query_handler(
    func=check_callback(CallbackTypes.publish),
)
def public_post(call: types.CallbackQuery):
    if util.POST_STATES['published'].format(username=call.from_user.username) not in call.message.text:
        forwarded_message = bot.forward_message(FEEDBACK_CHAT_ID, call.message.chat.id, call.message.message_id - 1)
        text = forwarded_message.html_text
        bot.delete_message(forwarded_message.chat.id, forwarded_message.message_id)
        bot.send_message(CHANNEL_ID, text)
        bot.answer_callback_query(call.id, "Пост опубликован:\n\n" + forwarded_message.text)

        msg_info_match = util.POST_ID_REGEXP.match(call.message.text)
        channel = bot.get_chat(CHANNEL_ID)
        bot.send_message(
            msg_info_match.group('user_id'),
            answers["post_published"].format(
                post_id=call.message.text.split("\n")[0],
                channel=CHANNEL_ID if channel.username is None else ("@" + (channel.username or "")),
            ),
            reply_to_message_id=msg_info_match.group('message_id'),
        )
        bot.edit_message_text(
            call.message.html_text
            + f"\n<b>{util.POST_STATES['published'].format(username=call.from_user.username)}</b>",
            call.message.chat.id,
            call.message.id,
        )

    post_id = call.message.text.split("\n")[0]
    logger.info(f"Moderator @{call.from_user.username}#{call.from_user.username} published the post {post_id}")



@bot.callback_query_handler(
    func=check_callback(CallbackTypes.reject),
)
def reject_post(call: types.CallbackQuery):
    if util.POST_STATES['rejected'].format(username=call.from_user.username) not in call.message.text:
        bot.edit_message_text(
            call.message.html_text
            + f"\n<b><u>{util.POST_STATES['rejected'].format(username=call.from_user.username)}</u></b>",
            call.message.chat.id,
            call.message.id,
            reply_markup=callback_keyboard.create_post_control_keyboard(call.from_user.username, call.message.chat.id, call.message.message_id)
        )

    post_id = call.message.text.split("\n")[0]
    logger.info(f"Moderator @{call.from_user.username}#{call.from_user.id} rejected the post {post_id}")
    bot.answer_callback_query(call.id, "Пост отклонён")


@bot.callback_query_handler(
    func=check_callback(CallbackTypes.delete),
)
def delete_post(call: types.CallbackQuery):
    bot.delete_message(call.message.chat.id, call.message.message_id-1)
    bot.delete_message(call.message.chat.id, call.message.message_id)

    post_id = call.message.text.split("\n")[0]
    logger.info(f"Moderator @{call.from_user.username}#{call.from_user.id} deleted the post {post_id}")
    bot.answer_callback_query(call.id, "Пост удалён")


if __name__ == '__main__':
    logger.info("Bot launching")
    bot.infinity_polling()
