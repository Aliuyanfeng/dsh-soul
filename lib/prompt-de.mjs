// lib/prompt-de.mjs — deutsche Texttabellen (Schicht A: „wie das System spricht“).
//
// Vertrag: Der Schlüsselsatz muss 1:1 mit `PROMPT_TEXT.en` / `COMMAND_MESSAGES.en`
// aus index.mjs übereinstimmen. Einzige gewollte Abweichung ist `replyLanguage.de`
// (die Zeile, die eine Antwort auf Deutsch verlangt); `replyLanguage.zh` / `.en`
// existieren nur, damit der Schlüsselsatz deckungsgleich bleibt — für diese Sprachen
// wird diese Tabelle nie gewählt.
//
// Ton: neutrales Deutsch, Duzen, keine regionale Färbung. DSH-Begriffe (Sitzung /
// Arbeitsbereich / Voreinstellung / Skill / Subagent) bleiben unverändert; „Persona“
// bezeichnet das Verhaltensprofil des Agenten, keine menschliche Person.
//
// Die Platzhalter `${n}` / `${o}` / `${b}` / `${name}` und die Funktionsarität müssen
// mit der englischen Fassung übereinstimmen: der Integrator (`promptTextOf` /
// `commandMessages`) setzt die Werte auf dieselbe Weise ein.
//
// Das index.mjs des Vendors importiert diese Datei nicht; die Verbindung stellt
// Schicht A her (Register `PROMPT_TABLES`). Die Literale `PROMPT_TEXT` /
// `COMMAND_MESSAGES` bleiben bei {zh, en}, weil verify-config genau zwei Blöcke
// verlangt.

