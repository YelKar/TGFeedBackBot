from datetime import datetime
from uuid import UUID, uuid4
from typing import Optional, List

import ydb.aio

from app.domain.publication import Publication
from app.domain.publish_event import PublishEvent
from app.domain.schedule import ScheduleRule
from app.repositories.factory import RepoFactory
from app.repositories.publication import PublicationRepository
from app.repositories.publish_event import PublishEventRepository


class Scheduler:
    def __init__(
            self,
            driver: ydb.aio.Driver,
            publish_event_repo_factory: RepoFactory[PublishEventRepository],
            publication_repo_factory: RepoFactory[PublicationRepository]
    ):
        self.driver = driver
        self.publish_event_repo_factory = publish_event_repo_factory
        self.publication_repo_factory = publication_repo_factory

    async def schedule(self, publication_id: UUID, at: datetime):
        async with ydb.aio.QuerySessionPool(self.driver) as pool:
            publish_event_repo = self.publish_event_repo_factory(pool)
            await publish_event_repo.add(PublishEvent(
                uuid4(),
                publication_id,
                at,
                "scheduled",
                "planned",
                datetime.now()
            ))

    async def add_to_queue(self, publication_id: UUID):
        async with ydb.aio.QuerySessionPool(self.driver) as pool:
            publish_event_repo = self.publish_event_repo_factory(pool)
            await publish_event_repo.add(PublishEvent(
                uuid4(),
                publication_id,
                None,
                "auto",
                "planned",
                datetime.now()
            ))

    async def publish_manually(self, publication_id: UUID):
        async with ydb.aio.QuerySessionPool(self.driver) as pool:
            publish_event_repo = self.publish_event_repo_factory(pool)
            await publish_event_repo.add(PublishEvent(
                uuid4(),
                publication_id,
                None,
                "manual",
                "planned",
                datetime.now()
            ))

    async def get_publications_to_publish(self) -> List[Publication]:
        async with ydb.aio.QuerySessionPool(self.driver) as pool:
            publish_event_repo = self.publish_event_repo_factory(pool)
            schedule_rule: ScheduleRule = ...  # TODO
            now = datetime.now()
            today_events = await publish_event_repo.get_day(now.date())
            if len(today_events) >= schedule_rule.daily_limit:
                return []

            publication_repo = self.publication_repo_factory(pool)
            def filter_events(event: PublishEvent) -> bool:
                if event.status == "published":
                    return False
                return event.type == "manual" \
                    or event.type == "scheduled" and event.publish_at <= now

            events_to_publish = list(filter(filter_events, today_events))
            if not events_to_publish:
                time_seconds = datetime.now().timestamp() - datetime(now.year, now.month, now.day).timestamp()
                wanted_current_amount_of_publications = len(list(filter(lambda x: x.time_seconds <= time_seconds, schedule_rule.preferred_times)))
                published: List[datetime] = list(map(lambda x: x.publish_at, filter(lambda x: x.status == "published", today_events)))
                if len(published) >= wanted_current_amount_of_publications:
                    return []

                unpublished: List[datetime] = list(map(lambda x: x.publish_at, filter(lambda x: x.status == "unpublished", today_events)))

                earliest_unpublished = min(unpublished) if unpublished else None
                latest_published = max(published) if published else None

                if not (
                    (earliest_unpublished is None or earliest_unpublished.timestamp() - schedule_rule.pre_cooldown_seconds > now.timestamp()) \
                    and (latest_published is None or latest_published.timestamp() + schedule_rule.post_cooldown_seconds < now.timestamp())
                ):
                    return []

                auto_publish_event = await publish_event_repo.get_next_auto_publish_event()
                if not auto_publish_event:
                    return []

                events_to_publish = [auto_publish_event]

            return await publication_repo.get_by_ids(list(map(lambda e: e.publication_id, events_to_publish)))

    async def publish(self, publication_ids: List[UUID]):
        async with ydb.aio.QuerySessionPool(self.driver) as pool:
            publish_event_repo = self.publish_event_repo_factory(pool)
            publication_repo = self.publication_repo_factory(pool)
            await publish_event_repo.mark_as_published_by_publication_ids(publication_ids)
            await publication_repo.archive_by_ids(publication_ids)
