import uuid
from datetime import datetime
from typing import List

import ydb

from app.domain.publication import Publication
from app.repositories.factory import RepoFactory
from app.repositories.publication import PublicationRepository


class SubmissionService:
    def __init__(self, driver: ydb.aio.Driver, publication_repo_factory: RepoFactory[PublicationRepository]):
        self.publication_repo_factory = publication_repo_factory
        self.driver = driver

    async def suggest(self, by: int, content: str):
        async with ydb.aio.QuerySessionPool(self.driver) as pool:
            publication_repo = self.publication_repo_factory(pool)
            await publication_repo.add(
                Publication(
                    uuid.uuid4(),
                    by,
                    content,
                    "pending",
                    datetime.now(),
                )
            )

    async def __get_by_status(self, status: str) -> List[Publication]:
        async with ydb.aio.QuerySessionPool(self.driver) as pool:
            publication_repo = self.publication_repo_factory(pool)
            return await publication_repo.get_by_status(status)

    async def get_suggestions(self) -> List[Publication]:
        return await self.__get_by_status("pending")

    async def get_rejections(self) -> List[Publication]:
        return await self.__get_by_status("rejected")

    async def get_approvals(self) -> List[Publication]:
        return await self.__get_by_status("approved")

    async def approve(self, by: int, publication_id: uuid.UUID):
        async with ydb.aio.QuerySessionPool(self.driver) as pool:
            publication_repo = self.publication_repo_factory(pool)
            publication = await publication_repo.get(publication_id)
            if publication is None:
                raise ValueError("Publication not found")
            publication.status = "approved"
            publication.approved_at = datetime.now()
            publication.approved_by = by
            await publication_repo.update(publication)


    async def reject(self, by: int, publication_id: uuid.UUID):
        async with ydb.aio.QuerySessionPool(self.driver) as pool:
            publication_repo = self.publication_repo_factory(pool)
            publication = await publication_repo.get(publication_id)
            if publication is None:
                raise ValueError("Publication not found")
            publication.status = "rejected"
            publication.rejected_at = datetime.now()
            publication.rejected_by = by
            await publication_repo.update(publication)
