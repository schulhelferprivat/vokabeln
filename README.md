# vokabeln

Offline-Vokabeltrainer mit getrennten lokalen Datenbeständen für Firebase-Konten, Datenbanken und lokale Dateien beziehungsweise Ordner.

Beim Update bleiben bisherige Karten unter **Nur auf diesem Gerät** erhalten. Ein neues Synchronisierungsziel übernimmt diese Karten nicht automatisch. Für eine bewusste Übertragung kann ein Backup im bisherigen Profil exportiert und im Zielprofil importiert werden.

Tests benötigen Node.js ab Version 18:

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

Die Browser-Tests verwenden einen lokalen Testserver und simulierte Firebase-Antworten. Ein bereits installierter Chromium-Browser kann über `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` ausgewählt werden.
