class QuotesRepository:
    def __init__(self, pool):
        self.pool = pool

    async def add(self, quote):
        await self.pool.execute_with_retries(
            """
            UPSERT INTO quotes
            (quote_id, user_id, text, author, status, created_at)
            VALUES
            ($id, $user, $text, $author, $status, $created);
            """,
            {
                "$id": quote.quote_id,
                "$user": quote.user_id,
                "$text": quote.text,
                "$author": quote.author,
                "$status": quote.status,
                "$created": quote.created_at,
            },
        )

    async def get_ready(self, limit):
        result = await self.pool.execute_with_retries(
            """
            SELECT * FROM quotes
            WHERE status = "ready"
            LIMIT $limit;
            """,
            {"$limit": limit},
        )
        return result[0].rows
