import json
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
        _driver.wait(timeout=10)
        _pool = ydb.SessionPool(_driver)
    return _pool


class Database:
    def __init__(self):
        self.pool = create_connection()

        path_prefix = os.getenv("DB_PATH", "dev")
        if path_prefix and not path_prefix.endswith("/"):
            path_prefix += "/"

        self.t_post = f"`{path_prefix}post`"
        self.t_vote = f"`{path_prefix}vote`"
        self.t_config = f"`{path_prefix}config`"
        self.t_blocked = f"`{path_prefix}blocked_user`"
        self.t_dialogue = f"`{path_prefix}dialogue`"

    def _execute(self, query, params=None):
        def callee(session):
            prepared = session.prepare(query)
            return session.transaction().execute(prepared, params or {}, commit_tx=True)

        return self.pool.retry_operation_sync(callee)

    def create_post(self, post_id, user_id, username, text):
        query = f"""
        DECLARE $id AS Utf8; 
        DECLARE $uid AS Int64; 
        DECLARE $un AS Utf8; 
        DECLARE $txt AS Utf8;
        UPSERT INTO {self.t_post} (id, user_id, username, text, status, created_at)
        VALUES ($id, $uid, $un, $txt, 'pending', CurrentUtcTimestamp());
        """
        self._execute(query, {"$id": post_id, "$uid": user_id, "$un": username or "unknown", "$txt": text})

    def update_post_admin_msg(self, post_id, msg_id):
        query = f"""
        DECLARE $id AS Utf8;
        DECLARE $m_id AS Int64;
        UPDATE {self.t_post} SET admin_msg_id = $m_id WHERE id = $id;
        """
        self._execute(query, {"$id": post_id, "$m_id": msg_id})

    def update_post_status(self, post_id, status, publish_at=None):
        if publish_at is None:
            query = f"""
            DECLARE $id AS Utf8;
            DECLARE $status AS Utf8;
            UPDATE {self.t_post} SET status = $status WHERE id = $id;
            """
            params = {"$id": post_id, "$status": status}
        else:
            query = f"""
            DECLARE $id AS Utf8;
            DECLARE $status AS Utf8;
            DECLARE $p_at AS Timestamp;
            UPDATE {self.t_post} SET status = $status, publish_at = $p_at WHERE id = $id;
            """
            params = {"$id": post_id, "$status": status, "$p_at": publish_at}

        self._execute(query, params)

    def add_vote(self, post_id, admin_id, admin_username, val):
        query = f"""
        DECLARE $pid AS Utf8; 
        DECLARE $aid AS Int64; 
        DECLARE $aun AS Utf8; 
        DECLARE $v AS Int32;
        UPSERT INTO {self.t_vote} (post_id, admin_id, admin_username, vote)
        VALUES ($pid, $aid, $aun, $v);
        """
        self._execute(query, {"$pid": post_id, "$aid": admin_id, "$aun": admin_username, "$v": val})

    def get_post_votes(self, post_id):
        query = f"""
        DECLARE $pid AS Utf8;
        SELECT admin_username, vote FROM {self.t_vote} WHERE post_id = $pid;
        """
        res = self._execute(query, {"$pid": post_id})
        return res[0].rows

    def is_blocked(self, user_id):
        query = f"""
        DECLARE $id AS Int64;
        SELECT id FROM {self.t_blocked} WHERE id = $id;
        """
        res = self._execute(query, {"$id": user_id})
        return len(res[0].rows) > 0

    def block_user(self, user_id):
        query = f"""
        DECLARE $id AS Int64;
        UPSERT INTO {self.t_blocked} (id)
        VALUES ($id);
        """
        self._execute(query, {"$id": user_id})

    def get_latest_publish_time(self):
        query = f"""
                SELECT publish_at 
                FROM {self.t_post}
                WHERE status IN ('scheduled', 'published')
                ORDER BY publish_at DESC LIMIT 1; 
                """
        res = self._execute(query)
        if res[0].rows:
            return res[0].rows[0].publish_at
        return None

    def get_latest_published_time(self):
        """Получить время последнего опубликованного поста (точка отсчета)"""
        query = f"""
                SELECT publish_at 
                FROM {self.t_post}
                WHERE status = 'published'
                ORDER BY publish_at DESC LIMIT 1; 
                """
        res = self._execute(query)
        return res[0].rows[0].publish_at if res[0].rows else None

    def get_scheduled_queue(self):
        """Получить всю очередь запланированных постов (ID и ID сообщений в админке)"""
        query = f"""
                SELECT id, admin_msg_id, created_at 
                FROM {self.t_post} 
                WHERE status = 'scheduled' 
                ORDER BY created_at ASC; 
                """
        res = self._execute(query)
        return res[0].rows

    def get_posts_to_publish(self, now_us):
        """Получить посты, которые пора отправить в канал (для таймера)"""
        query = f"""
        DECLARE $now AS Timestamp;
        SELECT id, text, user_id, admin_msg_id FROM {self.t_post} 
        WHERE status = 'scheduled' AND publish_at <= $now;
        """
        res = self._execute(query, {"$now": now_us})
        return res[0].rows

    def get_config(self, key):
        """Загрузить JSON-конфиг из базы"""
        query = f"DECLARE $key AS Utf8; SELECT value FROM {self.t_config} WHERE key = $key;"
        res = self._execute(query, {"$key": key})
        if res[0].rows:
            return json.loads(res[0].rows[0].value)
        return None

    def set_config(self, key, value_dict):
        """Сохранить конфиг в базу"""
        query = f"DECLARE $key AS Utf8; DECLARE $val AS Utf8; UPSERT INTO {self.t_config} (key, value) VALUES ($key, $val);"
        self._execute(query, {"$key": key, "$val": json.dumps(value_dict)})

    def get_post(self, post_id):
        """Получить один пост по ID"""
        query = f"""
        DECLARE $id AS Utf8;
        SELECT id, user_id, username, text, status, created_at, publish_at, admin_msg_id 
        FROM {self.t_post} WHERE id = $id;
        """
        res = self._execute(query, {"$id": post_id})
        return res[0].rows[0] if res[0].rows else None

    def get_post_by_admin_msg(self, admin_msg_id):
        """Найти пост по ID сообщения в чате модерации"""
        query = f"DECLARE $m_id AS Int64; SELECT * FROM {self.t_post} WHERE admin_msg_id = $m_id LIMIT 1;"
        res = self._execute(query, {"$m_id": admin_msg_id})
        return res[0].rows[0] if res[0].rows else None

    def update_post_text(self, post_id, new_text):
        """Обновить текст поста в базе (после команды /edit)"""
        query = f"DECLARE $id AS Utf8; DECLARE $txt AS Utf8; UPDATE {self.t_post} SET text = $txt WHERE id = $id;"
        self._execute(query, {"$id": post_id, "$txt": new_text})

    def add_dialogue(self, user_msg_id, admin_msg_id, post_id):
        query = f"""
        DECLARE $u_id AS Int64; DECLARE $a_id AS Int64; DECLARE $p_id AS Utf8;
        UPSERT INTO {self.t_dialogue} (user_msg_id, admin_msg_id, post_id) VALUES ($u_id, $a_id, $p_id);
        """
        self._execute(query, {"$u_id": user_msg_id, "$a_id": admin_msg_id, "$p_id": post_id})

    def get_dialogue(self, user_msg_id):
        query = f"DECLARE $u_id AS Int64; SELECT admin_msg_id, post_id FROM {self.t_dialogue} WHERE user_msg_id = $u_id;"
        res = self._execute(query, {"$u_id": user_msg_id})
        return res[0].rows[0] if res[0].rows else None
