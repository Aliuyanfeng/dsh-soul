// lib/prompt-fr.mjs — tables de textes en français (couche A : « comment parle le système »).
//
// Contrat : l’ensemble des clés doit correspondre 1:1 à `PROMPT_TEXT.en` /
// `COMMAND_MESSAGES.en` d’index.mjs. Seule différence volontaire : `replyLanguage.fr`
// (la ligne qui impose de répondre en français) ; `replyLanguage.zh` / `.en` existent
// uniquement pour aligner l’ensemble des clés — cette table n’est jamais choisie pour
// ces langues.
//
// Ton : français neutre, tutoiement, pas de régionalisme marqué. Les termes de DSH
// (session / espace de travail / préréglage / compétence / sous-agent) sont conservés
// tels quels ; « persona » désigne le profil de comportement de l’agent, pas une
// personne humaine.
//
// Les marqueurs `${n}` / `${o}` / `${b}` / `${name}` et l’arité des fonctions doivent
// correspondre à la version anglaise : l’intégrateur (`promptTextOf` /
// `commandMessages`) injecte les valeurs de la même façon.
//
// L’index.mjs du vendor n’importe pas ce fichier : le raccordement se fait par la
// couche A (registre `PROMPT_TABLES`). Les littéraux `PROMPT_TEXT` /
// `COMMAND_MESSAGES` restent en {zh, en} car verify-config exige exactement deux blocs.

export const PROMPT_TEXT_FR = {
  roleHeader: '[Rôle]',
  profileHeader: '[Profil de l’utilisateur]',
  profileDisclaimer: 'Les informations ci-dessous décrivent l’utilisateur à qui tu parles : ce n’est PAS ta propre identité. Ne prends pas sa profession, son parcours ni sa présentation pour ta persona.',
  profileNickname: (n) => `- Surnom : ${n} (appelle l’utilisateur par ce nom dans tes réponses)`,
  profileOccupation: (o) => `- Profession : ${o}`,
  profileBio: (b) => `- Présentation : ${b}`,
  subagentIdentityHint: (name) => `Tu joues le rôle « ${name} » : fais ce que ce nom implique.`,
  styleHeader: '[Style de réponse]',
  styleLabel: 'Style et ton de réponse : ',
  styles: {
    professional: 'Rigoureux et professionnel, centré sur la logique et la précision, formel et courtois',
    casual: 'Décontracté et naturel, comme une discussion entre amis, neutre et objectif',
    humorous: 'Avec humour, des analogies et des plaisanteries bienvenues, familier',
    roast: 'Taquineries affectueuses : mordant et spirituel, jamais méchant, familier',
    efficient: 'Efficace et direct, concis, sans détour'
  },
  headingLists: {
    more: 'Organise les réponses avec une mise en forme claire, des titres et des listes',
    less: 'Privilégie les paragraphes ; réduis les titres et les listes'
  },
  emoji: {
    more: 'Utilise des emojis assez souvent dans les réponses',
    less: 'Limite l’usage des emojis au strict minimum'
  },
  tables: {
    more: 'Privilégie les tableaux pour les comparaisons, les informations à plusieurs champs ou les données structurées',
    less: 'Évite les tableaux ; utilise des listes ou des paragraphes'
  },
  replyLength: {
    concise: 'Sois concis : va à l’essentiel et n’ajoute pas de développements hors sujet',
    detailed: 'Réponds en détail : développe le contexte, les étapes et le raisonnement'
  },
  replyLanguage: {
    zh: '必须使用简体中文回复',
    en: 'You must reply in English.',
    fr: 'Tu dois répondre en français.'
  },
  joiner: ' ; ',
  rulesHeader: '[Règles d’exécution]',
  rules: 'Tu dois respecter strictement le rôle et le style de réponse ci-dessus dans TOUTES tes réponses ; lorsque le profil de l’utilisateur entre en jeu, sers-t’en pour le comprendre et adapter tes réponses à ses besoins et à son niveau, sans jamais le prendre pour ta propre identité. Cela vaut pour tous les cas : explication de code, questions techniques, conversation informelle ou vulgarisation. Enfreindre cette règle compte comme un échec.',
  injectUpdatedHeader: '[dsh-soul] Configuration de personnalisation mise à jour',
  injectUpdatedBody: [
    'Voici l’instantané de personnalisation le plus récent (surnom, style et ton, traits, langue de sortie, etc.).',
    'À partir de maintenant, réponds conformément à cette configuration ; ne continue pas avec le surnom, le rôle, le style, le ton, les traits ou la langue de sortie précédents.'
  ].join('\n'),
  injectDisabled: [
    '[dsh-soul] Configuration de personnalisation désactivée',
    'Cesse d’utiliser le surnom, le rôle, le style, le ton, les traits ou la langue de sortie que dsh-soul t’a injectés.',
    'Reviens à ton comportement par défaut.'
  ].join('\n'),
  injectCleared: [
    '[dsh-soul] Persona du sous-agent effacée',
    'Cesse d’utiliser le surnom, le rôle, le style, le ton ou les traits que dsh-soul t’a injectés.',
    'Travaille selon la tâche elle-même.'
  ].join('\n'),
  toolUpdated: 'Configuration de personnalisation mise à jour',
  subagentRule: '[Sous-agents] Les sous-agents n’héritent pas de ta persona (sauf si l’héritage est activé dans les réglages). Pour qu’un sous-agent joue un rôle précis, appelle set_subagent_persona avec pending: true AVANT de le lancer : il naîtra avec cette persona. Tu peux aussi viser un sous-agent en cours via sa session, mais seulement tant qu’il est actif.',
  toolSubagentMissing: 'Préréglage introuvable : ',
  toolSubagentNoTarget: 'Aucun sous-agent actif à cibler : passe session (le subagentId renvoyé par spawn) ; pour mettre une persona en file pour le prochain sous-agent, passe pending: true avant de le lancer',
  toolSubagentNeedTarget: 'Plusieurs sous-agents actifs : passe session pour en choisir un : ',
  toolSubagentNotMine: 'Cette session n’est pas l’un de tes sous-agents actifs : tu ne peux modifier que les sous-agents que tu as lancés et qui tournent encore. Pour définir la persona du prochain sous-agent, utilise pending: true.',
  toolSubagentUpdated: 'Persona du sous-agent mise à jour (appliquée au prochain assemblage)',
  toolSubagentCleared: 'Persona du sous-agent effacée',
  toolSubagentQueued: 'En file : le prochain sous-agent lancé naîtra avec cette persona',
  toolSubagentQueueCleared: 'Persona en file du sous-agent effacée',
  toolNoChanges: 'Aucun réglage à modifier',
  toolValidationFailed: 'Échec de la validation de la configuration : ',
  toolProposal: 'Changement de persona demandé (le mode confirmation est actif — pas encore appliqué) :',
  toolRejected: 'Tu as refusé ce changement de persona dans le panneau d’approbation : rien n’a été modifié.',
  toolApprovalDisabled: 'Note : le canal d’approbation est désactivé dans cette session (approval policy = never), donc aucun panneau de confirmation ne s’est affiché ; cela ne signifie pas que tu as refusé quoi que ce soit.',
  toolProposalHint: 'Rien ne sera appliqué tant que l’utilisateur ne confirme pas avec /soul confirm ou ne refuse pas avec /soul reject.'
}

