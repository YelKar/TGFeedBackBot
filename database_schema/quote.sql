CREATE TABLE quotes (
    quote_id Uuid,
    text Utf8,
    author Utf8,
    submitted_by Int64,
    status Utf8,
    created_at Timestamp,
    approved_at Timestamp,

    PRIMARY KEY (quote_id)
);