export const PROMPT_TEXT_DE = {
  roleHeader: '[Rolle]',
  profileHeader: '[Nutzerprofil]',
  profileDisclaimer: 'Die folgenden Angaben beschreiben den Nutzer, mit dem du sprichst – sie sind NICHT deine eigene Identität. Behandle Beruf, Hintergrund und Selbstbeschreibung des Nutzers nicht als deine Persona.',
  profileNickname: (n) => `- Spitzname: ${n} (sprich den Nutzer in Antworten mit diesem Namen an)`,
  profileOccupation: (o) => `- Beruf: ${o}`,
  profileBio: (b) => `- Selbstbeschreibung: ${b}`,
  subagentIdentityHint: (name) => `Du spielst die Rolle „${name}“ – tue, was dieser Name impliziert.`,
  styleHeader: '[Antwortstil]',
  styleLabel: 'Antwortstil und Ton: ',
  styles: {
    professional: 'Streng und professionell, auf Logik und Genauigkeit bedacht, förmlich und höflich',
    casual: 'Locker und natürlich, wie ein Gespräch unter Freunden, neutral und sachlich',
    humorous: 'Mit Humor, treffenden Vergleichen und Witzen, umgangssprachlich',
    roast: 'Liebevoll schnippisch: pointiert und schlagfertig, aber nie verletzend, umgangssprachlich',
    efficient: 'Effizient und direkt, knapp, ohne Umschweife'
  },
  headingLists: {
    more: 'Strukturiere Antworten mit klarer Formatierung, Überschriften und Listen',
    less: 'Nutze mehr Fließtext; reduziere Überschriften und Listen'
  },
  emoji: {
    more: 'Nutze Emojis in Antworten recht häufig',
    less: 'Halte die Nutzung von Emojis minimal'
  },
  tables: {
    more: 'Bevorzuge Tabellen für Vergleiche, Informationen mit mehreren Feldern oder strukturierte Daten',
    less: 'Vermeide Tabellen; nutze Listen oder Fließtext'
  },
  replyLength: {
    concise: 'Antworte knapp: nur die Kernpunkte, keine Abschweifungen',
    detailed: 'Antworte ausführlich: entfalte Hintergrund, Schritte und Begründung'
  },
  replyLanguage: {
    zh: '必须使用简体中文回复',
    en: 'You must reply in English.',
    de: 'Du musst auf Deutsch antworten.'
  },
  joiner: '; ',
  rulesHeader: '[Ausführungsregeln]',
  rules: 'Halte dich in JEDER Antwort strikt an die obige Rollen- und Stilvorgabe; wenn das Nutzerprofil eine Rolle spielt, nutze es, um den Nutzer zu verstehen und deine Antworten auf seine Bedürfnisse und sein Niveau zuzuschneiden – verwechsle es aber nie mit deiner eigenen Identität. Das gilt in allen Lagen: Code erklären, technische Fragen, Plaudern oder Wissensvermittlung. Ein Verstoß gegen diese Regel gilt als Fehler.',
  injectUpdatedHeader: '[dsh-soul] Personalisierungskonfiguration aktualisiert',
  injectUpdatedBody: [
    'Unten steht der neueste Personalisierungs-Snapshot (Spitzname, Antwortstil und Ton, Merkmale, Ausgabesprache usw.).',
    'Antworte ab jetzt gemäß dieser Konfiguration; verwende nicht weiter den vorherigen Spitznamen, die Rolle, den Stil, den Ton, die Merkmale oder die Ausgabesprache.'
  ].join('\n'),
  injectDisabled: [
    '[dsh-soul] Personalisierungskonfiguration deaktiviert',
    'Verwende keinen Spitznamen, keine Rolle, keinen Stil, keinen Ton, keine Merkmale und keine Ausgabesprache mehr, die dsh-soul dir zuvor injiziert hat.',
    'Kehre zu deinem Standardverhalten zurück.'
  ].join('\n'),
  injectCleared: [
    '[dsh-soul] Subagent-Persona gelöscht',
    'Verwende keinen Spitznamen, keine Rolle, keinen Stil, keinen Ton und keine Merkmale mehr, die dsh-soul dir injiziert hat.',
    'Arbeite nach der Aufgabe selbst.'
  ].join('\n'),
  toolUpdated: 'Personalisierungseinstellungen aktualisiert',
  subagentRule: '[Subagenten] Subagenten erben deine Persona nicht (außer die Vererbung ist in den Einstellungen aktiviert). Damit einer eine bestimmte Rolle spielt, rufe set_subagent_persona mit pending: true VOR dem Start auf – dann wird er mit dieser Persona geboren; du kannst auch einen laufenden Subagenten über seine Sitzung ansprechen, aber nur solange er lebt.',
  toolSubagentMissing: 'Keine solche Voreinstellung: ',
  toolSubagentNoTarget: 'Kein aktiver Subagent zum Ansprechen: übergib session (die subagentId aus spawn); um eine Persona für den nächsten Subagenten einzuplanen, übergib pending: true vor dem Start',
  toolSubagentNeedTarget: 'Mehrere aktive Subagenten – übergib session, um einen zu wählen: ',
  toolSubagentNotMine: 'Diese Sitzung ist keiner deiner aktiven Subagenten – du kannst nur Subagenten ändern, die du gestartet hast und die noch laufen. Für die Persona des nächsten Subagenten nutze pending: true.',
  toolSubagentUpdated: 'Subagent-Persona aktualisiert (gilt beim nächsten Zusammenbau)',
  toolSubagentCleared: 'Subagent-Persona gelöscht',
  toolSubagentQueued: 'Eingeplant: der nächste gestartete Subagent wird mit dieser Persona geboren',
  toolSubagentQueueCleared: 'Eingeplante Subagent-Persona gelöscht',
  toolNoChanges: 'Keine Einstellungen zu ändern',
  toolValidationFailed: 'Validierung der Konfiguration fehlgeschlagen: ',
  toolProposal: 'Persona-Änderung angefordert (Bestätigungsmodus ist aktiv – noch nicht angewendet):',
  toolRejected: 'Du hast diese Persona-Änderung im Genehmigungsfenster abgelehnt – nichts wurde geändert.',
  toolApprovalDisabled: 'Hinweis: Der Genehmigungskanal ist in dieser Sitzung deaktiviert (approval policy = never), daher erschien kein Bestätigungsfenster; das bedeutet nicht, dass du etwas abgelehnt hast.',
  toolProposalHint: 'Sie bleibt offen, bis der Nutzer sie mit /soul confirm bestätigt oder mit /soul reject ablehnt.'
}

