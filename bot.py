import os
import re

from telebot import TeleBot, types

import util
from answers import answers

if __name__ == '__main__':
    from dotenv import load_dotenv

    load_dotenv(".env")

TOKEN = os.getenv('TOKEN')
assert TOKEN is not None, "env variable 'TOKEN' must be set"

FEEDBACK_CHAT_ID = int(os.getenv('CHAT_ID'))
CHANNEL_ID = int(os.getenv('CHANNEL_ID'))
assert FEEDBACK_CHAT_ID != 0, "env variable 'CHAT_ID' must be set"


bot = TeleBot(TOKEN, parse_mode='HTML')

@bot.message_handler(commands=['start'])
def start(message: types.Message):
    print(message.chat.id, message.text)

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


@bot.message_handler(
    func=lambda message:
        message.chat.id == FEEDBACK_CHAT_ID
        and message.reply_to_message is not None
)
def return_proposal(message: types.Message):
    msg_info_expr = re.compile(r"^@(?P<username>\w+)#(?P<user_id>\d+)-(?P<message_id>\d+)")
    msg_info_match = msg_info_expr.match(message.reply_to_message.text)
    if (
        bot.get_me().id == message.reply_to_message.from_user.id
        and msg_info_match is not None
    ):
        bot.send_message(
            msg_info_match.group('user_id'),
            f"{message.text}\n",
            reply_to_message_id=msg_info_match.group('message_id')
        )


@bot.message_handler(content_types=util.CONTENT_TYPES)
def new_proposal(message: types.Message):

    if message.chat.id != FEEDBACK_CHAT_ID:
        new_proposal_message = bot.forward_message(FEEDBACK_CHAT_ID, message.chat.id, message.message_id)

        bot.send_message(
            FEEDBACK_CHAT_ID,
            answers["got_proposal"].format(
                username=message.from_user.username,
                chat_id=message.chat.id,
                message_id=message.message_id,
            ),
            reply_markup=util.POST_CONTROL_KEYBOARD,
            reply_to_message_id=new_proposal_message.id,
        )


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


@bot.callback_query_handler(func=lambda call: call.data == "delete_post" and call.message.chat.id == FEEDBACK_CHAT_ID)
def delete_post(call: types.CallbackQuery):
    bot.delete_message(call.message.chat.id, call.message.message_id-1)
    bot.delete_message(call.message.chat.id, call.message.message_id)


bot.infinity_polling()
