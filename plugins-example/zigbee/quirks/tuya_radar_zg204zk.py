"""HOBEIAN ZG-204ZK – 24-GHz-Präsenzmelder (Batterie), meldet sich als Hersteller „HOBEIAN“, Modell „ZG-204ZK“.

Datenpunkte (Zigbee2MQTT-Definition ZG-204ZK in hobeian.ts):
  1 = Präsenz, 2 = Empfindlichkeit statisch (0–10), 4 = Erkennungsabstand (cm, 0–500),
  102 = Haltezeit (s, 10–28800), 107 = LED-Anzeige, 121 = Batterie, 122 = Störunterdrückung,
  123 = Empfindlichkeit Bewegung (0–10)
Präsenz (IAS-Zone / Occupancy) und Batterie liefert das Gerät selbst über Standard-Cluster, deshalb ergänzt dieser
Quirk nur die Einstellungen. Wird von HomeLite beim Start in den Quirk-Ordner kopiert.
"""
import zigpy.types as t
from zhaquirks.builder import EntityType, NumberDeviceClass, UnitOfLength, UnitOfTime
from zhaquirks.tuya.builder import TuyaQuirkBuilder

(
    TuyaQuirkBuilder("HOBEIAN", "ZG-204ZK")
    .tuya_number(
        dp_id=102,
        attribute_name="presence_timeout",
        type=t.uint16_t,
        device_class=NumberDeviceClass.DURATION,
        unit=UnitOfTime.SECONDS,
        min_value=10,
        max_value=28800,
        step=1,
        translation_key="fading_time",
        fallback_name="Haltezeit",
    )
    .tuya_number(
        dp_id=4,
        attribute_name="detection_distance",
        type=t.uint16_t,
        device_class=NumberDeviceClass.DISTANCE,
        unit=UnitOfLength.METERS,
        min_value=0,
        max_value=5,
        step=0.01,
        multiplier=0.01,
        translation_key="detection_distance",
        fallback_name="Erkennungsabstand",
    )
    .tuya_number(
        dp_id=2,
        attribute_name="static_detection_sensitivity",
        type=t.uint16_t,
        min_value=0,
        max_value=10,
        step=1,
        translation_key="static_detection_sensitivity",
        fallback_name="Empfindlichkeit (ruhend)",
    )
    .tuya_number(
        dp_id=123,
        attribute_name="motion_detection_sensitivity",
        type=t.uint16_t,
        min_value=0,
        max_value=10,
        step=1,
        translation_key="motion_detection_sensitivity",
        fallback_name="Empfindlichkeit (Bewegung)",
    )
    .tuya_switch(
        dp_id=107,
        attribute_name="indicator",
        entity_type=EntityType.CONFIG,
        translation_key="led_indicator",
        fallback_name="LED-Anzeige",
    )
    .tuya_switch(
        dp_id=122,
        attribute_name="anti_interference",
        entity_type=EntityType.CONFIG,
        translation_key="anti_interference",
        fallback_name="Störunterdrückung",
    )
    .skip_configuration()
    .add_to_registry()
)
