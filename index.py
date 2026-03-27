from bot import bot
import telebot
from json import JSONDecodeError


def handler(event, context):
    try:
        message = telebot.types.Update.de_json(event['body'])
    except JSONDecodeError:
        return {
            'statusCode': 400,
            'body': "Неверный запрос"
        }

    bot.process_new_updates([message])
    return {
        'statusCode': 200,
        'body': "OK",
    }