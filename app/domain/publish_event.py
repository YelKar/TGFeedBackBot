from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID


@dataclass
class PublishEvent:
    event_id: UUID
    publication_id: UUID
    publish_at: datetime | None
    type: Literal["auto", "scheduled", "manual"]
    status: Literal["planned", "published", "cancelled"]
    created_at: datetime
