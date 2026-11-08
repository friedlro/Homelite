"""Leapmotor API data models."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class Vehicle:
    """Vehicle metadata from the vehicle list."""

    vin: str
    car_id: str | None
    car_type: str
    nickname: str | None
    is_shared: bool
    year: int | None = None
    rights: str | None = None
    abilities: list[str] | None = None
    module_rights: str | None = None
