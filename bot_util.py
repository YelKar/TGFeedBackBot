import hashlib, hmac, os, time, urllib
from datetime import datetime
from telebot import types
from telebot.apihelper import ApiTelegramException
from logger import logger
from rating import THRESHOLD, get_rating_status
from scheduler import rebalance_queue, TZ_OFFSET

FEEDBACK_CHAT_ID = int(os.getenv('CHAT_ID'))

# Глобальные кэши
UI_CACHE = {}
ADMIN_CACHE = {"count": 1, "expires_at": 0}
ADMIN_TTL = 600  # 10 минут


def get_admin_count(bot):
    """Кэшированное получение количества админов."""
    now = time.time()
    if now < ADMIN_CACHE["expires_at"]:
        return ADMIN_CACHE["count"]

    try:
        admins = bot.get_chat_administrators(FEEDBACK_CHAT_ID)
        count = len([a for a in admins if not a.user.is_bot])
        ADMIN_CACHE["count"] = count
        ADMIN_CACHE["expires_at"] = now + ADMIN_TTL
        return count
    except Exception as e:
        logger.error(f"Error fetching admins: {e}")
        return ADMIN_CACHE["count"]


def get_post_analytics(bot, db, post_id):
    """Расчет аналитики с использованием кэша админов."""
    votes_rows = db.get_post_votes(post_id)
    current_scores = [v.vote for v in votes_rows]
    votes_list = ", ".join([f"@{v.admin_username}: {v.vote}" for v in votes_rows])

    total_admins = get_admin_count(bot)
    res = get_rating_status(current_scores, total_admins)

    is_approved = res['is_guaranteed_approved'] or (res['is_final'] and res['estimation'] >= THRESHOLD)
    is_rejected = res['is_guaranteed_rejected'] or (res['is_final'] and res['estimation'] < THRESHOLD)

    return {
        "res": res,
        "votes_list": votes_list,
        "is_approved": is_approved,
        "is_rejected": is_rejected,
        "total_admins": total_admins,
        "voted_count": len(votes_rows)
    }


def apply_action(bot, db, post_id, action, admin_id=None, admin_username=None, extra_val=None):
    """Точка входа для действий."""
    post_data = db.get_post(post_id)
    if not post_data: return False

    if action == 'vote':
        db.add_vote(post_id, admin_id, admin_username, int(extra_val))
    elif action == 'reject':
        db.update_post_status(post_id, 'rejected')
    elif action == 'schedule':
        db.update_post_status(post_id, 'scheduled')
    elif action == 'pending':
        db.update_post_status(post_id, 'pending')
    elif action == 'publish_now':
        publish_post(bot, db, post_data)
        return True
    elif action == 'edit':
        db.update_post_text(post_id, extra_val)
    elif action == 'block':
        db.block_user(post_data.user_id)
        db.update_post_status(post_id, 'rejected')

    refresh_admin_message(bot, db, post_id, FEEDBACK_CHAT_ID, post_data.admin_msg_id)
    return True


