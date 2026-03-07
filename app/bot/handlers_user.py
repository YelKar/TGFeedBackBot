from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton, Message

from app.bot import bot
from app.bot.answers import USER, ADMIN
from loguru import logger

from app.config import MODERATION_CHAT_ID
from app.infra.driver import driver
from app.repositories.factory import RepoFactory
from app.repositories.publication import PublicationRepository
from app.services.submission import SubmissionService

submission_service = SubmissionService(driver, RepoFactory(PublicationRepository))

@bot.message_handler(commands=['start'])
async def start(message):
    await bot.send_message(message.chat.id, 'Hello, world')
    logger.info(f'User {message.from_user.username}#{message.from_user.id} started the bot')


# В чат модерации надо прислать колбэк-клавиатуру под сообщением.
@bot.message_handler(commands=['new'])
async def suggest_publication(message: Message):
    message_text = message.text[5:]


    publication_id = await submission_service.suggest(message.from_user.id, message_text) # TODO

    await bot.send_message(message.chat.id, USER['new'])
    kb = InlineKeyboardMarkup()
    kb.row(
        InlineKeyboardButton("Одобрить", callback_data=f'approve:{publication_id}'),
        InlineKeyboardButton("Отклонить", callback_data=f'reject:{publication_id}'),
    )
    await bot.send_message(
        MODERATION_CHAT_ID,
        ADMIN['new'].format(
            username=message.from_user.username,
            user_id=message.from_user.id,
            content=message_text
        ),
        reply_markup=kb,
    )
    logger.info(f'User {message.from_user.username}#{message.from_user.id} sent a new post:\n{message.text}')
