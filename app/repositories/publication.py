import uuid
from typing import Optional, List
import ydb
from app.domain.publication import Publication


class PublicationRepository:
    def __init__(self, pool: ydb.aio.QuerySessionPool):
        self.pool = pool

    async def add(self, pub: Publication):
        sql = """
        UPSERT INTO publication
        (publication_id, created_by, content, status, created_at, approved_at)
        VALUES
        ($id, $user, $content, $status, $created, $approved);
        """
        await self.pool.execute_with_retries(
            sql,
            {
                "$id": (pub.publication_id, ydb.PrimitiveType.UUID),
                "$user": (pub.created_by, ydb.PrimitiveType.Int64),
                "$content": pub.content,
                "$status": pub.status,
                "$created": (int(pub.created_at.timestamp()), ydb.PrimitiveType.Datetime),
                "$approved": (int(pub.approved_at.timestamp()) if pub.approved_at else None, ydb.OptionalType(ydb.PrimitiveType.Datetime))
            },
        )

    async def get(self, publication_id: uuid.UUID) -> Optional[Publication]:
        sql = "SELECT * FROM publication WHERE publication_id = $id;"
        result = await self.pool.execute_with_retries(sql, {"$id": (publication_id, ydb.PrimitiveType.UUID)})
        rows = result[0].rows
        if not rows:
            return None
        row = rows[0]
        return Publication(
            publication_id=row.publication_id,
            created_by=row.created_by,
            content=row.content,
            status=row.status,
            created_at=row.created_at,
            approved_at=row.approved_at,
        )

    async def update(self, pub: Publication):
        sql = """
        UPDATE publication
        SET
            content = $content,
            status = $status,
            approved_at = $approved
        WHERE publication_id = $id;
        """
        await self.pool.execute_with_retries(
            sql,
            {
                "$id": (pub.publication_id, ydb.PrimitiveType.UUID),
                "$content": pub.content,
                "$status": pub.status,
                "$approved": (int(pub.approved_at.timestamp()) if pub.approved_at else None, ydb.OptionalType(ydb.PrimitiveType.Datetime))
            },
        )

    async def get_by_status(self, status: str) -> List[Publication]:
        pass

    async def get_all(self) -> list[Publication]:
        sql = "SELECT * FROM publication;"
        result = await self.pool.execute_with_retries(sql)
        rows = result[0].rows
        return [Publication(**row) for row in rows]

    async def get_by_ids(self, ids: list[uuid.UUID]) -> List[Publication]:
        pass

    async def archive_by_ids(self, ids: list[uuid.UUID]):
        sql = """
              UPDATE
                  publication
              SET 
                  status = 'archived' 
              WHERE 
                  publication_id IN ($ids);
              """
        await self.pool.execute_with_retries(sql, {"$ids": (ids, ydb.ListType(ydb.PrimitiveType.UUID))})