export const COMMAND_MESSAGES_FR = {
  showTitle: '🧠 Réglages de personnalisation',
  colon: ' : ',
  statusLabel: 'État',
  nicknameLabel: 'Surnom',
  occupationLabel: 'Profession',
  bioLabel: 'Présentation',
  styleLabel: 'Style et ton',
  styleNames: {
    professional: 'Professionnel',
    casual: 'Décontracté',
    humorous: 'Humoristique',
    roast: 'Mordant',
    efficient: 'Efficace'
  },
  traitsLabel: 'Traits',
  headingListsLabel: 'Titres et listes',
  emojiLabel: 'Emoji',
  tablesLabel: 'Tableaux',
  replyLengthLabel: 'Longueur de réponse',
  traitNames: {
    default: 'Par défaut',
    more: 'Plus',
    less: 'Moins'
  },
  replyLengthNames: {
    concise: 'Concis',
    normal: 'Équilibré',
    detailed: 'Détaillé'
  },
  listSep: ', ',
  trailLabel: 'Traînée lumineuse du champ de saisie',
  trailLine: (status, color, speedName, widthName) => `${status} (${color} / ${speedName} / ${widthName})`,
  trailSpeedNames: {
    slow: 'Lente',
    normal: 'Normale',
    fast: 'Rapide'
  },
  trailWidthNames: {
    thin: 'Fine',
    normal: 'Normale',
    thick: 'Épaisse'
  },
  instructionsLabel: 'Instructions personnalisées',
  enabled: 'activée',
  disabled: 'désactivée',
  notSet: 'non défini',
  toolConfirmLabel: 'Confirmation des outils',
  onLabel: 'oui',
  offLabel: 'non',
  personasLabel: 'Personas',
  pendingHint: (at) => `⚠ Proposition de persona en attente (créée le ${at}) : /soul confirm pour l’appliquer, /soul reject pour l’écarter`,
  noPending: 'Aucune proposition de persona en attente',
  sessionsGcReport: (plan, apply) => {
    const lines = []
    lines.push(apply ? '🧹 Nettoyage des réglages par session' : '🧹 Nettoyage des réglages par session (simulation : rien n’a été supprimé)')
    lines.push(plan.scanComplete
      ? 'Liste des sessions : complète'
      : `Liste des sessions : INDISPONIBLE — ${plan.persistenceProblem || 'raison inconnue'}`)
    lines.push(`Fichiers : ${plan.total} · candidats : ${plan.markable.length} · supprimables : ${plan.collectable.length} · corrompus : ${plan.quarantine.length}`)
    if (!plan.scanComplete) {
      lines.push('Tant que la liste des sessions est indisponible, rien n’est marqué ni supprimé : « non vu » ne veut pas dire « supprimé ».')
    }
    for (const item of plan.collectable.slice(0, 20)) {
      lines.push(`  ✕ ${item.sessionId} — ${item.reason}`)
    }
    for (const item of plan.quarantine.slice(0, 20)) {
      lines.push(`  ⚠ ${item.file} — ${item.reason}`)
    }
    if (!apply && plan.collectable.length > 0) {
      lines.push('Lance `/soul sessions --apply` pour supprimer les entrées ci-dessus.')
    }
    return lines.join('\n')
  },
  confirmDone: (detail) => `✅ Changements de persona appliqués : ${detail}`,
  rejectDone: '✅ Proposition de persona en attente écartée',
  saveDone: (name) => `✅ Persona « ${name} » enregistrée`,
  builtinName: 'intégrée',
  builtinSaveBlocked: (name) => `« ${name} » est une persona intégrée : choisis un autre nom`,
  duplicateSaveBlocked: (names) => `Une persona au contenu identique existe déjà : « ${names} » — utilise-la directement, ou ajuste la persona avant d’enregistrer`,
  builtinDeleteBlocked: (name) => `« ${name} » est une persona intégrée et ne peut pas être supprimée`,
  useDone: (name) => `✅ Persona « ${name} » appliquée`,
  useUnchanged: (name) => `ℹ La persona « ${name} » correspond à la configuration actuelle`,
  usePartial: (name, fields) => `⚠ La persona « ${name} » n’a été appliquée qu’en partie ; champs ignorés car invalides : ${fields}`,
  useAllInvalid: (name, fields) => `✗ La persona « ${name} » n’a aucun champ applicable : ${fields}`,
  personaMissing: (name) => `La persona « ${name} » n’existe pas`,
  delDone: (name) => `✅ Persona « ${name} » supprimée`,
  listTitle: '📋 Personas',
  listEmpty: 'Aucune persona pour l’instant : enregistre la configuration actuelle avec /soul save <nom>',
  listCovers: (n) => `couvre ${n} champ${n === 1 ? '' : 's'}`,
  saveUsage: 'Usage : /soul save <nom> (1-30 caractères)',
  useUsage: 'Usage : /soul use <nom>',
  delUsage: 'Usage : /soul del <nom>',
  setUsage: 'Usage : /soul set clé=valeur ... (champs : enabled / style / headingLists / emoji / tables / replyLength / language / nickname / occupation / bio / customInstructions / trailEnabled / trailColor / trailSpeed / trailWidth)',
  unknownField: 'Champ inconnu',
  invalidBoolean: (key, value) => `${key} doit valoir true ou false (reçu : ${JSON.stringify(value)})`,
  setNoChanges: 'Aucun changement de configuration à appliquer',
  setDone: (keys) => `✅ Mis à jour : ${keys.join(', ')}`,
  help: 'Utilise /soul show pour les détails\nUtilise /soul set style=humorous pour modifier des champs\nUtilise /soul save <nom> / use <nom> / list / del <nom> pour les personas\nUtilise /soul confirm ou /soul reject pour les propositions en attente\nUtilise /soul reset pour réinitialiser\nUtilise /soul enable / disable pour activer ou désactiver\nUtilise /soul <surnom> pour définir ton surnom',
  resetDone: '✅ Configuration réinitialisée aux valeurs par défaut',
  resetRecovered: (file) => `✅ Configuration réinitialisée (le fichier endommagé a été sauvegardé sous ${file})`,
  deliveryLabel: 'Distribution : ',
  deliveryOk: (delivered, total) => total === 0
    ? 'aucune session active (la configuration s’appliquera dans une nouvelle session)'
    : `injectée dans ${delivered}/${total} sessions actives`,
  deliveryNoAgentsService: 'le service `agents` est indisponible : la nouvelle configuration ne peut passer que par la section du prompt système, elle peut donc nécessiter une nouvelle session pour s’appliquer',
  deliveryInjectFailed: (detail) => `échec de l’injection dans les sessions actives : ${detail}`,
  enableDone: '✅ Personnalisation activée',
  disableDone: '✅ Personnalisation désactivée',
  nicknameDone: (n) => `✅ Surnom défini : ${n}`,
  failed: (e) => `L’opération a échoué : ${e}`
}
