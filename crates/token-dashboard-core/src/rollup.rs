//! Hourly usage rollup (`usage_hourly`).
//!
//! The overview, daily, project and model aggregates used to scan every row
//! of `messages` — about a million wide rows (prompt text, tool JSON) on a
//! long history, ~1.5s per query and several of them per refresh. This table
//! holds the same token sums pre-grouped by UTC hour, session, project,
//! model, type and provider (tens of thousands of slim rows).
//!
//! It is maintained by triggers on `messages`, so every write path — scanner
//! inserts, `INSERT OR REPLACE` re-ingests (needs `recursive_triggers`, set
//! in `db::tune`), snapshot eviction deletes — keeps it exact without any
//! scanner changes. Queries read it only when their bounds fall on an hour
//! boundary (see [`Source::for_range`]); anything finer falls back to
//! `messages`, so results never differ from the raw aggregate.

use rusqlite::Connection;

const COLS: [&str; 5] = [
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_create_5m_tokens",
    "cache_create_1h_tokens",
];

const TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS usage_hourly (
  hour                    TEXT    NOT NULL,  -- substr(timestamp, 1, 13), UTC
  session_id              TEXT    NOT NULL,
  project_slug            TEXT    NOT NULL,
  model                   TEXT    NOT NULL,  -- '' stands for NULL (PK can't hold NULL)
  type                    TEXT    NOT NULL,
  provider                TEXT    NOT NULL,
  n                       INTEGER NOT NULL,  -- message rows in the bucket
  input_tokens            INTEGER NOT NULL,
  output_tokens           INTEGER NOT NULL,
  cache_read_tokens       INTEGER NOT NULL,
  cache_create_5m_tokens  INTEGER NOT NULL,
  cache_create_1h_tokens  INTEGER NOT NULL,
  last_ts                 TEXT    NOT NULL,  -- MAX(timestamp) in the bucket
  first_ts                TEXT    NOT NULL,  -- MIN(timestamp) in the bucket
  PRIMARY KEY (hour, session_id, project_slug, model, type, provider)
) WITHOUT ROWID;
"#;

/// Bucket key of a `messages` row (`new` or `old`), in PK order.
fn key(r: &str) -> String {
    format!(
        "substr({r}.timestamp, 1, 13), {r}.session_id, {r}.project_slug, \
         IFNULL({r}.model, ''), {r}.type, {r}.provider"
    )
}

fn key_match(r: &str) -> String {
    format!(
        "hour = substr({r}.timestamp, 1, 13) AND session_id = {r}.session_id \
         AND project_slug = {r}.project_slug AND model = IFNULL({r}.model, '') \
         AND type = {r}.type AND provider = {r}.provider"
    )
}

/// Statements adding `new` into its bucket.
fn add(r: &str) -> String {
    let vals: Vec<String> = COLS.iter().map(|c| format!("{r}.{c}")).collect();
    let upd: Vec<String> = COLS
        .iter()
        .map(|c| format!("{c} = {c} + excluded.{c}"))
        .collect();
    format!(
        "INSERT INTO usage_hourly VALUES ({k}, 1, {vals}, {r}.timestamp, {r}.timestamp) \
         ON CONFLICT (hour, session_id, project_slug, model, type, provider) DO UPDATE SET \
         n = n + 1, {upd}, last_ts = MAX(last_ts, excluded.last_ts), \
         first_ts = MIN(first_ts, excluded.first_ts);",
        k = key(r),
        vals = vals.join(", "),
        upd = upd.join(", "),
    )
}

/// Statements removing `old` from its bucket. `last_ts` / `first_ts` are
/// recomputed from the bucket's remaining rows only when the removed row
/// held the max / min.
fn sub(r: &str) -> String {
    let upd: Vec<String> = COLS
        .iter()
        .map(|c| format!("{c} = {c} - {r}.{c}"))
        .collect();
    let m = key_match(r);
    format!(
        "UPDATE usage_hourly SET n = n - 1, {upd} WHERE {m};\
         DELETE FROM usage_hourly WHERE {m} AND n <= 0;\
         {last}{first}",
        upd = upd.join(", "),
        last = recompute(r, "last_ts", "MAX"),
        first = recompute(r, "first_ts", "MIN"),
    )
}

fn recompute(r: &str, col: &str, agg: &str) -> String {
    format!(
        "UPDATE usage_hourly SET {col} = (\
           SELECT {agg}(timestamp) FROM messages \
           WHERE session_id = {r}.session_id AND type = {r}.type \
             AND substr(timestamp, 1, 13) = substr({r}.timestamp, 1, 13) \
             AND project_slug = {r}.project_slug AND IFNULL(model, '') = IFNULL({r}.model, '') \
             AND provider = {r}.provider) \
         WHERE {m} AND {col} = {r}.timestamp;",
        m = key_match(r),
    )
}

fn triggers() -> String {
    format!(
        "CREATE TRIGGER IF NOT EXISTS usage_hourly_ai AFTER INSERT ON messages BEGIN {ins} END;\
         CREATE TRIGGER IF NOT EXISTS usage_hourly_ad AFTER DELETE ON messages BEGIN {del} END;\
         CREATE TRIGGER IF NOT EXISTS usage_hourly_au AFTER UPDATE ON messages BEGIN {del} {ins} END;",
        ins = add("new"),
        del = sub("old"),
    )
}

/// The rollup as found at startup can be trusted: current schema, and one
/// rollup row-count per message. Anything else means a writer bypassed the
/// triggers — an older app version (no `recursive_triggers`, so its
/// re-ingests double count), a DB restored from before the rollup, or a
/// table from an earlier schema. ~40ms on a 1M-message DB.
fn healthy(conn: &Connection) -> rusqlite::Result<bool> {
    let has_first_ts: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('usage_hourly') WHERE name = 'first_ts')",
        [],
        |r| r.get(0),
    )?;
    if !has_first_ts {
        return Ok(false);
    }
    conn.query_row(
        "SELECT (SELECT IFNULL(SUM(n), 0) FROM usage_hourly) = (SELECT COUNT(*) FROM messages)",
        [],
        |r| r.get(0),
    )
}

