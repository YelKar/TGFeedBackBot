import asyncio
import os
import ydb
from ydb.convert import ResultSet


def get_credentials():
    token = (
        os.getenv("YDB_ACCESS_TOKEN")
        or os.getenv("IAM_TOKEN")
        or os.getenv("YC_TOKEN")
    )

    if token:
        return ydb.AccessTokenCredentials(token)

    return ydb.MetadataCredentials()

class Ydb:
    def __init__(self, endpoint, database):
        self._endpoint = endpoint
        self._database = database
        self._driver = None
        self._pool = None

    async def connect(self):
        if self._driver:
            return

        self._driver = ydb.aio.Driver(
            endpoint=self._endpoint,
            database=self._database,
            credentials=get_credentials(),
            root_certificates=ydb.load_ydb_root_certificate(),
        )

        await self._driver.wait(timeout=5, fail_fast=True)
        self._pool = ydb.aio.QuerySessionPool(self._driver)

    async def execute(self, query, params=None):
        return await self._pool.execute_with_retries(query, params)

    async def close(self):
        if self._pool:
            await self._pool.stop()
        if self._driver:
            await self._driver.stop()

async def main():
    ydb = Ydb(os.getenv("YDB_ENDPOINT"), os.getenv("YDB_DATABASE"))
    await ydb.connect()

    res: list[ResultSet] = await ydb.execute(
        "SELECT * FROM quotes;"
    )

    print(res[0].rows)

if __name__ == "__main__":
    asyncio.run(main())
