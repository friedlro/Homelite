"""Tuya 24-GHz-mmWave-Radar (Präsenzmelder) TS0601 _TZE284_iadro9bf / _TZE204_iadro9bf.

Datenpunkte (aus der Community dokumentiert, Zigbee2MQTT-Converter/ZHA-Issue #3969):
  1 = Bewegung/Präsenz (0 = erkannt, 1 = frei), 9 = Auslöse-Empfindlichkeit,
  12 = Helligkeit (Lux), 101 = Präsenz-Empfindlichkeit, 102 = Haltezeit (s)
Wird von HomeLite beim Start in den Quirk-Ordner kopiert.
"""
import zigpy.types as t
from zigpy.zcl.clusters.measurement import OccupancySensing
from zhaquirks.builder import EntityPlatform, EntityType, UnitOfTime
from zhaquirks.tuya import TuyaLocalCluster
from zhaquirks.tuya.builder import TuyaQuirkBuilder


class RadarOccupancy(OccupancySensing, TuyaLocalCluster):
    """Tuya local OccupancySensing cluster."""


class Sensitivity(t.enum8):
    Niedrig = 0
    Mittel = 1
    Hoch = 2


(
    TuyaQuirkBuilder("_TZE284_iadro9bf", "TS0601")
    .applies_to("_TZE204_iadro9bf", "TS0601")
    .tuya_dp(
        dp_id=1,
        ep_attribute=RadarOccupancy.ep_attribute,
        attribute_name=OccupancySensing.AttributeDefs.occupancy.name,
        converter=lambda x: x == 0,
    )
    .adds(RadarOccupancy)
    .tuya_illuminance(dp_id=12)
    .tuya_enum(
        dp_id=9,
        attribute_name="trigger_sensitivity",
        enum_class=Sensitivity,
        translation_key="trigger_sensitivity",
        fallback_name="Auslöse-Empfindlichkeit",
    )
    .tuya_enum(
        dp_id=101,
        attribute_name="presence_sensitivity",
        enum_class=Sensitivity,
        translation_key="presence_sensitivity",
        fallback_name="Präsenz-Empfindlichkeit",
    )
    .tuya_number(
        dp_id=102,
        attribute_name="fading_time",
        type=t.uint16_t,
        unit=UnitOfTime.SECONDS,
        min_value=10,
        max_value=600,
        step=1,
        translation_key="fading_time",
        fallback_name="Haltezeit",
    )
    .skip_configuration()
    .add_to_registry()
)
