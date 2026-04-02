import os
import ydb
from logger import logger

def create_connection() -> ydb.Driver:
    logger.info("Connecting to YDB...")
    endpoint = os.getenv("YDB_ENDPOINT")
    database = os.getenv("YDB_DATABASE")

    credentials = ydb.credentials_from_env_variables()
    driver_config = ydb.DriverConfig(
        endpoint,
        database,
        credentials=credentials
    )

    driver = ydb.Driver(driver_config)

    try:
        driver.wait(timeout=5)
        return driver
    except TimeoutError:
        print("Ошибка: Не удалось подключиться к YDB. Проверьте VPN или Endpoint.")
        raise


class Blocker:
    def __init__(self, driver: ydb.Driver):  # TODO сделать с учётом тёплого запуска
        self.session_pool = ydb.SessionPool(driver)

    def block(self, user_id: int) -> None:
        def callee(session):
            query = """
            DECLARE $id AS Int64;
            UPSERT INTO blocked_id (id)
            VALUES ($id);
            """
            prepared = session.prepare(query)
            session.transaction().execute(
                prepared,
                {"$id": user_id},
                commit_tx=True
            )

        self.session_pool.retry_operation_sync(callee)

    def is_blocked(self, user_id: int) -> bool:
        def callee(session):
            query = """
            DECLARE $id AS Int64;
            SELECT id
            FROM blocked_id
            WHERE id = $id;
            """
            prepared = session.prepare(query)
            result = session.transaction().execute(
                prepared,
                {"$id": user_id},
                commit_tx=True
            )
            print("CHECK:", user_id.__repr__(), "BLOCKED:", result[0].rows)
            return len(result[0].rows) > 0

        return self.session_pool.retry_operation_sync(callee)