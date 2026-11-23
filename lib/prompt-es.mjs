// lib/prompt-es.mjs — tablas de texto en español (capa A: «cómo habla el sistema»).
//
// Contrato: el conjunto de claves debe coincidir 1:1 con `PROMPT_TEXT.en` /
// `COMMAND_MESSAGES.en` de index.mjs. La única diferencia deliberada es
// `replyLanguage.es` (la línea que exige responder en español); `replyLanguage.zh` /
// `.en` existen solo para mantener el conjunto de claves alineado — esta tabla nunca
// se elige para esos idiomas.
//
// Tono: español neutro, tuteo, sin regionalismos marcados. Los términos de DSH
// (sesión / espacio de trabajo / preajuste / habilidad / subagente) se mantienen tal
// cual; «persona» se usa como término de producto (el perfil de comportamiento del
// agente), no como «persona humana».
//
// Los marcadores `${n}` / `${o}` / `${b}` / `${name}` y la aridad de cada función
// deben coincidir con la versión en inglés: el integrador (`promptTextOf` /
// `commandMessages`) inyecta los valores de la misma forma.
//
// El index.mjs del vendor no importa este archivo: la conexión la hace la capa A
// (registro `PROMPT_TABLES`). Los literales `PROMPT_TEXT` / `COMMAND_MESSAGES` se
// quedan en {zh, en} porque verify-config exige exactamente dos bloques.

export const PROMPT_TEXT_ES = {
  roleHeader: '[Rol]',
  profileHeader: '[Perfil del usuario]',
  profileDisclaimer: 'La información siguiente describe al usuario con quien hablas: NO es tu propia identidad. No trates su profesión, sus antecedentes ni su autodescripción como si fueran tu persona.',
  profileNickname: (n) => `- Apodo: ${n} (llama al usuario por este nombre en las respuestas)`,
  profileOccupation: (o) => `- Profesión: ${o}`,
  profileBio: (b) => `- Autodescripción: ${b}`,
  subagentIdentityHint: (name) => `Actúas como el rol «${name}»: haz lo que ese nombre implica.`,
  styleHeader: '[Estilo de respuesta]',
  styleLabel: 'Estilo y tono de respuesta: ',
  styles: {
    professional: 'Riguroso y profesional, centrado en la lógica y la precisión, formal y cortés',
    casual: 'Relajado y natural, como charlar con un amigo, neutral y objetivo',
    humorous: 'Con humor, con buenas analogías y chistes, coloquial',
    roast: 'Con pullas cariñosas: mordaz e ingenioso pero nunca hiriente, coloquial',
    efficient: 'Eficiente y directo, conciso, sin rodeos'
  },
  headingLists: {
    more: 'Organiza las respuestas con un formato claro, títulos y listas',
    less: 'Usa más texto en párrafos; reduce títulos y listas'
  },
  emoji: {
    more: 'Usa emojis con bastante frecuencia en las respuestas',
    less: 'Mantén el uso de emojis al mínimo'
  },
  tables: {
    more: 'Prefiere tablas para comparaciones, información con varios campos o datos estructurados',
    less: 'Evita las tablas; usa listas o párrafos'
  },
  replyLength: {
    concise: 'Sé conciso: ve a los puntos clave y no te extiendas en lo que no venga al caso',
    detailed: 'Responde con detalle: desarrolla antecedentes, pasos y razonamiento'
  },
  replyLanguage: {
    zh: '必须使用简体中文回复',
    en: 'You must reply in English.',
    es: 'Debes responder en español.'
  },
  joiner: '; ',
  rulesHeader: '[Reglas de ejecución]',
  rules: 'Debes respetar estrictamente el rol y el estilo de respuesta anteriores en TODAS las respuestas; cuando intervenga el perfil del usuario, úsalo para entenderlo y ajustar tus respuestas a sus necesidades y su nivel, pero nunca lo tomes como tu propia identidad. Esto cubre cualquier situación: explicar código, preguntas técnicas, charla informal o divulgación de conocimiento. Incumplir esta regla cuenta como fallo.',
  injectUpdatedHeader: '[dsh-soul] Configuración de personalización actualizada',
  injectUpdatedBody: [
    'A continuación tienes la instantánea más reciente de personalización (apodo, estilo y tono, rasgos, idioma de salida, etc.).',
    'Desde ahora debes responder conforme a esta configuración; no sigas usando el apodo, el rol, el estilo, el tono, los rasgos ni el idioma de salida anteriores.'
  ].join('\n'),
  injectDisabled: [
    '[dsh-soul] Configuración de personalización desactivada',
    'Deja de usar cualquier apodo, rol, estilo, tono, rasgo o idioma de salida que dsh-soul te haya inyectado antes.',
    'Vuelve a tu comportamiento predeterminado.'
  ].join('\n'),
  injectCleared: [
    '[dsh-soul] Persona del subagente borrada',
    'Deja de usar cualquier apodo, rol, estilo, tono o rasgo que dsh-soul te haya inyectado antes.',
    'Trabaja según la tarea en sí.'
  ].join('\n'),
  toolUpdated: 'Configuración de personalización actualizada',
  subagentRule: '[Subagentes] Los subagentes no heredan tu persona (salvo que la herencia esté activada en los ajustes). Para que uno interprete un rol concreto, llama a set_subagent_persona con pending: true ANTES de lanzarlo, y nacerá con esa persona; también puedes apuntar a un subagente en ejecución por sesión, pero solo mientras siga vivo.',
  toolSubagentMissing: 'No existe ese preajuste: ',
  toolSubagentNoTarget: 'No hay ningún subagente activo al que apuntar: pasa session (el subagentId que devuelve spawn); para encolar una persona para el siguiente subagente, pasa pending: true antes de lanzarlo',
  toolSubagentNeedTarget: 'Hay varios subagentes activos: pasa session para elegir uno: ',
  toolSubagentNotMine: 'Esa sesión no es uno de tus subagentes activos: solo puedes cambiar subagentes que hayas lanzado y sigan en ejecución. Para asignar una persona al siguiente subagente, usa pending: true.',
  toolSubagentUpdated: 'Persona del subagente actualizada (se aplica en el próximo ensamblado)',
  toolSubagentCleared: 'Persona del subagente borrada',
  toolSubagentQueued: 'Encolado: el próximo subagente lanzado nacerá con esta persona',
  toolSubagentQueueCleared: 'Se borró la persona encolada para el subagente',
  toolNoChanges: 'No hay ajustes que cambiar',
  toolValidationFailed: 'La validación de la configuración falló: ',
  toolProposal: 'Se solicitó un cambio de persona (el modo de confirmación está activo: aún no aplicado):',
  toolRejected: 'Rechazaste este cambio de persona en el panel de aprobación: no se modificó nada.',
  toolApprovalDisabled: 'Nota: el canal de aprobación está desactivado en esta sesión (approval policy = never), así que no apareció ningún panel de confirmación; esto no significa que hayas rechazado algo.',
  toolProposalHint: 'No se aplicará hasta que el usuario lo confirme con /soul confirm o lo rechace con /soul reject.'
}

