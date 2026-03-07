import ydb

class ScheduleRulesRepository:
    def __init__(self, pool: ydb.aio.QuerySessionPool):
        self.pool = pool

