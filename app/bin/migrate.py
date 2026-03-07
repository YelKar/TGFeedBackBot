import os
import sys
import asyncio
import logging
from pathlib import Path
import ydb

from app.infra.ydb_conf import get_credentials

# ======================
# Конфиг логгера
# ======================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

MIGRATIONS_DIR = Path("migrations")
YDB_DATABASE = os.environ.get("YDB_DATABASE")
YDB_ENDPOINT = os.environ.get("YDB_ENDPOINT")


def parse_migrations():
    migrations = {}
    for file in MIGRATIONS_DIR.glob("*.sql"):
        name = file.stem
        version, direction = name.split(".", 1)
        migrations.setdefault(version, {})[direction] = file
    return migrations


async def set_table_path(pool, path: str | None):
    if not path:
        return
    if not path.startswith("/"):
        raise ValueError("YDB table path must start with '/'")
    full_path = YDB_DATABASE + path
    logger.info(f"Setting table path to {full_path}")
    await pool.execute_with_retries(f'PRAGMA TablePathPrefix = "{full_path}";')


async def get_applied(pool):
    logger.info("Checking applied migrations")
    await pool.execute_with_retries(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version Utf8,
            applied_at Timestamp,
            PRIMARY KEY (version)
        );
        """
    )

    result = await pool.execute_with_retries(
        "SELECT version FROM schema_migrations;"
    )
    applied = {row.version for row in result[0].rows}
    logger.info(f"Already applied migrations: {sorted(applied)}")
    return applied


async def run_up(pool, target=None):
    applied = await get_applied(pool)
    migrations = parse_migrations()

    for version in sorted(migrations):
        if target and version > target:
            break
        if version in applied:
            logger.info(f"Skipping already applied migration {version}")
            continue

        sql = migrations[version]["up"].read_text()
        logger.info(f"Applying migration ↑ {version}")
        await pool.execute_with_retries(sql)
        logger.info(f"Migration ↑ {version} applied successfully")

        await pool.execute_with_retries(
            """
            UPSERT INTO schema_migrations (version, applied_at)
            VALUES ($v, CurrentUtcTimestamp());
            """,
            {"$v": version},
        )


async def run_down(pool, target=None):
    applied = sorted(await get_applied(pool), reverse=True)
    migrations = parse_migrations()

    for version in applied:
        if target and version <= target:
            break

        sql = migrations[version]["down"].read_text()
        logger.info(f"Reverting migration ↓ {version}")
        await pool.execute_with_retries(sql)
        logger.info(f"Migration ↓ {version} reverted successfully")

        await pool.execute_with_retries(
            "DELETE FROM schema_migrations WHERE version = $v;",
            {"$v": version},
        )


async def apply_one(pool, version: str):
    migrations = parse_migrations()

    if version not in migrations or "up" not in migrations[version]:
        raise ValueError(f"Migration {version}.up.sql not found")

    sql = migrations[version]["up"].read_text()
    logger.info(f"Applying ONLY migration ↑ {version}")
    await pool.execute_with_retries(sql)
    logger.info(f"Migration ↑ {version} applied successfully")

    await pool.execute_with_retries(
        """
        UPSERT INTO schema_migrations (version, applied_at)
        VALUES ($v, CurrentUtcTimestamp());
        """,
        {"$v": version},
    )


async def revert_one(pool, version: str):
    migrations = parse_migrations()

    if version not in migrations or "down" not in migrations[version]:
        raise ValueError(f"Migration {version}.down.sql not found")

    sql = migrations[version]["down"].read_text()
    logger.info(f"Reverting ONLY migration ↓ {version}")
    await pool.execute_with_retries(sql)
    logger.info(f"Migration ↓ {version} reverted successfully")

    await pool.execute_with_retries(
        "DELETE FROM schema_migrations WHERE version = $v;",
        {"$v": version},
    )


async def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "up"
    version = sys.argv[2] if len(sys.argv) > 2 else None
    table_path = sys.argv[3] if len(sys.argv) > 3 else None

    logger.info(f"Connecting to YDB at {YDB_ENDPOINT} / {YDB_DATABASE}")

    driver = ydb.aio.Driver(
        endpoint=YDB_ENDPOINT,
        database=YDB_DATABASE,
        credentials=get_credentials(),
        root_certificates=ydb.load_ydb_root_certificate(),
    )

    await driver.wait(timeout=5, fail_fast=True)
    logger.info("Connected to YDB successfully")

    async with ydb.aio.QuerySessionPool(driver) as pool:
        await set_table_path(pool, table_path)

        if cmd == "up":
            await run_up(pool, version)
        elif cmd == "down":
            await run_down(pool, version)
        elif cmd == "apply":
            if not version:
                raise ValueError("apply requires migration version")
            await apply_one(pool, version)
        elif cmd == "revert":
            if not version:
                raise ValueError("revert requires migration version")
            await revert_one(pool, version)
        else:
            raise ValueError("use up | down | apply | revert")

    await driver.stop()
    logger.info("Driver stopped. Migration finished.")


if __name__ == "__main__":
    asyncio.run(main())
