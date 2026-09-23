#!/usr/bin/env python3
"""Build a static catalogue snapshot for the storefront front-end.

The storefront backend runs on an ephemeral host (see HOSTING.md). If that host
is restarting or asleep, /api/products returns an error and the listing pages
would be empty. This script freezes the last good catalogue into a static file
that the site serves itself, so browsing keeps working even while the API is
down. Checkout ALWAYS re-prices on the server, so a snapshot price can never be
used to place an order.

Usage:
    python3 scripts/build-catalogue-snapshot.py [BASE_URL]

BASE_URL defaults to http://localhost:8080
"""
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080").rstrip("/")
OUT = Path(__file__).resolve().parent.parent / "frontend" / "data" / "catalogue.json"

DISPLAY_FIELDS = (
    "id", "name", "description", "image", "selling_price",
    "currency", "stock", "in_stock", "category", "updated_at",
)


def get_json(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=30) as r:
        return json.load(r)


def main():
    products = get_json("/api/products?per_page=60&sort=name_asc")["data"]
    categories = get_json("/api/products/categories")["data"]

    items = [{k: p.get(k) for k in DISPLAY_FIELDS} for p in products]
    cats = [{"name": c["name"], "count": c["count"]} for c in categories]

    snapshot = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "storefront-backend",
        "count": len(items),
        "items": items,
        "categories": cats,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(snapshot, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(items)} products, {len(cats)} categories)")


if __name__ == "__main__":
    main()
