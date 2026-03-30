import os
import time

from telebot.types import Message, User

import callback_keyboard
from blocker import Blocker, create_connection
from callback_keyboard import CallbackTypes
from logger import logger

if __name__ == '__main__':
    from dotenv import load_dotenv

    load_dotenv(".env")

from telebot import TeleBot, types
import util
from answers import answers

TOKEN = os.getenv('TOKEN')
assert TOKEN is not None, "env variable 'TOKEN' must be set"

FEEDBACK_CHAT_ID = int(os.getenv('CHAT_ID'))
DIRECT_CHAT_ID = int(os.getenv('DIRECT_CHAT_ID'))
CHANNEL_ID = os.getenv('CHANNEL_ID')
assert FEEDBACK_CHAT_ID != 0, "env variable 'CHAT_ID' must be set"

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
    elif message.chat.id != DIRECT_CHAT_ID:
        bot.send_message(message.chat.id, answers['user_help'])
    bot.send_message(message.chat.id, answers['help'])

    logger.info(f"User @{message.from_user.username}#{message.from_user.id} got a support message")


@bot.message_handler(commands=['vote'])
@bot.edited_message_handler(commands=['vote'])
def vote_by_message(message: types.Message):
    if message.chat.id != FEEDBACK_CHAT_ID or bot.get_chat_member(message.chat.id, message.from_user.id).status not in [
        'creator', 'administrator']:
        return

    if not message.reply_to_message:
        return

    _, *other = message.text.split()
    msg_info_match = util.POST_ID_REGEXP.match(message.reply_to_message.text)
    if not message.reply_to_message.from_user.id == bot.get_me().id or msg_info_match is None:
        if len(other) == 0:
            send_control_message(message.reply_to_message, message.reply_to_message.id)
            bot.delete_message(message.chat.id, message.id)
        return

    if len(other) == 0:
        return

    number = other[0]

    if not number.isdigit():
        message = bot.reply_to(message, "Неверный формат числа, долбоёб!")
        time.sleep(1)
        bot.reply_to(message, "Пиздец... Недоразвитый")
        return

    number = int(number)
    if number < 1 or number > 5:
        message = bot.reply_to(message, "Оценка должна быть от 1 до 5")
        time.sleep(2)
        bot.reply_to(message, "Хуёво с прицелом...")
        return

    vote(message.from_user, message.reply_to_message, number)


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


def send_control_message(message: types.Message, new_proposal_message_id) -> str:
    post_id = util.POST_ID_TEMPLATE.format(
        username=message.from_user.username,
        chat_id=message.chat.id,
        message_id=message.message_id
    )

    kb = callback_keyboard.create_post_control_keyboard(message.from_user.username, message.chat.id,
                                                        message.message_id,
                                                        except_=[CallbackTypes.publish, CallbackTypes.reject,
                                                                 CallbackTypes.published])

    bot.send_message(
        FEEDBACK_CHAT_ID,
        answers["got_proposal"].format(
            username=message.from_user.username,
            post_id=post_id,
        ),
        reply_markup=kb,
        reply_to_message_id=new_proposal_message_id,
    )

    return post_id


@bot.message_handler(content_types=util.CONTENT_TYPES)
def new_proposal(message: types.Message):
    blocker = Blocker(create_connection())
    if blocker.is_blocked(message.chat.id):
        bot.reply_to(message, "Fuk u bitch!")
        return
    if message.chat.id not in [DIRECT_CHAT_ID, FEEDBACK_CHAT_ID]:
        logger.info(
            f"User @{message.from_user.username}#{message.from_user.id}({message.chat.id}) sent the post for moderation")

        new_proposal_message = bot.forward_message(FEEDBACK_CHAT_ID, message.chat.id, message.message_id)

        post_id = send_control_message(message, new_proposal_message.id)

        bot.send_message(
            message.chat.id,
            answers["sent_proposal"].format(
                post_id=post_id,
            ),
        )


