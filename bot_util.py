import hashlib, hmac, os, time, urllib
from datetime import datetime
from telebot import types
from telebot.apihelper import ApiTelegramException
from logger import logger
from rating import THRESHOLD, get_rating_status
from scheduler import rebalance_queue, TZ_OFFSET
from html.parser import HTMLParser

FEEDBACK_CHAT_ID = int(os.getenv('CHAT_ID'))

# Кэш для количества админов (чтобы не дергать API Telegram каждую секунду)
ADMIN_CACHE = {"count": 1, "expires_at": 0}
ADMIN_TTL = 600  # 10 минут


class HtmlStripper(HTMLParser):
    def __init__(self):
        super().__init__()
        self.data = []

    def handle_data(self, data):
        self.data.append(data)

    def GetText(self):
        return ''.join(self.data)


def StripHtml(html):
    stripper = HtmlStripper()
    stripper.feed(html)
    return stripper.GetText()


def get_admin_count(bot):
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


def calculate_analytics(votes_rows, total_admins):
    """Чистая математика расчета без запросов к БД."""
    current_scores = [v.vote for v in votes_rows]
    votes_list = ", ".join([f"@{v.admin_username}: {v.vote}" for v in votes_rows])

    res = get_rating_status(current_scores, total_admins)

    is_approved = res['is_guaranteed_approved'] or (res['is_final'] and res['estimation'] >= THRESHOLD)
    is_rejected = res['is_guaranteed_rejected'] or (res['is_final'] and res['estimation'] < THRESHOLD)

    return {
        "res": res,
        "votes_list": votes_list,
        "is_approved": is_approved,
        "is_rejected": is_rejected
    }


def get_post_analytics(bot, db, post_id):
    """Метод для одиночного поста (используется в боте)."""
    votes_rows = db.get_post_votes(post_id)
    total_admins = get_admin_count(bot)
    return calculate_analytics(votes_rows, total_admins)


def apply_action(bot, db, post_id, action, admin_id=None, admin_username=None, extra_val=None):
    """
    Единая точка входа для всех команд.
    Выполняет действие и обновляет ТОЛЬКО ОДНО сообщение.
    """

    logger.info("Action applying...")
    post_data = db.get_post(post_id)
    if not post_data: return False

    logger.info("Post have got...")
    # 1. Выполняем действие в БД
    if action == 'vote':
        logger.info("Vote @" + str(admin_username) + "(" + str(admin_id) + ")")
        db.add_vote(post_id, admin_id, admin_username, int(extra_val))
        logger.info("Vote created")
    elif action == 'reject':
        db.update_post_status(post_id, 'rejected')
    elif action == 'schedule':
        db.update_post_status(post_id, 'scheduled')
    elif action == 'publish_now':
        publish_post(bot, db, post_data)
        return True
    elif action == 'edit':
        db.update_post_text(post_id, extra_val)
    elif action == 'block':
        db.block_user(post_data.user_id)
        db.update_post_status(post_id, 'rejected')

    # 2. Если действие влияет на рейтинг, проверяем авто-статус
    if action == 'vote':
        ana = get_post_analytics(bot, db, post_id)
        if ana['is_approved']:
            db.update_post_status(post_id, 'scheduled')
        elif ana['is_rejected']:
            db.update_post_status(post_id, 'rejected')

    # 3. Пересчитываем очередь в фоне (только в БД для WebUI)
    if action in ['vote', 'reject', 'schedule', 'block']:
        rebalance_queue(db)

    # 4. Обновляем ТОЛЬКО текущую карточку
    refresh_admin_message(bot, db, post_id, FEEDBACK_CHAT_ID, post_data.admin_msg_id)
    return True


def refresh_admin_message(bot, db, post_id, admin_chat_id, admin_msg_id):
    """Перерисовывает карточку поста в чате модерации."""
    post_data = db.get_post(post_id)
    print(post_data)
    if not post_data or not admin_msg_id: return

    ana = get_post_analytics(bot, db, post_id)

    # Формируем статусную строку
    status_map = {
        'pending': '⏳ В ОЖИДАНИИ',
        'scheduled': '📅 ОДОБРЕНО (В очереди)',
        'rejected': '❌ ОТКЛОНЕНО',
        'published': '✅ ОПУБЛИКОВАНО'
    }
    current_status = status_map.get(post_data.status, post_data.status)

    text_parts = [
        f"<b>От @{post_data.username} [{post_data.sequence_number}]:</b>",
        post_data.text,
        f"Статус: <b>{current_status}</b>"
    ]

    if ana['votes_list']:
        text_parts.append(f"Оценки: {ana['votes_list']} (Средняя: {ana['res']['estimation']:.2f})")

    if post_data.status == 'pending' and not ana['res']['is_final']:
        text_parts.append(f"Прогноз: {ana['res']['min_estimation']:.2f} — {ana['res']['max_estimation']:.2f}")

    new_text = "\n\n".join(text_parts)
    is_final = post_data.status in ['scheduled', 'rejected', 'published']

    kb = get_admin_keyboard(post_id, is_final=is_final)
    kb.add(types.InlineKeyboardButton(
        text="Скопировать",
        copy_text=types.CopyTextButton(
            text=StripHtml(post_data.text)
        )
    ))
    try:
        bot.edit_message_text(
            new_text,
            admin_chat_id,
            admin_msg_id,
            reply_markup=kb,
            parse_mode='HTML'
        )
    except Exception as e:
        if "message is not modified" not in str(e):
            logger.error(f"UI Update Error: {e}")


def publish_post(bot, db, post):
    """Публикация поста в канал."""
    try:
        bot.send_message(os.getenv("CHANNEL_ID"), post.text)
        db.update_post_status(post.id, 'published', int(time.time() * 1000000))

        # Уведомляем автора
        try:
            bot.send_message(post.user_id, "🎉 Ваш пост опубликован!")
        except:
            pass

        # Пересчитываем очередь (в БД)
        rebalance_queue(db)

        # Обновляем карточку (статус станет "Опубликовано")
        if post.admin_msg_id:
            refresh_admin_message(bot, db, post.id, FEEDBACK_CHAT_ID, post.admin_msg_id)

    except Exception as e:
        handle_exception(e, bot)


def get_admin_keyboard(post_id, is_final=False):
    """Генерация кнопок."""
    kb = types.InlineKeyboardMarkup()
    if not is_final:
        btns = [types.InlineKeyboardButton(str(i), callback_data=f"v:{i}:{post_id}") for i in range(1, 6)]
        kb.row(*btns)

    # Кнопка отклонения есть почти всегда (кроме уже опубликованных)
    kb.add(types.InlineKeyboardButton("ОТКЛОНИТЬ", callback_data=f"reject:{post_id}"))
    return kb


def handle_exception(e, bot, message=None):
    if isinstance(e, ApiTelegramException):
        if e.error_code == 403: return
        if "message is not modified" in e.description: return
        if message: bot.reply_to(message, f"<b>Ошибка ТГ:</b> {e.description}")
    else:
        logger.exception(e)
        if message: bot.reply_to(message, "<b>Внутренняя ошибка</b>")


# Функции для Web API (WebUI)
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