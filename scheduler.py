import datetime

from logger import logger

TZ_OFFSET = datetime.timezone(datetime.timedelta(hours=3))


def get_now():
    return datetime.datetime.now(TZ_OFFSET)


def calculate_next_time(after_time, config):
    if after_time.tzinfo is None:
        after_time = after_time.replace(tzinfo=TZ_OFFSET)

    slots = []
    for s in config['preferred_slots']:
        h, m = map(int, s.split(':'))
        slots.append(after_time.replace(hour=h, minute=m, second=0, microsecond=0))
    slots.sort()

    for slot in slots:

        if slot >= after_time + datetime.timedelta(seconds=config['min_interval']):
            if config['window_start'] <= slot.hour < config['window_end']:
                return slot

    tomorrow_morning = (after_time + datetime.timedelta(days=1)).replace(
        hour=config['window_start'], minute=0, second=0, microsecond=0
    )

    return calculate_next_time(tomorrow_morning - datetime.timedelta(seconds=config['min_interval']), config)


def rebalance_queue(db):
    logger.info("Rebalance queue")
    config = db.get_config("scheduler")
    if not config:
        logger.info("Not config")
        return

    logger.info("Config ok")
    now = get_now()
    last_publish_us = db.get_latest_published_time()
    day_stats = {}

    if last_publish_us:
        last_dt = datetime.datetime.fromtimestamp(last_publish_us / 1000000, tz=TZ_OFFSET)
        current_point = max(now, last_dt)
        if last_dt.date() == now.date():
            day_stats[now.date()] = 1
    else:
        current_point = now

    logger.info("Get posts")

    scheduled_posts = sorted(
        db.get_scheduled_queue(),
        key=lambda post: print(post.created_at, type(post.created_at)) or post.created_at
    )
    print(scheduled_posts)

    updates = []
    logger.info("Start scheduling")

    for post in scheduled_posts:
        while True:
            next_time = calculate_next_time(current_point, config)
            post_date = next_time.date()
            current_day_count = day_stats.get(post_date, 0)

            if current_day_count < config['posts_per_day']:
                ts = int(next_time.timestamp() * 1000000)

                updates.append({
                    "id": post.id,
                    "publish_at": ts
                })

                day_stats[post_date] = current_day_count + 1
                current_point = next_time
                break
            else:
                current_point = next_time.replace(hour=23, minute=59, second=59)

    if updates:
        db.update_posts_batch(updates)
        logger.info(f"Batch updated {len(updates)} posts in queue.")