def refresh_admin_message(bot, db, post_id, admin_chat_id, admin_msg_id, do_sync=True):
    """Отрисовка UI карточки."""
    post_data = db.get_post(post_id)
    if not post_data or not admin_msg_id: return

    if post_data.status == 'published':
        new_text = f"<b>От @{post_data.username}:</b>\n\n{post_data.text}\n\n<b>ОПУБЛИКОВАНО</b>"
        new_markup = None
        is_final = True
    else:
        ana = get_post_analytics(bot, db, post_id)

        new_status = post_data.status
        if post_data.status != 'published':
            if ana['is_approved']:
                new_status = 'scheduled'
            elif ana['is_rejected']:
                new_status = 'rejected'
            elif post_data.status == 'scheduled' and not ana['is_approved']:
                new_status = 'rejected'

        needs_rebalance = (new_status == 'scheduled' and not post_data.publish_at)

        if new_status != post_data.status or needs_rebalance:
            db.update_post_status(post_id, new_status)
            if do_sync:
                update_queue(bot, db)
            else:
                rebalance_queue(db)
            post_data = db.get_post(post_id)

        text_parts = [f"<b>От @{post_data.username}:</b>", post_data.text]
        if ana['votes_list']: text_parts.append(f"Оценка {ana['res']['estimation']:.2f} ({ana['votes_list']})")
        if post_data.status == 'scheduled' and post_data.publish_at:
            pub_time = datetime.fromtimestamp(post_data.publish_at / 1000000, tz=TZ_OFFSET)
            text_parts.append(f"<b>В ОЧЕРЕДИ НА: {pub_time.strftime('%H:%M (%d.%m)')}</b>")

        if not ana['res']['is_final'] and post_data.status != 'rejected':
            text_parts.append(f"Прогноз: {ana['res']['min_estimation']:.2f} — {ana['res']['max_estimation']:.2f}")
            if ana['res']['is_guaranteed_approved']: text_parts.append("<b>ПРЕДВАРИТЕЛЬНО ОДОБРЕНО</b>")
        else:
            status_map = {'scheduled': 'ОДОБРЕНО', 'rejected': 'ОТКЛОНЕНО'}
            text_parts.append(f"<b>{status_map.get(post_data.status, 'В ОЖИДАНИИ')}</b>")

        new_text = "\n\n".join(text_parts)
        is_final = post_data.status in ['scheduled', 'rejected']
        new_markup = get_admin_keyboard(post_id, is_final=is_final)

    cache_key = f"{admin_chat_id}_{admin_msg_id}"
    if UI_CACHE.get(cache_key) == new_text: return

    try:
        bot.edit_message_text(new_text, admin_chat_id, admin_msg_id, reply_markup=new_markup, parse_mode='HTML')
        UI_CACHE[cache_key] = new_text
    except Exception as e:
        if "message is not modified" in str(e):
            UI_CACHE[cache_key] = new_text
        else:
            logger.error(f"UI Update Error: {e}")


def update_queue(bot, db):
    """Синхронный ребаланс и обновление всех карточек очереди."""
    rebalance_queue(db)
    queue = db.get_scheduled_queue()
    for p in queue:
        if p.admin_msg_id:
            refresh_admin_message(bot, db, p.id, FEEDBACK_CHAT_ID, p.admin_msg_id, do_sync=False)


def publish_post(bot, db, post):
    try:
        bot.send_message(os.getenv("CHANNEL_ID"), post.text)
        db.update_post_status(post.id, 'published', int(time.time() * 1000000))
        try:
            bot.send_message(post.user_id, "🎉 Ваш пост опубликован!")
        except:
            pass
        update_queue(bot, db)
        if post.admin_msg_id:
            refresh_admin_message(bot, db, post.id, FEEDBACK_CHAT_ID, post.admin_msg_id, do_sync=False)
    except Exception as e:
        handle_exception(e, bot)


def get_admin_keyboard(post_id, is_final=False):
    kb = types.InlineKeyboardMarkup()
    if not is_final:
        btns = [types.InlineKeyboardButton(str(i), callback_data=f"v:{i}:{post_id}") for i in range(1, 6)]
        kb.row(*btns)
    kb.add(types.InlineKeyboardButton("ОТКЛОНИТЬ", callback_data=f"reject:{post_id}"))
    return kb


def handle_exception(e, bot, message=None):
    if isinstance(e, ApiTelegramException):
        if e.error_code == 403: return
        if "message is not modified" in e.description: return
        if message: bot.reply_to(message, f"<b>Ошибка ТГ:</b> {e.description}")
    elif "SSL" in str(e) or "Timeout" in str(e):
        if message: bot.reply_to(message, "<b>Ошибка прокси</b>")
    else:
        logger.exception(e)
        if message: bot.reply_to(message, "<b>Ошибка сервера</b>")


def verify_tg_data(init_data, token):
    if not init_data: return False
    try:
        parsed_data = dict(urllib.parse.parse_qsl(init_data, keep_blank_values=True))
        received_hash = parsed_data.pop('hash', None)
        if not received_hash: return False
        keys_sorted = sorted(parsed_data.keys())
        data_check_string = "\n".join([f"{k}={parsed_data[k]}" for k in keys_sorted])
        secret_key = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
        computed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        return computed_hash == received_hash
    except:
        return False


def get_user_from_data(init_data):
    import json
    vals = {k: v[0] for k, v in urllib.parse.parse_qs(init_data).items()}
    return json.loads(vals.get('user', '{}'))