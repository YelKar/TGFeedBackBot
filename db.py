import json
import os
import ydb
from logger import logger

_driver = None
_pool = None


def create_connection():
    global _driver, _pool

    # Если драйвер есть, но он перестал отвечать (флаг устанавливается в _execute)
    if _driver is not None:
        try:
            # Быстрая проверка связи (за 1 секунду)
            _driver.wait(timeout=1)
        except:
            logger.error("YDB Driver is stale, recreating...")
            _driver.stop()
            _driver = None
            _pool = None

    if _driver is None:
        logger.info("Connecting to YDB (New Driver Instance)...")
        endpoint = os.getenv("YDB_ENDPOINT")
        database = os.getenv("YDB_DATABASE")
        creds = ydb.credentials_from_env_variables()

        # Стандартный конфиг без лишних аргументов
        driver_config = ydb.DriverConfig(
            endpoint,
            database,
            credentials=creds
        )

        _driver = ydb.Driver(driver_config)

        try:
            # Ждем подключения не более 5 секунд
            _driver.wait(timeout=5)
            # Создаем пул сессий
            _pool = ydb.SessionPool(_driver, size=10)
            logger.info("YDB Connected successfully")
        except Exception as e:
            _driver = None
            logger.error(f"YDB Connection failed: {e}")
            raise

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
            # КЛЮЧЕВАЯ ОПТИМИЗАЦИЯ: Таймауты на уровне запроса
            # .with_timeout(5) - общее время ожидания (gRPC Deadline)
            # .with_operation_timeout(4) - таймаут на стороне сервера YDB
            settings = ydb.BaseRequestSettings() \
                .with_timeout(5) \
                .with_operation_timeout(4)

            prepared = session.prepare(query)
            return session.transaction().execute(
                prepared,
                params or {},
                commit_tx=True,
                settings=settings
            )

        try:
            return self.pool.retry_operation_sync(callee)
        except Exception as e:
            # Если поймали любую сетевую ошибку (Unavailable, Aborted, TransportError)
            # Сбрасываем глобальный драйвер, чтобы следующий вызов функции пересоздал его
            error_str = str(e).lower()
            if any(x in error_str for x in ["transport", "unavailable", "deadline", "expired"]):
                global _driver
                _driver = None
                logger.error(f"YDB Critical Error: {e}. Driver has been reset.")
            raise

    # ... все остальные методы (get_filtered_posts, create_post и т.д.) без изменений

    def get_filtered_posts(self, user_id=None, status=None, limit=10, last_ts=None):
        """
        Универсальный метод получения постов с пагинацией.
        Если user_id — фильтр по автору (для юзера).
        Если status — фильтр по вкладке (для админа).
        """
        limit = int(limit)
        params = {"$limit": limit}

        # Базовая часть запроса
        where_clauses = []
        if user_id:
            where_clauses.append("user_id = $uid")
            params["$uid"] = int(user_id)
        if status:
            where_clauses.append("status = $s")
            params["$s"] = status
        if last_ts:
            where_clauses.append("created_at < $last")
            params["$last"] = int(float(last_ts) * 1000000)

        where_str = " WHERE " + " AND ".join(where_clauses) if where_clauses else ""

        # Обязательно объявляем DECLARE для всех используемых параметров
        declares = ["DECLARE $limit AS Uint32;"]
        if user_id: declares.append("DECLARE $uid AS Int64;")
        if status: declares.append("DECLARE $s AS Utf8;")
        if last_ts: declares.append("DECLARE $last AS Timestamp;")

        query = f"{' '.join(declares)} SELECT * FROM {self.t_post} {where_str} ORDER BY created_at DESC LIMIT $limit;"
        res = self._execute(query, params)
        return res[0].rows

    def create_post(self, post_id, user_id, username, text):
        query = f"DECLARE $id AS Utf8; DECLARE $uid AS Int64; DECLARE $un AS Utf8; DECLARE $txt AS Utf8; UPSERT INTO {self.t_post} (id, user_id, username, text, status, created_at) VALUES ($id, $uid, $un, $txt, 'pending', CurrentUtcTimestamp());"
        self._execute(query, {"$id": post_id, "$uid": user_id, "$un": username or "unknown", "$txt": text})

    def update_post_admin_msg(self, post_id, msg_id):
        query = f"DECLARE $id AS Utf8; DECLARE $m_id AS Int64; UPDATE {self.t_post} SET admin_msg_id = $m_id WHERE id = $id;"
        self._execute(query, {"$id": post_id, "$m_id": msg_id})

    def update_post_status(self, post_id, status, publish_at=None):
        if publish_at is None:
            query = f"DECLARE $id AS Utf8; DECLARE $status AS Utf8; UPDATE {self.t_post} SET status = $status WHERE id = $id;"
            params = {"$id": post_id, "$status": status}
        else:
            query = f"DECLARE $id AS Utf8; DECLARE $status AS Utf8; DECLARE $p_at AS Timestamp; UPDATE {self.t_post} SET status = $status, publish_at = $p_at WHERE id = $id;"
            params = {"$id": post_id, "$status": status, "$p_at": publish_at}
        self._execute(query, params)

    def add_vote(self, post_id, admin_id, admin_username, val):
        query = f"DECLARE $pid AS Utf8; DECLARE $aid AS Int64; DECLARE $aun AS Utf8; DECLARE $v AS Int32; UPSERT INTO {self.t_vote} (post_id, admin_id, admin_username, vote) VALUES ($pid, $aid, $aun, $v);"
        self._execute(query, {"$pid": post_id, "$aid": admin_id, "$aun": admin_username, "$v": val})

    def get_post_votes(self, post_id):
        query = f"DECLARE $pid AS Utf8; SELECT admin_username, vote FROM {self.t_vote} WHERE post_id = $pid;"
        res = self._execute(query, {"$pid": post_id})
        return res[0].rows

    def is_blocked(self, user_id):
        query = f"DECLARE $id AS Int64; SELECT id FROM {self.t_blocked} WHERE id = $id;"
        res = self._execute(query, {"$id": user_id})
        return len(res[0].rows) > 0

    def block_user(self, user_id):
        query = f"DECLARE $id AS Int64; UPSERT INTO {self.t_blocked} (id) VALUES ($id);"
        self._execute(query, {"$id": user_id})

    def get_latest_published_time(self):
        query = f"SELECT publish_at FROM {self.t_post} WHERE status = 'published' ORDER BY publish_at DESC LIMIT 1;"
        res = self._execute(query)
        return res[0].rows[0].publish_at if res[0].rows else None

    def get_scheduled_queue(self):
        query = f"SELECT id, admin_msg_id, created_at, publish_at FROM {self.t_post} WHERE status = 'scheduled' ORDER BY created_at ASC;"
        res = self._execute(query)
        return res[0].rows

    def get_posts_to_publish(self, now_us):
        query = f"DECLARE $now AS Timestamp; SELECT id, text, user_id, admin_msg_id FROM {self.t_post} WHERE status = 'scheduled' AND publish_at <= $now;"
        res = self._execute(query, {"$now": now_us})
        return res[0].rows

    def get_config(self, key):
        query = f"DECLARE $key AS Utf8; SELECT value FROM {self.t_config} WHERE key = $key;"
        res = self._execute(query, {"$key": key})
        return json.loads(res[0].rows[0].value) if res[0].rows else None

    def get_post(self, post_id):
        query = f"DECLARE $id AS Utf8; SELECT * FROM {self.t_post} WHERE id = $id;"
        res = self._execute(query, {"$id": post_id})
        return res[0].rows[0] if res[0].rows else None

    def get_post_by_admin_msg(self, admin_msg_id):
        query = f"DECLARE $m_id AS Int64; SELECT * FROM {self.t_post} WHERE admin_msg_id = $m_id LIMIT 1;"
        res = self._execute(query, {"$m_id": admin_msg_id})
        return res[0].rows[0] if res[0].rows else None

    def update_post_text(self, post_id, new_text):
        query = f"DECLARE $id AS Utf8; DECLARE $txt AS Utf8; UPDATE {self.t_post} SET text = $txt WHERE id = $id;"
        self._execute(query, {"$id": post_id, "$txt": new_text})

    def add_dialogue(self, u_msg_id, a_msg_id, p_id):
        query = f"DECLARE $u AS Int64; DECLARE $a AS Int64; DECLARE $p AS Utf8; UPSERT INTO {self.t_dialogue} (user_msg_id, admin_msg_id, post_id) VALUES ($u, $a, $p);"
        self._execute(query, {"$u": u_msg_id, "$a": a_msg_id, "$p": p_id})

    def get_dialogue(self, u_msg_id):
        query = f"DECLARE $u AS Int64; SELECT admin_msg_id, post_id FROM {self.t_dialogue} WHERE user_msg_id = $u;"
        res = self._execute(query, {"$u": u_msg_id})
        return res[0].rows[0] if res[0].rows else None