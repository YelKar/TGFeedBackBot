from datetime import datetime

import ydb.aio
from telebot.async_telebot import AsyncTeleBot

from app.domain.publication import Publication
from app.services.scheduler import Scheduler
from app.config import CHANNEL_ID

class Publisher:
    def __init__(self, driver: ydb.aio.Driver, scheduler: Scheduler, bot: AsyncTeleBot):
        self.driver = driver
        self.scheduler = scheduler
        self.bot = bot

    async def publish(self):
        publications = await self.scheduler.get_publications_to_publish()
        for publication in publications:
            await self.__publish_one(publication)

        await self.scheduler.publish(list(map(lambda pub: pub.publication_id, publications)))

    async def __publish_one(self, publication: Publication):
        await self.bot.send_message(CHANNEL_ID, publication.content)

