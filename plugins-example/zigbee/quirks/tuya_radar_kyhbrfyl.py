"""Haozee 24G mmWave Radar-Präsenzsensor (Tuya TS0601 _TZE204_kyhbrfyl, auch NEO NAS-PS09B2).

Datenpunkte (zha-device-handlers Issue #2827, offizieller Quirk, Hubitat/Z2S-Profile):
  1 = Präsenz (1 = erkannt), 11 = Bewegungsart (aus/klein/groß), 12 = Haltezeit (s),
  13 = Reichweite max. (cm), 15 = Radar-Empfindlichkeit (0–7), 16 = Präsenz-Empfindlichkeit (0–7),
  19 = Zielabstand (cm), 104 = Helligkeit (Lux, logarithmisch umgerechnet)
Gegenüber dem mitgelieferten Quirk zusätzlich: Helligkeit (DP 104, laut Issue-Quirk; nicht an echtem Gerät bestätigt).
Wird von HomeLite beim Start in den Quirk-Ordner kopiert und hat Vorrang vor dem Standard-Quirk.
"""
import zigpy.types as t
from zigpy.zcl.clusters.measurement import OccupancySensing
from zhaquirks.builder import (
    EntityPlatform,
    EntityType,
    NumberDeviceClass,
    SensorDeviceClass,
    SensorStateClass,
    UnitOfLength,
    UnitOfTime,
)
from zhaquirks.tuya.builder import TuyaQuirkBuilder
from zhaquirks.tuya.tuya_motion import TuyaHumanMotionState, TuyaOccupancySensing

(
    TuyaQuirkBuilder("_TZE204_kyhbrfyl", "TS0601")
    .tuya_dp(
        dp_id=1,
        ep_attribute=TuyaOccupancySensing.ep_attribute,
        attribute_name=OccupancySensing.AttributeDefs.occupancy.name,
        converter=lambda x: x == 1,
    )
    .adds(TuyaOccupancySensing)
    .tuya_enum(
        dp_id=11,
        attribute_name="human_motion_state",
        enum_class=TuyaHumanMotionState,
        entity_platform=EntityPlatform.SENSOR,
        entity_type=EntityType.STANDARD,
        translation_key="human_motion_state",
        fallback_name="Bewegungsart",
    )
    .tuya_number(
        dp_id=12,
        attribute_name="fading_time",
        type=t.uint16_t,
        device_class=NumberDeviceClass.DURATION,
        unit=UnitOfTime.SECONDS,
        min_value=3,
        max_value=600,
        step=1,
        translation_key="fading_time",
        fallback_name="Haltezeit",
    )
    .tuya_number(
        dp_id=13,
        attribute_name="detection_distance_max",
        type=t.uint16_t,
        device_class=NumberDeviceClass.DISTANCE,
        unit=UnitOfLength.CENTIMETERS,
        min_value=150,
        max_value=600,
        step=1,
        translation_key="detection_distance_max",
        fallback_name="Reichweite max.",
    )
    .tuya_number(
        dp_id=15,
        attribute_name="radar_sensitivity",
        type=t.uint16_t,
        min_value=0,
        max_value=7,
        step=1,
        translation_key="radar_sensitivity",
        fallback_name="Radar-Empfindlichkeit",
    )
    .tuya_number(
        dp_id=16,
        attribute_name="presence_sensitivity",
        type=t.uint16_t,
        min_value=0,
        max_value=7,
        step=1,
        translation_key="presence_sensitivity",
        fallback_name="Präsenz-Empfindlichkeit",
    )
    .tuya_sensor(
        dp_id=19,
        attribute_name="target_distance",
        type=t.uint16_t,
        state_class=SensorStateClass.MEASUREMENT,
        device_class=SensorDeviceClass.DISTANCE,
        unit=UnitOfLength.CENTIMETERS,
        entity_type=EntityType.STANDARD,
        translation_key="target_distance",
        fallback_name="Zielabstand",
    )
    .tuya_illuminance(dp_id=104)
    .skip_configuration()
    .add_to_registry()
)
