import json
import os
import time

import telebot

from bot import bot, db
from logger import logger


def handler(event, context):
    if 'messages' in event:
        run_scheduler()
        return {'statusCode': 200}

    if 'body' in event:
        body = json.loads(event['body'])
        update = telebot.types.Update.de_json(body)
        bot.process_new_updates([update])
        return {'statusCode': 200, 'body': 'ok'}

    return {'statusCode': 400}


def run_scheduler():
    logger.info("Scheduler check started...")
    now_us = int(time.time() * 1000000)

    posts = db.get_posts_to_publish(now_us)
    logger.info(f"Found {len(posts)} posts to publish")

    for p in posts:
        try:

            bot.send_message(os.getenv("CHANNEL_ID"), p.text)
            logger.info(f"Post {p.id} published to channel")

            db.update_post_status(p.id, 'published')

            try:
                bot.send_message(p.user_id, "🎉 Ваш пост опубликован в канале!")
            except Exception as e:
                logger.error(f"Could not notify author {p.user_id}: {e}")

        except Exception as e:
            logger.error(f"Failed to publish post {p.id}: {e}")
