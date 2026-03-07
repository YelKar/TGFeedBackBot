from dataclasses import dataclass
from datetime import time, datetime


@dataclass
class ScheduleRulePreferredTime:
    rule_id: str
    time_seconds: int

@dataclass
class ScheduleRule:
    rule_id: str
    daily_limit: int
    earliest_publish_time: time
    latest_publish_time: time
    pre_cooldown_seconds: int
    post_cooldown_seconds: int
    auto_enabled: bool
    created_at: datetime
    preferred_times: list[ScheduleRulePreferredTime]

