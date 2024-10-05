from telebot import types

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
}

POST_CONTROL_KEYBOARD = types.InlineKeyboardMarkup()

PUBLIC_BTN = types.InlineKeyboardButton("Опубликовать", callback_data='public_post')
REJECT_BTN = types.InlineKeyboardButton("Отклонить", callback_data='reject_post')
DELETE_BTN = types.InlineKeyboardButton("Удалить", callback_data='delete_post')
POST_CONTROL_KEYBOARD.add(PUBLIC_BTN)
POST_CONTROL_KEYBOARD.add(REJECT_BTN, DELETE_BTN)
