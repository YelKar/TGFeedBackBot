import json

import telebot

from bot import bot


def handler(event, context):
    if 'messages' in event:
        return {'statusCode': 200}

    if 'body' in event:
        body = json.loads(event['body'])
        update = telebot.types.Update.de_json(body)
        bot.process_new_updates([update])
        return {'statusCode': 200, 'body': 'ok'}

    return {'statusCode': 400}