def check_callback(callback_type: str):
    def g(call: types.CallbackQuery):
        match = callback_keyboard.RegularExpressions.callback.fullmatch(call.data)
        if match is None:
            return False

        if match.group("callback") != callback_type:
            return False

        if call.message.chat.id != FEEDBACK_CHAT_ID:
            return False

        member = bot.get_chat_member(
            call.message.chat.id,
            call.from_user.id
        )

        return member.status in ("administrator", "creator")

    return g


@bot.callback_query_handler(
    func=check_callback(CallbackTypes.publish),
)
def publish_post(call: types.CallbackQuery):
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
    func=check_callback(CallbackTypes.published),
)
def mark_as_published_post(call: types.CallbackQuery):
    if util.POST_STATES['marked_as_published'].format(username=call.from_user.username) not in call.message.text:
        bot.edit_message_text(
            call.message.html_text
            + f"\n<b>{util.POST_STATES['marked_as_published'].format(username=call.from_user.username)}</b>",
            call.message.chat.id,
            call.message.id,
        )

    post_id = call.message.text.split("\n")[0]
    logger.info(
        f"Moderator @{call.from_user.username}#{call.from_user.username} marked as published the post {post_id}")


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
            reply_markup=callback_keyboard.create_post_control_keyboard(call.from_user.username, call.message.chat.id,
                                                                        call.message.message_id)
        )

    post_id = call.message.text.split("\n")[0]
    logger.info(f"Moderator @{call.from_user.username}#{call.from_user.id} rejected the post {post_id}")
    bot.answer_callback_query(call.id, "Пост отклонён")


@bot.callback_query_handler(
    func=check_callback(CallbackTypes.delete),
)
def delete_post(call: types.CallbackQuery):
    bot.delete_message(call.message.chat.id, call.message.message_id - 1)
    bot.delete_message(call.message.chat.id, call.message.message_id)

    post_id = call.message.text.split("\n")[0]
    logger.info(f"Moderator @{call.from_user.username}#{call.from_user.id} deleted the post {post_id}")
    bot.answer_callback_query(call.id, "Пост удалён")


@bot.callback_query_handler(
    func=check_callback(CallbackTypes.block),
)
def block_user(call: types.CallbackQuery):
    if util.POST_STATES['blocked'].format(username=call.from_user.username) not in call.message.text:
        callback_data = callback_keyboard.Callback(call.data)
        blocker = Blocker(create_connection())
        user_id_to_block = int(callback_data.user_id)
        blocker.block(user_id_to_block)

        bot.edit_message_text(
            call.message.html_text + f"\n<b><u>{util.POST_STATES['blocked'].format(username=call.from_user.username)}</u></b>",
            call.message.chat.id,
            call.message.id,
            reply_markup=callback_keyboard.create_post_control_keyboard(
                callback_data.username,
                int(callback_data.user_id),
                int(callback_data.message_id)
            )
        )
        logger.info(
            f"Moderator @{call.from_user.username}#{call.from_user.id} blocked user @{callback_data.username}#{user_id_to_block}")


@bot.callback_query_handler(
    func=check_callback(CallbackTypes.vote),
)
def vote_by_kb(call: types.CallbackQuery):
    callback_data = callback_keyboard.Callback(call.data)
    logger.info(f"User @{callback_data.username}#{callback_data.user_id} voted {callback_data.vote}")

    vote(call.from_user, call.message, int(callback_data.vote), call.id)

import re

THRESHOLD = 3.5
VOTE_BOUNDS = (1, 5)
K = 0.5


def robust_mean(values: list[float], k: float, iters: int = 5) -> float:
    if not values:
        return 0.0

    current = sum(values) / len(values)

    for _ in range(iters):
        sum_w = 0.0
        sum_wx = 0.0

        for x in values:
            d = abs(x - current)
            w = 1.0 / (1.0 + (d / k) ** 2)
            sum_w += w
            sum_wx += w * x

        current = sum_wx / sum_w

    return current