export const COMMAND_MESSAGES_DE = {
  showTitle: '🧠 Personalisierungseinstellungen',
  colon: ': ',
  statusLabel: 'Status',
  nicknameLabel: 'Spitzname',
  occupationLabel: 'Beruf',
  bioLabel: 'Selbstbeschreibung',
  styleLabel: 'Stil und Ton',
  styleNames: {
    professional: 'Professionell',
    casual: 'Locker',
    humorous: 'Humorvoll',
    roast: 'Schnippisch',
    efficient: 'Effizient'
  },
  traitsLabel: 'Merkmale',
  headingListsLabel: 'Überschriften und Listen',
  emojiLabel: 'Emoji',
  tablesLabel: 'Tabellen',
  replyLengthLabel: 'Antwortlänge',
  traitNames: {
    default: 'Standard',
    more: 'Mehr',
    less: 'Weniger'
  },
  replyLengthNames: {
    concise: 'Knapp',
    normal: 'Ausgewogen',
    detailed: 'Ausführlich'
  },
  listSep: ', ',
  trailLabel: 'Lichtspur am Eingabefeld',
  trailLine: (status, color, speedName, widthName) => `${status} (${color} / ${speedName} / ${widthName})`,
  trailSpeedNames: {
    slow: 'Langsam',
    normal: 'Normal',
    fast: 'Schnell'
  },
  trailWidthNames: {
    thin: 'Dünn',
    normal: 'Normal',
    thick: 'Dick'
  },
  instructionsLabel: 'Benutzerdefinierte Anweisungen',
  enabled: 'aktiviert',
  disabled: 'deaktiviert',
  notSet: 'nicht gesetzt',
  toolConfirmLabel: 'Tool-Bestätigung',
  onLabel: 'an',
  offLabel: 'aus',
  personasLabel: 'Personas',
  pendingHint: (at) => `⚠ Offener Persona-Vorschlag (erstellt am ${at}): /soul confirm zum Anwenden, /soul reject zum Verwerfen`,
  noPending: 'Kein offener Persona-Vorschlag',
  sessionsGcReport: (plan, apply) => {
    const lines = []
    lines.push(apply ? '🧹 Bereinigung der Sitzungs-Einstellungen' : '🧹 Bereinigung der Sitzungs-Einstellungen (Probelauf – nichts gelöscht)')
    lines.push(plan.scanComplete
      ? 'Sitzungsliste: vollständig'
      : `Sitzungsliste: NICHT VERFÜGBAR – ${plan.persistenceProblem || 'unbekannter Grund'}`)
    lines.push(`Dateien: ${plan.total} · Kandidaten: ${plan.markable.length} · löschbar: ${plan.collectable.length} · beschädigt: ${plan.quarantine.length}`)
    if (!plan.scanComplete) {
      lines.push('Solange die Sitzungsliste fehlt, wird nichts markiert oder gelöscht – „nicht gesehen“ heißt nicht „gelöscht“.')
    }
    for (const item of plan.collectable.slice(0, 20)) {
      lines.push(`  ✕ ${item.sessionId} — ${item.reason}`)
    }
    for (const item of plan.quarantine.slice(0, 20)) {
      lines.push(`  ⚠ ${item.file} — ${item.reason}`)
    }
    if (!apply && plan.collectable.length > 0) {
      lines.push('Führe `/soul sessions --apply` aus, um die oben genannten Einträge zu löschen.')
    }
    return lines.join('\n')
  },
  confirmDone: (detail) => `✅ Persona-Änderungen angewendet: ${detail}`,
  rejectDone: '✅ Offener Persona-Vorschlag verworfen',
  saveDone: (name) => `✅ Persona „${name}“ gespeichert`,
  builtinName: 'integriert',
  builtinSaveBlocked: (name) => `„${name}“ ist eine integrierte Persona – wähle einen anderen Namen`,
  duplicateSaveBlocked: (names) => `Eine Persona mit identischem Inhalt existiert bereits: „${names}“ – nutze sie direkt oder ändere die Persona vor dem Speichern`,
  builtinDeleteBlocked: (name) => `„${name}“ ist eine integrierte Persona und kann nicht gelöscht werden`,
  useDone: (name) => `✅ Persona „${name}“ angewendet`,
  useUnchanged: (name) => `ℹ Persona „${name}“ entspricht der aktuellen Konfiguration`,
  usePartial: (name, fields) => `⚠ Persona „${name}“ nur teilweise angewendet; ungültige Felder übersprungen: ${fields}`,
  useAllInvalid: (name, fields) => `✗ Persona „${name}“ hat kein anwendbares Feld: ${fields}`,
  personaMissing: (name) => `Persona „${name}“ existiert nicht`,
  delDone: (name) => `✅ Persona „${name}“ gelöscht`,
  listTitle: '📋 Personas',
  listEmpty: 'Noch keine Personas – speichere die aktuelle Konfiguration mit /soul save <Name>',
  listCovers: (n) => `deckt ${n} Feld${n === 1 ? '' : 'er'} ab`,
  saveUsage: 'Aufruf: /soul save <Name> (1-30 Zeichen)',
  useUsage: 'Aufruf: /soul use <Name>',
  delUsage: 'Aufruf: /soul del <Name>',
  setUsage: 'Aufruf: /soul set Schlüssel=Wert ... (Felder: enabled / style / headingLists / emoji / tables / replyLength / language / nickname / occupation / bio / customInstructions / trailEnabled / trailColor / trailSpeed / trailWidth)',
  unknownField: 'Unbekanntes Feld',
  invalidBoolean: (key, value) => `${key} muss true oder false sein (erhalten: ${JSON.stringify(value)})`,
  setNoChanges: 'Keine Konfigurationsänderungen anzuwenden',
  setDone: (keys) => `✅ Aktualisiert: ${keys.join(', ')}`,
  help: 'Nutze /soul show für Details\nNutze /soul set style=humorous, um Felder zu ändern\nNutze /soul save <Name> / use <Name> / list / del <Name> für Personas\nNutze /soul confirm oder /soul reject für offene Persona-Vorschläge\nNutze /soul reset zum Zurücksetzen\nNutze /soul enable / disable zum Umschalten\nNutze /soul <Spitzname>, um deinen Spitznamen zu setzen',
  resetDone: '✅ Konfiguration auf Standardwerte zurückgesetzt',
  resetRecovered: (file) => `✅ Konfiguration zurückgesetzt (die beschädigte Datei wurde als ${file} gesichert)`,
  deliveryLabel: 'Zustellung: ',
  deliveryOk: (delivered, total) => total === 0
    ? 'keine aktiven Sitzungen (die Konfiguration greift in einer neuen Sitzung)'
    : `in ${delivered}/${total} aktive Sitzungen injiziert`,
  deliveryNoAgentsService: 'der Dienst `agents` ist nicht verfügbar – die neue Konfiguration kann nur über den System-Prompt-Abschnitt reisen, daher ist eventuell eine neue Sitzung nötig',
  deliveryInjectFailed: (detail) => `Injektion in aktive Sitzungen fehlgeschlagen: ${detail}`,
  enableDone: '✅ Personalisierung aktiviert',
  disableDone: '✅ Personalisierung deaktiviert',
  nicknameDone: (n) => `✅ Spitzname gesetzt: ${n}`,
  failed: (e) => `Vorgang fehlgeschlagen: ${e}`
}
