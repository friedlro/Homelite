"""HTTP transport for the Leapmotor API client."""

from __future__ import annotations

from pathlib import Path
import subprocess
import tempfile
from typing import Any

from .exceptions import LeapmotorApiError


class CurlTransport:
    """Synchronous curl-based transport matching the verified app client path."""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    def post(
        self,
        *,
        path: str,
        headers: dict[str, str],
        data: str,
        cert: tuple[str, str],
    ) -> dict[str, Any]:
        """Send a POST request and return status, body text, and raw headers."""
        response = self._post(path=path, headers=headers, data=data, cert=cert)
        return {
            "status_code": response["status_code"],
            "body": response["body"].decode("utf-8", errors="replace"),
            "headers": response["headers"],
        }

    def post_binary(
        self,
        *,
        path: str,
        headers: dict[str, str],
        data: str,
        cert: tuple[str, str],
    ) -> dict[str, Any]:
        """Send a POST request and return status, body bytes, and raw headers."""
        return self._post(path=path, headers=headers, data=data, cert=cert)

    def _post(
        self,
        *,
        path: str,
        headers: dict[str, str],
        data: str,
        cert: tuple[str, str],
    ) -> dict[str, Any]:
        url = f"{self.base_url}/{path.lstrip('/')}"
        with tempfile.NamedTemporaryFile() as header_file, tempfile.NamedTemporaryFile() as body_file:
            cmd = [
                "curl",
                "--silent",
                "--show-error",
                "--insecure",
                "-X",
                "POST",
                url,
                "-D",
                header_file.name,
                "-o",
                body_file.name,
                "--cert",
                cert[0],
                "--key",
                cert[1],
            ]
            for key, value in headers.items():
                cmd.extend(["-H", f"{key}: {value}"])
            cmd.extend(["--data", data])

            result = subprocess.run(cmd, capture_output=True, text=True, check=False)
            body_bytes = Path(body_file.name).read_bytes()
            header_text = Path(header_file.name).read_text(encoding="utf-8", errors="replace")
            if result.returncode != 0:
                raise LeapmotorApiError(f"curl request failed: {result.stderr.strip()}")

        return {
            "status_code": _status_code_from_headers(header_text),
            "body": body_bytes,
            "headers": header_text,
        }


def _status_code_from_headers(header_text: str) -> int:
    """Return the last HTTP status code reported by curl."""
    status_code = 0
    for line in header_text.splitlines():
        if line.startswith("HTTP/"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                status_code = int(parts[1])
    return status_code
