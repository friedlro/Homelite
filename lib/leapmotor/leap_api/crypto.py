"""Cryptographic helpers for Leapmotor API flows."""

from __future__ import annotations

import base64
import hashlib
import json

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from ..const import DEFAULT_DEVICE_ID, DEFAULT_OPERPWD_AES_IV, DEFAULT_OPERPWD_AES_KEY
from .exceptions import LeapmotorAuthError


def derive_operate_password(pin: str, token: str | None) -> str:
    """Derive operatePassword from the vehicle PIN using the current session token."""
    key_text, iv_text = derive_operpwd_key_iv(token)
    padder = padding.PKCS7(128).padder()
    padded = padder.update(pin.encode("utf-8")) + padder.finalize()
    cipher = Cipher(
        algorithms.AES(key_text.encode("utf-8")),
        modes.CBC(iv_text.encode("utf-8")),
    )
    encryptor = cipher.encryptor()
    ciphertext = encryptor.update(padded) + encryptor.finalize()
    return base64.b64encode(ciphertext).decode("ascii")


def derive_operpwd_key_iv(token: str | None) -> tuple[str, str]:
    """Mirror MD5Util.getEncryptPassword with token-derived AES key/IV."""
    if not token:
        return DEFAULT_OPERPWD_AES_KEY, DEFAULT_OPERPWD_AES_IV
    if len(token) < 64:
        raise LeapmotorAuthError("Access token is too short for operatePassword derivation.")
    key_source = token[:32]
    iv_source = token[32:64]
    key_text = hashlib.md5(key_source.encode("utf-8")).hexdigest()[8:24]
    iv_text = hashlib.md5(iv_source.encode("utf-8")).hexdigest()[8:24]
    return key_text, iv_text


def derive_session_device_id(token: str | None, fallback: str = DEFAULT_DEVICE_ID) -> str:
    """Extract the session deviceId from the JWT payload."""
    if not token:
        return fallback
    try:
        payload_b64 = token.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64.encode("ascii")))
        user_name = str(payload.get("user_name") or "")
        parts = user_name.split(",")
        if len(parts) >= 4 and parts[2]:
            return parts[2]
    except Exception:  # noqa: BLE001
        pass
    return fallback
