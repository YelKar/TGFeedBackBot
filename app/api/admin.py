from typing import List

from telebot.async_telebot import AsyncTeleBot

from app.domain.publication import Publication
from app.services.submission import SubmissionService


class AdminApi:
    def __init__(self, bot: AsyncTeleBot, submission_service: SubmissionService):
        self.__bot = bot
        self.__submission_service = submission_service

    async def get_suggestions(self) -> List[Publication]:
        return await self.__submission_service.get_suggestions()

    async def get_rejections(self) -> List[Publication]:
        return await self.__submission_service.get_rejections()

    async def get_approvals(self) -> List[Publication]:
        return await self.__submission_service.get_approvals()
