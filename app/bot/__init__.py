from telebot.async_telebot import AsyncTeleBot
from app.config import BOT_TOKEN
from loguru import logger

bot = AsyncTeleBot(BOT_TOKEN)

def list_handlers():

    event_attrs = {
        "message": "message_handlers",
        "callback_query": "callback_query_handlers",
        "edited_message": "edited_message_handlers",
        "inline_query": "inline_query_handlers",
        "chosen_inline_result": "chosen_inline_result_handlers",
        "shipping_query": "shipping_query_handlers",
        "pre_checkout_query": "pre_checkout_query_handlers",
        "poll": "poll_handlers",
        "poll_answer": "poll_answer_handlers",
    }
    print('Handlers:')

    for event, attr in event_attrs.items():
        handlers_dict = getattr(bot, attr, None)
        if handlers_dict:
            for h in handlers_dict:
                func = h.get("function")
                filters = h.get("filters", {})

                commands = filters.get("commands")
                content_types = filters.get("content_types")
                regexp = filters.get("regexp")
                func_filter = filters.get("func")

                parts = []
                if commands: parts.append(f"commands={commands}")
                if content_types: parts.append(f"content_types={content_types}")
                if regexp: parts.append(f"regexp={regexp}")
                if func_filter: parts.append(f"func_filter={func_filter}")

                filters_str = ", ".join(parts) if parts else "no filters"

                print(f"\t[{event}] {func.__name__} | {filters_str}")


async def start_bot():
    from app.bot import handlers_user, handlers_admin

    me = await bot.get_me()

    logger.info(f"Bot started: {me.first_name} (@{me.username}), id={me.id}")
    list_handlers()
    await bot.infinity_polling()
