## 0.7.0
- Prepared public GitHub/ioBroker publication metadata for `helfi9999/ioBroker.ecovacs-map`.
- Added public-facing English-first README and GitHub setup instructions.
- Added GitHub Actions test matrix for Node.js 22/24 on Linux, Windows and macOS.
- Added current ioBroker metadata fields (`tier`, `licenseInformation`, external icon/readme URLs).
- Runtime map/room behavior remains based on the proven 0.6.7 functionality.

## 0.6.7
- Fixed ioBroker Admin jsonConfig validation warning for the room configuration help text.

## 0.6.6
- Clarified the Room ID(s) help text in adapter settings: one ID per room, or multiple comma-separated IDs to merge, e.g. 2,3.

## 0.6.5
- `map.html` room labels inherit the surrounding VIS/inventwo widget text style instead of requiring adapter datapoints for text appearance.
- Supported inherited properties include color, font-family, font-style, font-variant, font-weight, font-size, line-height, letter-spacing, word-spacing and text-shadow.
- `map.svg` stays self-contained and continues to use the existing appearance datapoints for backward compatibility.
- Geometric room labels remain centered in their room; widget `text-align` does not reposition SVG room labels.

## 0.6.4
- Unified room naming and virtual room merging into one automatically populated settings table.
- A row with one Room ID is a normal room; comma-separated IDs such as `2,3` form one virtual VIS room.
- Existing custom room names and 0.6.3 merge settings are migrated automatically.
- Original Ecovacs SpotArea objects/states remain unchanged.

## 0.6.3
- Based on 0.6.2 (itself based directly on the proven 0.5.6 map logic).
- Added device-independent virtual room merges configured by device/source and comma-separated SpotArea IDs.
- Merged rooms are rendered as one visual area with one name; original Ecovacs room objects/states remain untouched.
- Clicking a merged VIS room selects/deselects all member SpotAreas together, so existing clean-selected controls continue to work.
- Live report/history resolve member room IDs to the configured merged room name.
- Added `status.roomMergeReport` per robot for diagnostics.

## 0.6.2
- Based directly on 0.5.6 map/geometry logic; does not include the 0.6.0/0.6.1 map-switch/cache changes.
- Added `status.roomGeometryReport` per robot to list spotArea substates, numeric/polygon parsing and selected geometry candidates.
- Intended to diagnose models where spotAreas exist but geometry is stored differently.

## 0.5.6
- Added per-robot live report (`report.current`, last event/time, sequence).
- Added bounded cleaning history (`history.events`, count, maxEntries, clear).
- Reports room changes, cleaning start, return to dock, charging, pause and finish without logging every position update.

## 0.5.5
- Added an automatically populated room-name table in adapter settings.
- Custom display names override generic Spot area names while real Ecovacs app names remain the default.

## 0.5.4
- Updated the adapter icon/logo with the new vacuum-map branding.

# Changelog

## 0.5.3

- Integrationstest auf einen einzigen Adapter-Start pro Testlauf umgestellt.
- Synthetischer Deebot prüft in einem Lauf Geräteerkennung, Räume, `currentUsedSpotAreas`, Position und SVG.
- Vermeidet Harness-Timeouts durch mehrfaches Starten/Stoppen des Testadapters.

## 0.5.2 (2026-09-02)

- Reworked synthetic integration tests so they do not rely on raw test-DB writes emitting foreign stateChange events.
- Added startup/restart coverage for currentUsedSpotAreas and robot telemetry.
- Fixed the runtime self-test report version string.

## 0.5.1 (2026-09-02)
- Added `repository.type = git` metadata required by ioBroker package tests.
- Added `common.news` entries required by ioBroker package tests.
- Kept runtime logic unchanged from 0.5.0.

## 0.5.0 (2026-09-02)

- Added official-style package validation with `@iobroker/testing`.
- Added isolated integration tests using a synthetic `ecovacs-deebot.0` source; the real Ecovacs adapter is not required for tests.
- Added tests for device discovery, room creation, SVG output, app room-selection mirroring and live robot position.
- Added `TESTING.md` with test-system instructions.

## 0.4.6 (2026-09-01)

- Versionsangaben in `package.json` und `io-package.json` vollständig auf 0.4.6 vereinheitlicht.
- Neuer Laufzeit-Selbsttest über `control.selfTest`.
- Self-Test-Ergebnis unter `info.selfTestStatus`, `info.selfTestReport` und `info.selfTestTimestamp`.
- `npm test` / `npm run qa` mit statischen Paketprüfungen ergänzt.
- QA-Checkliste für Installation, Upgrade, mehrere Sauger, VIS, App-Synchronisation und Langzeittest ergänzt.
- Keine Änderung an der bewährten Karten-, Raum- oder Reinigungslogik aus 0.4.5.

## 0.4.5 (2026-09-01)

- Neue Einstellung `<Gerät>.appearance.labelSize` für die Schriftgröße der Raumnamen.
- Bereich 4 bis 24 px, Schrittweite 0,5 px, Standard 7 px.
- Änderung wird sofort in SVG/HTML übernommen.
- Bestehende Darstellung und Kartenlogik bleiben unverändert.

## 0.4.4

- Bereinigt den alten `commands.rescan`-State zuverlässig bei Updates.
- Entfernt den veralteten `commands`-Kanal und alte `devices`-Objekte beim Start.
- Nur `control.rescan` bleibt als globaler Rescan-Button bestehen.
- Keine Änderung an Karten-, Raum- oder Reinigungslogik.

# Changelog

## 0.4.3 (2026-09-01)

- Dokumentation an den tatsächlichen 0.4.x-Code angepasst.
- Veraltete AutoRefresh-Beschreibung entfernt.
- Klarstellung: Es gibt keine periodischen `loadMapImage`-Aufrufe mehr.
- `control.refreshMap` bleibt nur als manuelle Diagnosefunktion erhalten.
- Versionsangaben in `package.json` und `io-package.json` auf 0.4.3 vereinheitlicht.
- Admin-JSON-Config mit i18n aus 0.4.2 beibehalten.

## 0.4.2 (2026-09-01)

- Automatischen Kartenbild-Refresh vollständig entfernt; keine periodischen `loadMapImage`-Anforderungen mehr.
- Manuellen `control.refreshMap` nur als Diagnoseaktion beibehalten.
- Alte `map.autoRefresh`-Objekte werden beim Start entfernt.
- Admin-JSON-Config durch i18n-Konfiguration und Übersetzungen korrigiert.
- Routine-Logging reduziert; Geräteerkennung bleibt auf Debug-Level.

## 0.4.1 (2026-09-01)

- AutoRefresh pro erkanntem Sauger getrennt.
- Pro Gerät: `map.autoRefresh.enabled`, `intervalMinutes`, `lastRequest`, `nextRequest`, `status`.
- Minimum für automatische Kartenbildanforderungen: 30 Minuten.
- Mehrere Sauger zeitlich versetzt geplant.
- Automatische Kartenanforderungen nur auf Debug-Level geloggt.
- Originales Ecovacs-Kartenbild nicht mehr in `ecovacs-map` dupliziert.
- Paketmetadaten und Logging bereinigt.

## 0.4.0 (2026-09-01)

- Periodische Kartenbildanforderung standardmäßig deaktiviert.
- Mindestintervall auf 30 Minuten begrenzt.
- Kartenanforderung auf Debug-Level statt Info-Level geloggt.

## 0.3.8 (2026-09-01)

- `currentUsedSpotAreas` ist während Spot-Area-Reinigung die maßgebliche Quelle für die App-Raumauswahl.
- Keine Vermischung mehr mit veralteten Raum-Markierungsstates.
