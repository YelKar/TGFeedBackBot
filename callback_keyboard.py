import re
from typing import List

from telebot import types


class RegularExpressions:
    callback = re.compile(
        r"(?P<callback>\w+)<@(?P<username>\w+)#(?P<user_id>-?\d+):(?P<message_id>-?\d+)(?P<group>\[(?:&\w+)+])?(?::(?P<vote>\d+))?>")
    callback_group_ids = re.compile(r"&(\w+)")


class CallbackTypes:
    publish = "publish_post"
    reject = "reject_post"
    delete = "delete_post"
    block = "block_user"
    vote = "vote"
    published = "published_post"


class Callback:
    def __init__(self, callback_data: str):
        callback_match = RegularExpressions.callback.fullmatch(callback_data)
        if callback_match:
            self.callback = callback_match.group("callback")
            self.username = callback_match.group("username")
            self.user_id = callback_match.group("user_id")
            self.message_id = callback_match.group("message_id")

            if group := callback_match.group("group"):
                self.group = RegularExpressions.callback_group_ids.findall(group)
            else:
                self.group = None
            self.vote = callback_match.group("vote")
        else:
            self.message_id = None
            self.group = None


def create_post_control_keyboard(username: str, user_id: int, message_id: int, media_ids: List[str] = None, /,
                                 except_: list[str] = None) -> types.InlineKeyboardMarkup:
    except_ = except_ or []
    post_control_keyboard = types.InlineKeyboardMarkup()

    if media_ids is None:
        post_info = f"<@{username}#{user_id}:{message_id}>"
    else:
        post_info = f"<@{username}#{user_id}:{message_id}[&{'&'.join(media_ids)}]>"

    btns = [
        types.InlineKeyboardButton("Опубликовать", callback_data=CallbackTypes.publish + post_info),
        types.InlineKeyboardButton("Отклонить", callback_data=CallbackTypes.reject + post_info),
        types.InlineKeyboardButton("Удалить", callback_data=CallbackTypes.delete + post_info),
        types.InlineKeyboardButton("Заблокировать", callback_data=CallbackTypes.block + post_info),
        types.InlineKeyboardButton("Опубликовано", callback_data=CallbackTypes.published + post_info),
    ]

    def check_except(btn: types.InlineKeyboardButton) -> bool:
        return any(x in btn.callback_data for x in except_)

    btns = list(filter(lambda btn: not check_except(btn), btns))
    post_control_keyboard.add(*btns)
    if CallbackTypes.vote not in except_:
        post_control_keyboard.row(*create_vote_row(username, user_id, message_id))

    return post_control_keyboard


def create_vote_row(username: str, user_id: int, message_id: int) -> list[types.InlineKeyboardButton]:
    post_info = f"<@{username}#{user_id}:{message_id}" + ":{}>"

    row = []
    for i in range(1, 6):
        row.append(types.InlineKeyboardButton(str(i), callback_data=CallbackTypes.vote + post_info.format(i)))
    return row
