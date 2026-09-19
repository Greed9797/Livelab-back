# src/jobs/offsite-backup.js

- executeBackup · function · L10-L37 — async function executeBackup(_command, [scriptPath], { timeout = 1800000, stopGraceMs = 5000 } = {})
- signalGroup · function · L16-L16 — signalGroup = (signal)
- reportBackupFailure · function · L39-L41 — function reportBackupFailure(error)
- runOffsiteBackup · function · L43-L67 — async function runOffsiteBackup(app, { run = executeBackup, report = reportBackupFailure } = {})