def update_message_rating(text: str, username: str, vote: int, total_admins: int) -> dict:
    clean_username = f"@{username.lstrip('@')}"
    rating_block_re = re.compile(r"Оценка\s*[\d.]*\s*\(.*\)", re.DOTALL)
    match = rating_block_re.search(text)

    votes_dict = {}
    if match:
        raw_block = match.group(0)
        found_votes = re.findall(r"(@\w+):\s*([\d.]+)", raw_block)
        for u, v in found_votes:
            votes_dict[u] = float(v)
        base_text = text[:match.start()].strip()
    else:
        base_text = text.split("\n\nОценка")[0].split("\nПрогноз:")[0].strip()

    votes_dict[clean_username] = float(vote)

    voted_count = len(votes_dict)
    remaining_count = max(0, total_admins - voted_count)

    values = list(votes_dict.values())
    estimation = robust_mean(values, K)
    avg = sum(values) / len(values)

    min_values = values + [VOTE_BOUNDS[0]] * remaining_count
    max_values = values + [VOTE_BOUNDS[1]] * remaining_count

    min_possible_estimation = robust_mean(min_values, K)
    max_possible_estimation = robust_mean(max_values, K)

    votes_list = ", ".join([f"{u}: {v:g}" for u, v in votes_dict.items()])

    new_text = f"{base_text}\n\nОценка {estimation:g} ({votes_list})"

    if remaining_count > 0:
        new_text += f"\nПрогноз: {min_possible_estimation:.2g} — {max_possible_estimation:.2g} (осталось: {remaining_count})"

    return {
        "text": new_text,
        "estimation": estimation,
        "avg": avg,
        "min_estimation": min_possible_estimation,
        "max_estimation": max_possible_estimation,
        "voted_users": list(votes_dict.keys()),
        "is_final": remaining_count <= 0
    }


def vote(by: User, on: Message, user_vote: int, callback_query_id: int | None = None):
    if user_vote < VOTE_BOUNDS[0] or user_vote > VOTE_BOUNDS[1]:
        return

    members = bot.get_chat_administrators(on.chat.id)
    admins = [m.user.username for m in members if not m.user.is_bot and m.user.username]
    total_admins = len(admins) if len(admins) > 0 else 1

    res = update_message_rating(on.text, by.username, user_vote, total_admins)

    new_text = res["text"]
    voted = res["voted_users"]

    not_voted = [f"@{a}" for a in admins if f"@{a}" not in voted]

    hidden_btns = [CallbackTypes.publish, CallbackTypes.published, CallbackTypes.reject, CallbackTypes.delete]

    is_guaranteed_approved = res["min_estimation"] >= THRESHOLD
    is_guaranteed_rejected = res["max_estimation"] < THRESHOLD

    if res["is_final"]:
        hidden_btns.append(CallbackTypes.vote)
        if res["estimation"] >= THRESHOLD:
            new_text += "\n<b>Одобрено по голосам</b>"
            hidden_btns.remove(CallbackTypes.published)
            hidden_btns.append(CallbackTypes.block)
        else:
            new_text += "\n<b>Отклонено по голосам</b>"
    else:
        if is_guaranteed_approved:
            new_text += "\n<b>Предварительно одобрено</b>"
            hidden_btns.remove(CallbackTypes.published)
        elif is_guaranteed_rejected:
            new_text += "\n<b>Предварительно отклонено</b>"

    kb = callback_keyboard.create_post_control_keyboard(
        on.from_user.username, on.chat.id, on.message_id,
        except_=hidden_btns
    )

    try:
        bot.edit_message_text(
            new_text,
            on.chat.id,
            on.id,
            reply_markup=kb,
            parse_mode='HTML'
        )
    except Exception as e:
        logger.error(f"Error editing message: {e}")

    if callback_query_id:
        msg = f"Голос {user_vote} принят."
        if not_voted:
            msg += f" Ждем еще {len(not_voted)} чел."
        bot.answer_callback_query(callback_query_id, msg)


if __name__ == '__main__':
    logger.info("Bot launching")
    bot.infinity_polling()
