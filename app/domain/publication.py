from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID

@dataclass
class Publication:
    publication_id: UUID
    created_by: int
    content: str
    status: Literal[
        "pending",
        "rejected",
        "approved",
        "archived",
    ]
    created_at: datetime
    approved_at: datetime | None = None
    approved_by: int | None = None
    rejected_at: datetime | None = None
    rejected_by: int | None = None
