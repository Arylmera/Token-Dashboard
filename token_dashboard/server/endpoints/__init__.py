"""HTTP endpoint functions, grouped by concern.

Each endpoint is `(handler, db_path, pricing, qs) -> None` (or a small variant
for sources/io that read post bodies). routes.py imports from here and wires
them into the dispatch table.
"""
