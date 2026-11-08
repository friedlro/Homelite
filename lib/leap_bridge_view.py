'''Status-Abbildung (von Brücke und Diagnose gemeinsam genutzt).'''
def flatten(v):
    """normalize_vehicle liefert Abschnitte (status, location, charging, diagnostics …) -> eine flache Map."""
    flat = {}
    for sec in ("status", "location", "charging", "diagnostics", "vehicle"):
        part = v.get(sec)
        if isinstance(part, dict):
            for k, val in part.items():
                if flat.get(k) is None:
                    flat[k] = val
    return flat


def status_dict(v):
    v = flatten(v)
    g = v.get
    return {
        "soc": g("battery_percent_precise") if g("battery_percent_precise") is not None else g("battery_percent"),
        "range": g("remaining_range_km") if g("remaining_range_km") is not None else g("combined_range_km"),
        "charging": bool(g("is_charging")) if g("is_charging") is not None else None,
        "chargeState": g("connection_state"),
        "chargePower": g("charging_power_kw"),
        "chargeLimit": g("charge_limit_percent"),
        "pluggedIn": g("is_plugged_in"),
        "odometer": g("odometer_km") if g("odometer_km") is not None else g("total_mileage_km"),
        "parked": g("is_parked"),
        "lat": g("latitude"),
        "lon": g("longitude"),
        "interiorTemp": g("interior_temp_c"),
        "outdoorTemp": g("outdoor_temp_c"),
        "acOn": g("climate_on"),
        "locked": g("is_locked"),
        "trunkOpen": g("trunk_open"),
        "tiresOk": not any(g("tire_pressure_alarm_" + p) for p in ("front_left", "front_right", "rear_left", "rear_right")),
        "tires": {
            "fl": g("tire_pressure_front_left_bar"), "fr": g("tire_pressure_front_right_bar"),
            "rl": g("tire_pressure_rear_left_bar"), "rr": g("tire_pressure_rear_right_bar"),
        },
        "tireAlarms": {
            "fl": g("tire_pressure_alarm_front_left"), "fr": g("tire_pressure_alarm_front_right"),
            "rl": g("tire_pressure_alarm_rear_left"), "rr": g("tire_pressure_alarm_rear_right"),
        },
        "model": g("car_type"),
        "nickname": g("nickname"),
    }


