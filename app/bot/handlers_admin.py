from uuid import UUID

from telebot.types import CallbackQuery

from app.bot import bot
from app.config import MODERATION_CHAT_ID
from app.infra.driver import driver
from app.repositories.factory import RepoFactory
from app.repositories.publication import PublicationRepository
from app.services.submission import SubmissionService

submission_service = SubmissionService(driver, RepoFactory(PublicationRepository))

async def is_moderator(user_id):
    member = await bot.get_chat_member(MODERATION_CHAT_ID, user_id)
    return member.status in ['creator', 'administrator']

@bot.callback_query_handler(func=lambda call: call.data == 'approve')
async def approve(call: CallbackQuery):
    if not await is_moderator(call.from_user.id):
        await bot.send_message(call.from_user.id, 'Вы не являетесь модератором')
        return
    publication_id = call.data.split(':')[1]
    await submission_service.approve(call.from_user.id, UUID(publication_id))
    await bot.reply_to(call.message, 'Публикация одобрена')

@bot.callback_query_handler(func=lambda call: call.data == 'reject')
async def reject(call: CallbackQuery):
    if not await is_moderator(call.from_user.id):
        await bot.send_message(call.from_user.id, 'Вы не являетесь модератором')
        return
    publication_id = call.data.split(':')[1]
    await submission_service.reject(call.from_user.id, UUID(publication_id)) # TODO
    await bot.reply_to(call.message, 'Публикация отклонена')