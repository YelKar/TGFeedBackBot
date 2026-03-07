from datetime import date
from uuid import UUID

import ydb
from app.domain.publish_event import PublishEvent
from typing import List, Optional


class PublishEventRepository:
    def __init__(self, pool: ydb.aio.QuerySessionPool):
        self.pool = pool

    async def add(self, event: PublishEvent) -> None:
        sql = """
        UPSERT INTO publish_event
        (event_id, publication_id, publish_at, type, status, created_at)
        VALUES
        ($event_id, $publication_id, $publish_at, $type, $status, $created_at);
        """
        await self.pool.execute_with_retries(
            sql,
            {
                "$event_id": (event.event_id, ydb.PrimitiveType.UUID),
                "$publication_id": (event.publication_id, ydb.PrimitiveType.UUID),
                "$publish_at": (event.publish_at, ydb.PrimitiveType.Datetime),
                "$type": (event.type, ydb.PrimitiveType.String),
                "$status": (event.status, ydb.PrimitiveType.String),
                "$created_at": (event.created_at, ydb.PrimitiveType.Datetime)
            }
        )

    async def get(self, event_id: UUID) -> Optional[PublishEvent]:
        sql = """
        SELECT * FROM publish_event WHERE event_id = $event_id;
        """
        result = await self.pool.execute_with_retries(
            sql,
            {
                "$event_id": (event_id, ydb.PrimitiveType.UUID)
            }
        )
        if not result or not result[0].rows:
            return None

        row = result[0].rows[0]
        return PublishEvent(
            # TODO
        )


    async def update(self, event: PublishEvent) -> None:
        sql = """
        UPDATE publish_event
        SET
            publish_at = $publish_at,
            status = $status
        WHERE
            event_id = $event_id;
        """
        await self.pool.execute_with_retries(
            sql,
            {
                "$status": (event.status, ydb.PrimitiveType.String),
                "$publish_at": (event.publish_at, ydb.PrimitiveType.Datetime),
                "$event_id": (event.event_id, ydb.PrimitiveType.UUID)
            }
        )

    async def get_day(self, date_: date) -> List[PublishEvent]:
        sql = """
        SELECT * FROM publish_event WHERE publish_at::date = $date;
        """ # TODO исправить запрос под YQL
        result = await self.pool.execute_with_retries(
            sql,
            {
                "$date": (date_, ydb.PrimitiveType.Date)
            }
        )
        if not result or not result[0].rows:
            return []

        rows = result[0].rows
        return [PublishEvent(**row) for row in rows]  # TODO

    async def get_planned(self) -> List[PublishEvent]:
        return await self.__get_by_status("planned")

    async def get_published(self) -> List[PublishEvent]:
        return await self.__get_by_status("published")

    async def get_cancelled(self) -> List[PublishEvent]:
        return await self.__get_by_status("cancelled")

    async def get_next_auto_publish_event(self) -> Optional[PublishEvent]:
        sql = """
        SELECT 
            *
        FROM 
            publish_event
        WHERE 
            type = 'auto'
            AND status = 'planned'
        ORDER BY 
            publish_at ASC LIMIT 1;
        """
        result = await self.pool.execute_with_retries(
            sql,
        )
        if not result or not result[0].rows:
            return None

        row = result[0].rows[0]
        return PublishEvent(**row)  # TODO

    async def __get_by_status(self, status: str) -> List[PublishEvent]:
        sql = """
        SELECT * FROM publish_event WHERE status = $status;
        """
        result = await self.pool.execute_with_retries(
            sql,
            {
                "$status": (status, ydb.PrimitiveType.String)
            }
        )
        if not result or not result[0].rows:
            return []

        rows = result[0].rows
        return [PublishEvent(**row) for row in rows]  # TODO

    async def mark_as_published_by_publication_ids(self, publication_ids: List[UUID]):
        pass