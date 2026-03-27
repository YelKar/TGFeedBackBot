import re
from telebot import types


POST_ID_TEMPLATE = "@{username}#{chat_id}-{message_id}"
POST_ID_REGEXP = re.compile(r"^@(?P<username>\w+)#(?P<user_id>\d+)-(?P<message_id>\d+)")

CONTENT_TYPES = [
    'text',
    'audio',
    'document',
    'photo',
    'video',
    'voice',
    'location',
    'sticker',
    'video_note',
    'contact',
    'poll',
    'venue',
    'animation',
    'invoice',
    'successful_payment',
    'dice'
]

POST_STATES = {
    "rejected": "Отклонено: @{username}",
    "published": "Опубликовано: @{username}",
    "blocked": "Заблокирован @{username}",
    "vote": "@{username} проголосовал: ",
    "marked_as_published": "@{username} отметил как опубликованное"
}
