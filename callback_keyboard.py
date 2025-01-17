from typing import Optional, List

from telebot import types
import re


class RegularExpressions:
    callback = re.compile(r"(?P<callback>\w+)<@(?P<username>\w+)#(?P<user_id>-?\d+):(?P<message_id>-?\d+)(?P<group>\[(?:&\w+)+])?>")
    callback_group_ids = re.compile(r"&(\w+)")

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
        else:
            self.message_id = None
            self.group = None

def create_post_control_keyboard(username: str, user_id: int, message_id: int, media_ids: List[str] = None) -> types.InlineKeyboardMarkup:
    post_control_keyboard = types.InlineKeyboardMarkup()

    if media_ids is None:
        post_info = f"<@{username}#{user_id}:{message_id}>"
    else:
        post_info = f"<@{username}#{user_id}:{message_id}[&{'&'.join(media_ids)}]>"

    public_btn = types.InlineKeyboardButton("Опубликовать", callback_data='public_post' + post_info)
    reject_btn = types.InlineKeyboardButton("Отклонить", callback_data='reject_post' + post_info)
    delete_btn = types.InlineKeyboardButton("Удалить", callback_data='delete_post' + post_info)
    post_control_keyboard.add(public_btn)
    post_control_keyboard.add(reject_btn, delete_btn)
    return post_control_keyboard