export const COMMAND_MESSAGES_ES = {
  showTitle: '🧠 Ajustes de personalización',
  colon: ': ',
  statusLabel: 'Estado',
  nicknameLabel: 'Apodo',
  occupationLabel: 'Profesión',
  bioLabel: 'Autodescripción',
  styleLabel: 'Estilo y tono',
  styleNames: {
    professional: 'Profesional',
    casual: 'Casual',
    humorous: 'Humorístico',
    roast: 'Mordaz',
    efficient: 'Eficiente'
  },
  traitsLabel: 'Rasgos',
  headingListsLabel: 'Títulos y listas',
  emojiLabel: 'Emoji',
  tablesLabel: 'Tablas',
  replyLengthLabel: 'Longitud de respuesta',
  traitNames: {
    default: 'Predeterminado',
    more: 'Más',
    less: 'Menos'
  },
  replyLengthNames: {
    concise: 'Conciso',
    normal: 'Equilibrado',
    detailed: 'Detallado'
  },
  listSep: ', ',
  trailLabel: 'Estela luminosa del campo de entrada',
  trailLine: (status, color, speedName, widthName) => `${status} (${color} / ${speedName} / ${widthName})`,
  trailSpeedNames: {
    slow: 'Lenta',
    normal: 'Normal',
    fast: 'Rápida'
  },
  trailWidthNames: {
    thin: 'Fina',
    normal: 'Normal',
    thick: 'Gruesa'
  },
  instructionsLabel: 'Instrucciones personalizadas',
  enabled: 'activado',
  disabled: 'desactivado',
  notSet: 'sin definir',
  toolConfirmLabel: 'Confirmación de herramientas',
  onLabel: 'sí',
  offLabel: 'no',
  personasLabel: 'Personas',
  pendingHint: (at) => `⚠ Propuesta de persona pendiente (creada el ${at}): /soul confirm para aplicarla, /soul reject para descartarla`,
  noPending: 'No hay propuestas de persona pendientes',
  sessionsGcReport: (plan, apply) => {
    const lines = []
    lines.push(apply ? '🧹 Limpieza de ajustes por sesión' : '🧹 Limpieza de ajustes por sesión (simulación: no se borró nada)')
    lines.push(plan.scanComplete
      ? 'Lista de sesiones: completa'
      : `Lista de sesiones: NO DISPONIBLE — ${plan.persistenceProblem || 'motivo desconocido'}`)
    lines.push(`Archivos: ${plan.total} · candidatos: ${plan.markable.length} · eliminables: ${plan.collectable.length} · dañados: ${plan.quarantine.length}`)
    if (!plan.scanComplete) {
      lines.push('Mientras la lista de sesiones no esté disponible no se marca ni se borra nada: «no visto» no es «borrado».')
    }
    for (const item of plan.collectable.slice(0, 20)) {
      lines.push(`  ✕ ${item.sessionId} — ${item.reason}`)
    }
    for (const item of plan.quarantine.slice(0, 20)) {
      lines.push(`  ⚠ ${item.file} — ${item.reason}`)
    }
    if (!apply && plan.collectable.length > 0) {
      lines.push('Ejecuta `/soul sessions --apply` para borrar las entradas de arriba.')
    }
    return lines.join('\n')
  },
  confirmDone: (detail) => `✅ Cambios de persona aplicados: ${detail}`,
  rejectDone: '✅ Propuesta de persona pendiente descartada',
  saveDone: (name) => `✅ Persona «${name}» guardada`,
  builtinName: 'integrada',
  builtinSaveBlocked: (name) => `«${name}» es una persona integrada: elige otro nombre`,
  duplicateSaveBlocked: (names) => `Ya existe una persona con contenido idéntico: «${names}» — úsala directamente o ajusta la persona antes de guardar`,
  builtinDeleteBlocked: (name) => `«${name}» es una persona integrada y no se puede borrar`,
  useDone: (name) => `✅ Persona «${name}» aplicada`,
  useUnchanged: (name) => `ℹ La persona «${name}» coincide con la configuración actual`,
  usePartial: (name, fields) => `⚠ La persona «${name}» se aplicó en parte; se omitieron por valores no válidos: ${fields}`,
  useAllInvalid: (name, fields) => `✗ La persona «${name}» no tiene ningún campo aplicable: ${fields}`,
  personaMissing: (name) => `La persona «${name}» no existe`,
  delDone: (name) => `✅ Persona «${name}» borrada`,
  listTitle: '📋 Personas',
  listEmpty: 'Aún no hay personas: guarda la configuración actual con /soul save <nombre>',
  listCovers: (n) => `cubre ${n} campo${n === 1 ? '' : 's'}`,
  saveUsage: 'Uso: /soul save <nombre> (1-30 caracteres)',
  useUsage: 'Uso: /soul use <nombre>',
  delUsage: 'Uso: /soul del <nombre>',
  setUsage: 'Uso: /soul set clave=valor ... (campos: enabled / style / headingLists / emoji / tables / replyLength / language / nickname / occupation / bio / customInstructions / trailEnabled / trailColor / trailSpeed / trailWidth)',
  unknownField: 'Campo desconocido',
  invalidBoolean: (key, value) => `${key} debe ser true o false (recibido: ${JSON.stringify(value)})`,
  setNoChanges: 'No hay cambios de configuración que aplicar',
  setDone: (keys) => `✅ Actualizado: ${keys.join(', ')}`,
  help: 'Usa /soul show para ver los detalles\nUsa /soul set style=humorous para cambiar campos\nUsa /soul save <nombre> / use <nombre> / list / del <nombre> para las personas\nUsa /soul confirm o /soul reject para las propuestas pendientes\nUsa /soul reset para restablecer\nUsa /soul enable / disable para activar o desactivar\nUsa /soul <apodo> para definir tu apodo',
  resetDone: '✅ Configuración restablecida a los valores predeterminados',
  resetRecovered: (file) => `✅ Configuración restablecida (el archivo dañado se guardó como ${file})`,
  deliveryLabel: 'Entrega: ',
  deliveryOk: (delivered, total) => total === 0
    ? 'no hay sesiones activas (la configuración se aplicará en una sesión nueva)'
    : `inyectada en ${delivered}/${total} sesiones activas`,
  deliveryNoAgentsService: 'el servicio `agents` no está disponible: la nueva configuración solo puede viajar por la sección del system prompt, así que puede requerir una sesión nueva para aplicarse',
  deliveryInjectFailed: (detail) => `falló la inyección en las sesiones activas: ${detail}`,
  enableDone: '✅ Personalización activada',
  disableDone: '✅ Personalización desactivada',
  nicknameDone: (n) => `✅ Apodo definido: ${n}`,
  failed: (e) => `La operación falló: ${e}`
}
