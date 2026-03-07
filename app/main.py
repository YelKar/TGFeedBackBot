import datetime
import uuid

from app.infra.ydb_conf import get_credentials
import os
import ydb
import asyncio

from app.repositories.publication import PublicationRepository

# YDB_DATABASE = os.environ.get("YDB_DATABASE")
# YDB_ENDPOINT = os.environ.get("YDB_ENDPOINT")
#
# async def main():
#
#
#     driver = ydb.aio.Driver(
#         endpoint=YDB_ENDPOINT,
#         database=YDB_DATABASE,
#         credentials=get_credentials(),
#         root_certificates=ydb.load_ydb_root_certificate(),
#     )
#
#     await driver.wait(timeout=5, fail_fast=True)
#
#     async with ydb.aio.QuerySessionPool(driver) as pool:
#         repo = PublicationRepository(pool)
#         # await repo.add(
#         #     Publication(
#         #         uuid.uuid4(),
#         #         132,
#         #         "Test publication",
#         #         "pending",
#         #         datetime.datetime.now(),
#         #         None
#         #     )
#         # )
#         pub = await repo.get(uuid.UUID('6e74fcaa-d133-4be8-8955-96c700422847'))
#         print(pub)
#         pub.status = "approved"
#         pub.approved_at = datetime.datetime.now()
#         await repo.update(pub)
#
# if __name__ == "__main__":
#     asyncio.run(main())

from app.bot import start_bot
from app.logs import setup_logger
import asyncio

async def main():
    setup_logger()
    await start_bot()

if __name__ == "__main__":
    asyncio.run(main())