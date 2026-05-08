"""Public surface for the db subpackage. Mirrors the old `token_dashboard.db` module."""
from .schema import (
    SCHEMA,
    connect,
    default_db_path,
    init_db,
)
from .projects import (
    best_project_name,
    project_name_for,
)
from .queries import (
    daily_token_breakdown,
    expensive_prompts,
    hourly_breakdown,
    model_breakdown,
    overview_totals,
    project_summary,
    recent_sessions,
    session_turns,
    skill_breakdown,
    tool_token_breakdown,
)

__all__ = [
    "SCHEMA",
    "best_project_name",
    "connect",
    "daily_token_breakdown",
    "default_db_path",
    "expensive_prompts",
    "hourly_breakdown",
    "init_db",
    "model_breakdown",
    "overview_totals",
    "project_name_for",
    "project_summary",
    "recent_sessions",
    "session_turns",
    "skill_breakdown",
    "tool_token_breakdown",
]
