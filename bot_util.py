import os
from datetime import datetime

import requests
from telebot import types
from telebot.apihelper import ApiTelegramException
from ydb.convert import _Row

from logger import logger
from rating import THRESHOLD
from scheduler import rebalance_queue

FEEDBACK_CHAT_ID = int(os.getenv('CHAT_ID'))


def handle_exception(e, bot, message=None):
    """Универсальный обработчик ошибок."""
    if isinstance(e, ApiTelegramException):
        if e.error_code == 403:
            logger.warning(f"ПОЛЬЗОВАТЕЛЬ ЗАБЛОКИРОВАЛ БОТА: {e.description}")
            return
        if "message is not modified" in e.description:
            return
        if e.error_code == 400:
            logger.error(f"ОШИБКА ЗАПРОСА (400): {e.description}")
            if message:
                bot.reply_to(message, f"<b>Ошибка телеграма:</b> {e.description}")
            return
        logger.error(f"API EXCEPTION {e.error_code}: {e.description}")
    elif isinstance(e, (requests.exceptions.RequestException, ConnectionError, Exception)) and "SSL" in str(e):
        logger.error(f"КРИТИЧЕСКАЯ ОШИБКА СЕТИ ИЛИ ПРОКСИ: {e}")
        if message:
            bot.reply_to(message, "<b>Сетевая ошибка:</b> Не удалось связаться с сервером. Проверьте прокси.")
    elif "ydb" in str(type(e)).lower():
        logger.error(f"ОШИБКА БАЗЫ ДАННЫХ YDB: {e}")
        if message:
            bot.reply_to(message, "<b>Ошибка БД:</b> Временные неполадки с хранилищем.")
    else:
        logger.exception(f"НЕПРЕДВИДЕННАЯ ОШИБКА: {e}")
        if message:
            bot.reply_to(message, "<b>Произошла внутренняя ошибка</b>")


def get_admin_keyboard(post_id, is_final=False):
    """Создает клавиатуру. Цифры исчезают, когда решение принято."""
    if is_final:
        return None
    kb = types.InlineKeyboardMarkup()
    btns = [types.InlineKeyboardButton(str(i), callback_data=f"v:{i}:{post_id}") for i in range(1, 6)]
    kb.row(*btns)
    return kb


def refresh_admin_message(bot, db, post_id, admin_chat_id, admin_msg_id, do_sync=True):
    post_data = db.get_post(post_id)
    if not post_data: return

    is_published = post_data.status == 'published'

    if not is_published:
        votes_rows = db.get_post_votes(post_id)
        current_scores = [v.vote for v in votes_rows]
        votes_list = ", ".join([f"@{v.admin_username}: {v.vote}" for v in votes_rows])

        try:
            admins = bot.get_chat_administrators(admin_chat_id)
            total_admins = len([a for a in admins if not a.user.is_bot])
        except:
            total_admins = 1

        from rating import get_rating_status
        res = get_rating_status(current_scores, total_admins)

        is_approved = res['is_guaranteed_approved'] or (res['is_final'] and res['estimation'] >= THRESHOLD)
        is_rejected = res['is_guaranteed_rejected'] or (res['is_final'] and res['estimation'] < THRESHOLD)

        new_status = post_data.status
        if is_approved:
            new_status = 'scheduled'
        elif is_rejected:
            new_status = 'rejected'
        elif post_data.status == 'scheduled':
            new_status = 'pending'

        logger.info(
            f"Post {post_id} status changed from {post_data.status} to {new_status}. Publish at {post_data.publish_at}")

        if new_status != post_data.status or post_data.status == 'scheduled' and post_data.publish_at is None:
            db.update_post_status(post_id, new_status)
            logger.info(f"Post {post_id} status changed to {new_status}. Updating queue: {do_sync}")
            if do_sync:
                logger.info(f"Updating queue for post {post_id}")
                update_queue(bot, db)
            post_data = db.get_post(post_id)
            logger.info(f"Post {post_id} status changed to {post_data.status}. New publish at {post_data.publish_at}")
    else:
        res = {'estimation': 0, 'is_final': True}
        votes_list = ""

    text_parts = [
        f"<b>От @{post_data.username}:</b>",
        f"{post_data.text}",
    ]

    if is_published:
        text_parts.append("<b>Опубликовано</b>")
    else:
        logger.info(f"Post {post_id} is not published yet")
        if votes_list:
            text_parts.append(f"Оценка {res['estimation']:.2f} ({votes_list})")
        logger.info(f"Check status: {post_data.status}")
        if post_data.status == 'scheduled' and post_data.publish_at:
            from scheduler import TZ_OFFSET
            pub_time = datetime.fromtimestamp(post_data.publish_at / 1000000, tz=TZ_OFFSET)
            text_parts.append(f"<b>В очереди на: {pub_time.strftime('%H:%M (%d.%m)')}</b>")

        if not res['is_final'] and post_data.status != 'rejected':
            text_parts.append(f"Прогноз: {res['min_estimation']:.2f} — {res['max_estimation']:.2f}")
            if res['is_guaranteed_approved']:
                text_parts.append("<b>Предварительно одобрено</b>")
            elif res['is_guaranteed_rejected']:
                text_parts.append("<b>Предварительно отклонено</b>")
        else:
            if post_data.status == 'scheduled':
                text_parts.append("<b>Одобрено</b>")
            elif post_data.status == 'rejected':
                text_parts.append("<b>Отклонено</b>")
                res['is_final'] = True

    try:
        bot.edit_message_text(
            text="\n\n".join(text_parts),
            chat_id=admin_chat_id,
            message_id=admin_msg_id,
            reply_markup=get_admin_keyboard(post_id, is_final=res['is_final']),
            parse_mode='HTML'
        )
    except Exception as e:
        if "message is not modified" not in str(e):
            logger.error(f"Error editing message {admin_msg_id}: {e}")


def sync_scheduler_messages(bot, db, exclude_id=None):
    """Обновляет сообщения всех постов, которые сейчас в очереди."""
    queue = db.get_scheduled_queue()
    for p in queue:
        if p.id == exclude_id:
            continue
        if p.admin_msg_id:
            refresh_admin_message(bot, db, p.id, FEEDBACK_CHAT_ID, p.admin_msg_id, do_sync=False)


def update_queue(bot, db):
    """Пересчитывает время в БД и обновляет интерфейс очереди."""
    rebalance_queue(db)
    sync_scheduler_messages(bot, db)


def publish_post(bot, db, post: _Row):
    import time
    try:
        bot.send_message(os.getenv("CHANNEL_ID"), post.text)

        now_us = int(time.time() * 1000000)
        db.update_post_status(post.id, 'published', now_us)

        try:
            bot.send_message(post.user_id, "🎉 Ваш пост опубликован!")
        except:
            pass

        update_queue(bot, db)

        if post.get('admin_msg_id'):
            logger.info(f"Refreshing admin message {post.admin_msg_id}")
            refresh_admin_message(bot, db, post.id, FEEDBACK_CHAT_ID, post.admin_msg_id)

    except Exception as e:
        handle_exception(e, bot)
