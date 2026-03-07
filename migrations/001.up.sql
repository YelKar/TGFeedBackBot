CREATE TABLE publication (
    publication_id UUID,
    created_by Int64 NOT NULL,
    content Utf8 NOT NULL,
    status String NOT NULL,
    created_at Datetime NOT NULL,
    approved_at Datetime,
    approved_by Int64,
    PRIMARY KEY (publication_id)
);

CREATE TABLE publish_event (
    event_id UUID,
    publication_id UUID NOT NULL,
    planned_publish_at Datetime NOT NULL,
    actual_publish_at Datetime,
    type String NOT NULL,
    status String NOT NULL,
    created_at Datetime NOT NULL,
    PRIMARY KEY (event_id)
);

CREATE TABLE schedule_rule (
    rule_id UUID,
    daily_limit Int32 NOT NULL,
    earliest_publish_time Uint32 NOT NULL,
    latest_publish_time Uint32 NOT NULL,
    pre_cooldown_minutes Int32,
    post_cooldown_minutes Int32,
    auto_enabled Bool NOT NULL,
    created_at Datetime NOT NULL,
    PRIMARY KEY (rule_id)
);


CREATE TABLE schedule_rule_preferred_time (
    rule_id UUID,
    time_seconds Uint32 NOT NULL,
    PRIMARY KEY (rule_id, time_seconds)
);
