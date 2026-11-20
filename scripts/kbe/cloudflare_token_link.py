"""The link that opens Cloudflare's "create API token" screen, filled in.

Cloudflare documents this link ("API token template URLs"):
https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/

What that page gives, and so what this uses:

- the user-token form, `https://dash.cloudflare.com/profile/api-tokens`
- `permissionGroupKeys`: a JSON list of `{key, type}`, URL-encoded
- `accountId` and `zoneId`: required; `*` and `all` are the documented values
- `name`: the token's name

What it does not give: a way to limit the token to one zone or one account
from the link, or to set an end date. `BY_HAND` lists those; the person sets
them on the screen. A key Cloudflare does not know is dropped without a
message, so `PERMISSIONS` is always printed for the person to check.

`engine/src/setup/token-link.ts` builds the same link for the setup page. A
test compares the two.
"""

from __future__ import annotations

import json
from urllib.parse import quote

BASE = "https://dash.cloudflare.com/profile/api-tokens"
NAME = "KB Engine setup - delete after use"

# (Cloudflare's short key, where it is picked on the screen, its name there).
# The names are the ones in engine/src/setup/permissions.ts.
PERMISSIONS = (
    ("access", "Account", "Access: Apps and Policies"),
    ("access_acct", "Account", "Access: Organizations, Identity Providers, and Groups"),
    ("dns", "Zone", "DNS"),
)

# What the link cannot fill in. Each line is one thing to set on the screen.
BY_HAND = (
    "Account Resources: include only your own account.",
    "Zone Resources: Specific zone, the domain of {host}.",
    "TTL: end date tomorrow, so the token stops working by itself.",
)


def link() -> str:
    """The documented user-token link with the three permissions at Edit."""
    keys = [{"key": key, "type": "edit"} for key, _scope, _name in PERMISSIONS]
    encoded = quote(json.dumps(keys, separators=(",", ":")), safe="")
    return (
        f"{BASE}?permissionGroupKeys={encoded}"
        f"&accountId=%2A&zoneId=all&name={quote(NAME, safe='')}"
    )


def permission_lines() -> list[str]:
    """`Account - Access: Apps and Policies - Edit`, one per permission."""
    return [f"{scope} - {name} - Edit" for _key, scope, name in PERMISSIONS]
