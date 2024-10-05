import os
import re

import telebot
from loguru import logger

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
    logger.info(f"User {message.from_user.id} started a conversation")

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

    logger.info(f"User {message.from_user.id} got a support message")


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
        logger.info(f"Moderator @{message.from_user.username} sent a message to the author @{msg_info_match.group('username')}")


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
            reply_markup=util.POST_CONTROL_KEYBOARD,
            reply_to_message_id=new_proposal_message.id,
        )

        bot.send_message(
            message.chat.id,
            answers["sent_proposal"].format(
                post_id=post_id,
            ),
        )

        logger.info(f"User {message.from_user.username} sent the post for moderation")


@bot.callback_query_handler(func=lambda call: call.data == "public_post" and call.message.chat.id == FEEDBACK_CHAT_ID)
def public_post(call: types.CallbackQuery):
    if util.POST_STATES['published'].format(username=call.from_user.username) not in call.message.text:
        bot.edit_message_text(
            call.message.html_text
            + f"\n<b>{util.POST_STATES['published'].format(username=call.from_user.username)}</b>",
            call.message.chat.id,
            call.message.id,
        )
    bot.forward_message(CHANNEL_ID, call.message.chat.id, call.message.message_id - 1)

    msg_info_match = util.POST_ID_REGEXP.match(call.message.text)
    channel = bot.get_chat(CHANNEL_ID)
    bot.send_message(
        msg_info_match.group('user_id'),
        answers["post_published"].format(
            post_id=call.message.text.split("\n")[0],
            channel=CHANNEL_ID if channel.username is None else ("@" + (channel.username or "")),
        )
    )

    logger.info(f"Moderator {call.from_user.username} published the post {call.message.text.split("\n")[0]}")


@bot.callback_query_handler(func=lambda call: call.data == "reject_post" and call.message.chat.id == FEEDBACK_CHAT_ID)
def reject_post(call: types.CallbackQuery):
    if util.POST_STATES['rejected'].format(username=call.from_user.username) not in call.message.text:
        bot.edit_message_text(
            call.message.html_text
            + f"\n<b>{util.POST_STATES['rejected'].format(username=call.from_user.username)}</b>",
            call.message.chat.id,
            call.message.id,
            reply_markup=util.POST_CONTROL_KEYBOARD,
        )

    logger.info(f"Moderator {call.from_user.username} rejected the post {call.message.text.split("\n")[0]}")


@bot.callback_query_handler(func=lambda call: call.data == "delete_post" and call.message.chat.id == FEEDBACK_CHAT_ID)
def delete_post(call: types.CallbackQuery):
    bot.delete_message(call.message.chat.id, call.message.message_id-1)
    bot.delete_message(call.message.chat.id, call.message.message_id)

    logger.info(f"Moderator {call.from_user.username} deleted the post {call.message.text.split("\n")[0]}")


logger.info("Bot launching")
bot.infinity_polling()
