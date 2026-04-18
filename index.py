import base64, json, os, time
import telebot
from bot import bot, db
from bot_util import apply_action, get_post_analytics, FEEDBACK_CHAT_ID, publish_post, verify_tg_data, \
    get_user_from_data
from scheduler import get_now
from logger import logger


def handle_api(event, db, bot):
    cors_headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Tg-Data, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    }
    if event.get('httpMethod') == 'OPTIONS': return {'statusCode': 200, 'headers': cors_headers}

    h = event.get('headers', {})
    init_data = h.get('X-Tg-Data') or h.get('authorization') or h.get('Authorization')
    if not verify_tg_data(init_data, os.getenv("TOKEN")):
        return {'statusCode': 401, 'headers': cors_headers, 'body': '{"error":"Unauthorized"}'}

    user_info = get_user_from_data(init_data)
    user_id = user_info.get('id')

    try:
        member = bot.get_chat_member(FEEDBACK_CHAT_ID, user_id)
        is_admin = member.status in ['creator', 'administrator']
    except:
        is_admin = False

    params = event.get('queryStringParameters', {}) or {}
    method = params.get('method')
    limit = int(params.get('limit', 10))
    last_ts = params.get('last_ts')

    if method == 'get_posts' or method == 'get_my_posts':
        if not is_admin or method == 'get_my_posts':
            posts = db.get_filtered_posts(user_id=user_id, limit=limit, last_ts=last_ts)
        else:
            posts = db.get_filtered_posts(status=params.get('status', 'pending'), limit=limit, last_ts=last_ts)

        full_data = []
        for p in posts:
            ana = get_post_analytics(bot, db, p.id)
            full_data.append({
                "id": p.id, "username": p.username, "text": p.text, "status": p.status,
                "publish_at": p.publish_at / 1000000 if p.publish_at else None,
                "created_at": p.created_at / 1000000,
                "analytics": ana
            })
        return {'statusCode': 200, 'headers': cors_headers,
                'body': json.dumps({'posts': full_data, 'role': 'admin' if is_admin else 'user'}, default=str)}

    if method == 'get_single_post':
        p = db.get_post(params.get('post_id'))
        if not p: return {'statusCode': 404, 'headers': cors_headers}
        ana = get_post_analytics(bot, db, p.id)
        full_data = {
            "id": p.id, "username": p.username, "text": p.text, "status": p.status,
            "publish_at": p.publish_at / 1000000 if p.publish_at else None,
            "created_at": p.created_at / 1000000, "analytics": ana
        }
        return {'statusCode': 200, 'headers': cors_headers, 'body': json.dumps(full_data, default=str)}

    if method == 'action':
        body_raw = event.get('body') or '{}'
        if event.get('isBase64Encoded'): body_raw = base64.b64decode(body_raw).decode('utf-8')
        body = json.loads(body_raw)
        apply_action(bot, db, post_id=body.get('post_id'), action=body.get('action'),
                     admin_id=user_id, admin_username=user_info.get('username'),
                     extra_val=body.get('val') or body.get('text'))
        return {'statusCode': 200, 'headers': cors_headers, 'body': '{"ok":true}'}

    return {'statusCode': 404, 'headers': cors_headers}


def handler(event, context):
    if 'messages' in event:
        details = event['messages'][0].get('details', {})
        if details.get('payload') == "scheduler":
            now_us = int(get_now().timestamp() * 1000000)
            posts = db.get_posts_to_publish(now_us)
            for p in posts: publish_post(bot, db, p)
            return {'statusCode': 200}

    if 'httpMethod' in event:
        params = event.get('queryStringParameters') or {}
        if 'method' in params: return handle_api(event, db, bot)
        if 'body' in event:
            try:
                body = event['body']
                if event.get('isBase64Encoded'):
                    body = base64.b64decode(body).decode('utf-8')
                update = telebot.types.Update.de_json(body)
                bot.process_new_updates([update])
                return {'statusCode': 200, 'body': 'ok'}
            except Exception as e:
                logger.error(f"Webhook Error: {e}")
                return {'statusCode': 500}
    return {'statusCode': 400}