import telebot

from bot import bot, db
from bot_util import publish_post
from logger import logger
from scheduler import get_now


def handler(event, context):
    if 'messages' in event and event['messages'][0]['details'].get('payload') == "scheduler":
        run_scheduler()
        return {'statusCode': 200}

    if 'body' in event:
        update = telebot.types.Update.de_json(event['body'])
        bot.process_new_updates([update])
        return {'statusCode': 200, 'body': 'ok'}

    return {'statusCode': 400}


def run_scheduler():
    logger.info("Scheduler check started...")

    posts = db.get_posts_to_publish(get_now())

    for p in posts:
        try:
            publish_post(bot, db, p)

        except Exception as e:
            logger.error(f"Failed to publish post {p.id}: {e}")
