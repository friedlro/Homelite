# Leapmotor-App-Zertifikate
Die Dateien app_cert.pem und app_key.pem sind nicht im Repository (privater Schlüssel).
Im Betrieb liegen sie unter data/plugin-data/leapmotor/certs; das Plugin lädt sie auf Knopfdruck (Seite „Auto“ → Zertifikate laden) aus https://github.com/markoceri/leapmotor-certs (app.crt/app.key, ohne die „Bag Attributes“-Kopfzeilen) oder übernimmt sie beim Update aus lib/leapmotor/certs.
Für den Diagnose-Aufruf (leap_diag.py) können beide Dateien hier abgelegt werden (oder LEAP_CERT_DIR setzen).
