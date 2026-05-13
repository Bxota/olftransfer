import io
import os
from typing import Optional

import clamd


def _get_clamd() -> clamd.ClamdNetworkSocket:
    host = os.environ.get("CLAMAV_HOST", "clamav")
    port = int(os.environ.get("CLAMAV_PORT", 3310))
    return clamd.ClamdNetworkSocket(host=host, port=port)


def scan_bytes(data: bytes) -> Optional[str]:
    """Scan bytes with ClamAV. Returns virus name if detected, None if clean. Raises on connection error."""
    cd = _get_clamd()
    result = cd.instream(io.BytesIO(data))
    status, virus_name = result["stream"]
    if status == "FOUND":
        return virus_name
    return None
