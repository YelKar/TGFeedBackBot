from typing import Generic, TypeVar, Type

import ydb


T = TypeVar("T")

class RepoFactory(Generic[T]):
    def __init__(self, repo_class: Type[T]):
        self.repo_class = repo_class

    def __call__(self, pool: ydb.aio.QuerySessionPool) -> T:
        return self.repo_class(pool)