/// Create the rollup and its triggers, or rebuild them when [`healthy`]
/// says the stored sums can't be trusted. The fill from `messages` runs in
/// the same transaction as the trigger creation so no write slips between.
pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    if healthy(conn)? {
        // Triggers are IF NOT EXISTS: cheap to re-assert every start.
        return conn.execute_batch(&triggers());
    }
    let sums: Vec<String> = COLS.iter().map(|c| format!("SUM({c})")).collect();
    conn.execute_batch(&format!(
        "BEGIN IMMEDIATE;\
         DROP TRIGGER IF EXISTS usage_hourly_ai;\
         DROP TRIGGER IF EXISTS usage_hourly_ad;\
         DROP TRIGGER IF EXISTS usage_hourly_au;\
         DROP TABLE IF EXISTS usage_hourly;\
         {TABLE}\
         INSERT INTO usage_hourly \
           SELECT substr(timestamp, 1, 13), session_id, project_slug, IFNULL(model, ''), \
                  type, provider, COUNT(*), {sums}, MAX(timestamp), MIN(timestamp) \
           FROM messages GROUP BY 1, 2, 3, 4, 5, 6;\
         {trg}\
         COMMIT;",
        sums = sums.join(", "),
        trg = triggers(),
    ))
}

/// Where an aggregate reads from, with the column expressions that differ
/// between the raw table and the rollup. Both expose the token columns,
/// `session_id`, `project_slug`, `type` and `provider` under the same names.
pub(crate) struct Source {
    /// Table to select from.
    pub table: &'static str,
    /// Per-row weight: summing it counts messages.
    pub n: &'static str,
    /// Column the since/until bounds compare against.
    pub ts: &'static str,
    /// Latest timestamp expression for `MAX(..)`.
    pub last_ts: &'static str,
    /// Earliest timestamp expression for `MIN(..)`.
    pub first_ts: &'static str,
    /// Model column, NULL when unknown.
    pub model: &'static str,
}

const RAW: Source = Source {
    table: "messages",
    n: "1",
    ts: "timestamp",
    last_ts: "timestamp",
    first_ts: "timestamp",
    model: "model",
};

const ROLLUP: Source = Source {
    table: "usage_hourly",
    n: "n",
    ts: "hour",
    last_ts: "last_ts",
    first_ts: "first_ts",
    model: "NULLIF(model, '')",
};

impl Source {
    /// Pick the rollup when both bounds sit on an hour boundary (or are
    /// absent), translating them to `hour` keys; otherwise the raw table
    /// with the bounds unchanged. Bounds compare as strings, as before:
    /// `timestamp >= '2026-10-09T22:00:00.000Z'` selects exactly the rows
    /// whose `hour >= '2026-10-09T22'`, and a date-only bound such as
    /// `'2026-10-09'` orders the same against both columns.
    pub(crate) fn for_range<'a>(
        since: Option<&'a str>,
        until: Option<&'a str>,
    ) -> (&'static Source, Option<&'a str>, Option<&'a str>) {
        match (hour_bound(since), hour_bound(until)) {
            (Some(s), Some(u)) => (&ROLLUP, s, u),
            _ => (&RAW, since, until),
        }
    }
}

/// `Some(bound as an hour key)` when `b` is absent or hour-aligned, `None`
/// when it falls inside an hour (the rollup can't split a bucket).
fn hour_bound(b: Option<&str>) -> Option<Option<&str>> {
    let Some(s) = b else {
        return Some(None);
    };
    let date_only = s.len() == 10 && s.as_bytes().get(4) == Some(&b'-');
    if date_only {
        return Some(Some(s));
    }
    let aligned = s.len() > 13
        && s.as_bytes()[10] == b'T'
        && s[13..]
            .bytes()
            .all(|c| matches!(c, b':' | b'0' | b'.' | b'Z'));
    aligned.then(|| Some(&s[..13]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hour_bounds() {
        assert_eq!(hour_bound(None), Some(None));
        assert_eq!(hour_bound(Some("2026-10-09")), Some(Some("2026-10-09")));
        assert_eq!(
            hour_bound(Some("2026-10-09T22:00:00.000Z")),
            Some(Some("2026-10-09T22"))
        );
        assert_eq!(hour_bound(Some("2026-10-09T22:30:00.000Z")), None);
        assert_eq!(hour_bound(Some("2026-10-09T22:00:00.001Z")), None);
        assert_eq!(hour_bound(Some("2026-10-09T22:00:00+02:00")), None);
    }
}
