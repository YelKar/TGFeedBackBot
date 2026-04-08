import os

import ydb

from logger import logger

_driver = None
_pool = None


def create_connection():
    global _driver, _pool
    if _driver is None:
        logger.info("Connecting to YDB...")
        endpoint = os.getenv("YDB_ENDPOINT")
        database = os.getenv("YDB_DATABASE")
        creds = ydb.credentials_from_env_variables()
        _driver = ydb.Driver(ydb.DriverConfig(endpoint, database, credentials=creds))
        _driver.wait(timeout=5)
        _pool = ydb.SessionPool(_driver)
    return _pool


class Database:
    def __init__(self):
        self.pool = create_connection()

    def _execute(self, query, params=None):
        def callee(session):
            prepared = session.prepare(query)
            return session.transaction().execute(prepared, params or {}, commit_tx=True)

        return self.pool.retry_operation_sync(callee)

    def create_post(self, post_id, user_id, username, text):
        query = """
        DECLARE $id AS Utf8; 
        DECLARE $uid AS Int64; 
        DECLARE $un AS Utf8; 
        DECLARE $txt AS Utf8;
        UPSERT INTO post (id, user_id, username, text, status, created_at)
        VALUES ($id, $uid, $un, $txt, 'pending', CurrentUtcTimestamp());
        """
        self._execute(query, {"$id": post_id, "$uid": user_id, "$un": username or "unknown", "$txt": text})

    def update_post_admin_msg(self, post_id, msg_id):
        query = """
        DECLARE $id AS Utf8;
        DECLARE $m_id AS Int64;
        UPDATE post SET admin_msg_id = $m_id WHERE id = $id;
        """
        self._execute(query, {"$id": post_id, "$m_id": msg_id})

    def update_post_status(self, post_id, status, publish_at=None):
        if publish_at is None:

            query = """
            DECLARE $id AS Utf8;
            DECLARE $status AS Utf8;
            UPDATE post SET status = $status WHERE id = $id;
            """
            params = {"$id": post_id, "$status": status}
        else:

            query = """
            DECLARE $id AS Utf8;
            DECLARE $status AS Utf8;
            DECLARE $p_at AS Timestamp;
            UPDATE post SET status = $status, publish_at = $p_at WHERE id = $id;
            """
            params = {"$id": post_id, "$status": status, "$p_at": publish_at}

        self._execute(query, params)

    def add_vote(self, post_id, admin_id, admin_username, val):
        query = """
        DECLARE $pid AS Utf8; 
        DECLARE $aid AS Int64; 
        DECLARE $aun AS Utf8; 
        DECLARE $v AS Int32;
        UPSERT INTO vote (post_id, admin_id, admin_username, vote)
        VALUES ($pid, $aid, $aun, $v);
        """
        self._execute(query, {"$pid": post_id, "$aid": admin_id, "$aun": admin_username, "$v": val})

    def get_post_votes(self, post_id):
        query = """
        DECLARE $pid AS Utf8;
        SELECT vote FROM vote WHERE post_id = $pid;
        """
        res = self._execute(query, {"$pid": post_id})
        return res[0].rows

    def is_blocked(self, user_id):
        query = """
        DECLARE $id AS Int64;
        SELECT id FROM blocked_user WHERE id = $id;
        """
        res = self._execute(query, {"$id": user_id})
        return len(res[0].rows) > 0

    def get_latest_publish_time(self):
        query = """
                SELECT publish_at \
                FROM post
                WHERE status IN ('scheduled', 'published')
                ORDER BY publish_at DESC LIMIT 1; \
                """
        res = self._execute(query)
        if res[0].rows:
            return res[0].rows[0].publish_at
        return None

    def get_posts_to_publish(self, now_timestamp):
        query = """
        DECLARE $now AS Timestamp;
        SELECT id, text, user_id FROM post 
        WHERE status = 'scheduled' AND publish_at <= $now;
        """
        res = self._execute(query, {"$now": now_timestamp})
        return res[0].rows
