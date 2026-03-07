import os
import ydb


def get_credentials():
    token = (
        os.getenv("YDB_ACCESS_TOKEN")
        or os.getenv("IAM_TOKEN")
        or os.getenv("YC_TOKEN")
    )

    if token:
        return ydb.AccessTokenCredentials(token)

    return ydb.MetadataCredentials()

def create_driver() -> ydb.aio.Driver:
    return ydb.aio.Driver(
        endpoint=os.environ["YDB_ENDPOINT"],
        database=os.environ["YDB_DATABASE"],
        credentials=get_credentials(),
        root_certificates=ydb.load_ydb_root_certificate(),
    )
