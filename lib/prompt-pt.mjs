// lib/prompt-pt.mjs — tabelas de texto em português (camada A: “como o sistema fala”).
//
// Contrato: o conjunto de chaves deve coincidir 1:1 com `PROMPT_TEXT.en` /
// `COMMAND_MESSAGES.en` do index.mjs. A única diferença proposital é
// `replyLanguage.pt` (a linha que exige resposta em português); `replyLanguage.zh` /
// `.en` existem apenas para alinhar o conjunto de chaves — esta tabela nunca é
// escolhida para esses idiomas.
//
// Tom: português neutro, tratamento por “você”, sem regionalismo marcado. Os termos
// do DSH (sessão / espaço de trabalho / predefinição / habilidade / subagente) ficam
// como estão; “persona” designa o perfil de comportamento do agente, não uma pessoa.
//
// Os marcadores `${n}` / `${o}` / `${b}` / `${name}` e a aridade das funções devem
// coincidir com a versão em inglês: o integrador (`promptTextOf` /
// `commandMessages`) injeta os valores da mesma forma.
//
// O index.mjs do vendor não importa este arquivo: a ligação é feita pela camada A
// (registro `PROMPT_TABLES`). Os literais `PROMPT_TEXT` / `COMMAND_MESSAGES`
// continuam em {zh, en}, pois verify-config exige exatamente dois blocos.

export const PROMPT_TEXT_PT = {
  roleHeader: '[Papel]',
  profileHeader: '[Perfil do usuário]',
  profileDisclaimer: 'As informações abaixo descrevem o usuário com quem você fala — NÃO são a sua própria identidade. Não trate a profissão, o histórico nem a autoapresentação do usuário como a sua persona.',
  profileNickname: (n) => `- Apelido: ${n} (chame o usuário por esse nome nas respostas)`,
  profileOccupation: (o) => `- Profissão: ${o}`,
  profileBio: (b) => `- Autoapresentação: ${b}`,
  subagentIdentityHint: (name) => `Você está no papel de “${name}” — faça o que esse nome implica.`,
  styleHeader: '[Estilo de resposta]',
  styleLabel: 'Estilo e tom da resposta: ',
  styles: {
    professional: 'Rigoroso e profissional, focado em lógica e precisão, formal e cortês',
    casual: 'Descontraído e natural, como uma conversa entre amigos, neutro e objetivo',
    humorous: 'Com humor, boas analogias e piadas, coloquial',
    roast: 'Deboche afetuoso: afiado e espirituoso, nunca cruel, coloquial',
    efficient: 'Eficiente e direto, conciso, sem rodeios'
  },
  headingLists: {
    more: 'Organize as respostas com formatação clara, títulos e listas',
    less: 'Use mais texto em parágrafos; reduza títulos e listas'
  },
  emoji: {
    more: 'Use emojis com bastante frequência nas respostas',
    less: 'Mantenha o uso de emojis no mínimo'
  },
  tables: {
    more: 'Prefira tabelas para comparações, informações com vários campos ou dados estruturados',
    less: 'Evite tabelas; use listas ou parágrafos'
  },
  replyLength: {
    concise: 'Responda de forma concisa: vá aos pontos principais e não se estenda fora do assunto',
    detailed: 'Responda em detalhe: desenvolva contexto, passos e raciocínio'
  },
  replyLanguage: {
    zh: '必须使用简体中文回复',
    en: 'You must reply in English.',
    pt: 'Você deve responder em português.'
  },
  joiner: '; ',
  rulesHeader: '[Regras de execução]',
  rules: 'Siga rigorosamente o papel e o estilo de resposta acima em TODAS as respostas; quando o perfil do usuário estiver em jogo, use-o para entender o usuário e ajustar as respostas às necessidades e ao nível dele, sem nunca tomá-lo como sua própria identidade. Isso vale para qualquer situação: explicar código, perguntas técnicas, conversa informal ou divulgação de conhecimento. Violar esta regra conta como falha.',
  injectUpdatedHeader: '[dsh-soul] Configuração de personalização atualizada',
  injectUpdatedBody: [
    'Abaixo está o instantâneo mais recente de personalização (apelido, estilo e tom, características, idioma de saída etc.).',
    'A partir de agora, responda conforme esta configuração; não continue usando o apelido, o papel, o estilo, o tom, as características ou o idioma de saída anteriores.'
  ].join('\n'),
  injectDisabled: [
    '[dsh-soul] Configuração de personalização desativada',
    'Pare de usar qualquer apelido, papel, estilo, tom, característica ou idioma de saída que o dsh-soul tenha injetado em você.',
    'Volte ao seu comportamento padrão.'
  ].join('\n'),
  injectCleared: [
    '[dsh-soul] Persona do subagente apagada',
    'Pare de usar qualquer apelido, papel, estilo, tom ou característica que o dsh-soul tenha injetado em você.',
    'Trabalhe conforme a tarefa em si.'
  ].join('\n'),
  toolUpdated: 'Configuração de personalização atualizada',
  subagentRule: '[Subagentes] Subagentes não herdam a sua persona (a menos que a herança esteja ativada nas configurações). Para que um deles interprete um papel específico, chame set_subagent_persona com pending: true ANTES de iniciá-lo: ele nascerá com essa persona; você também pode mirar um subagente em execução pela sessão, mas só enquanto ele estiver vivo.',
  toolSubagentMissing: 'Predefinição inexistente: ',
  toolSubagentNoTarget: 'Nenhum subagente ativo para mirar: passe session (o subagentId devolvido por spawn); para enfileirar uma persona para o próximo subagente, passe pending: true antes de iniciá-lo',
  toolSubagentNeedTarget: 'Vários subagentes ativos — passe session para escolher um: ',
  toolSubagentNotMine: 'Essa sessão não é um dos seus subagentes ativos — você só pode alterar subagentes que iniciou e que ainda estão em execução. Para definir a persona do próximo subagente, use pending: true.',
  toolSubagentUpdated: 'Persona do subagente atualizada (aplica-se na próxima montagem)',
  toolSubagentCleared: 'Persona do subagente apagada',
  toolSubagentQueued: 'Enfileirado: o próximo subagente iniciado nascerá com esta persona',
  toolSubagentQueueCleared: 'Persona enfileirada do subagente apagada',
  toolNoChanges: 'Nenhuma configuração para alterar',
  toolValidationFailed: 'Falha na validação da configuração: ',
  toolProposal: 'Mudança de persona solicitada (o modo de confirmação está ativo — ainda não aplicada):',
  toolRejected: 'Você recusou esta mudança de persona no painel de aprovação — nada foi alterado.',
  toolApprovalDisabled: 'Observação: o canal de aprovação está desativado nesta sessão (approval policy = never), então nenhum painel de confirmação apareceu; isso não significa que você recusou algo.',
  toolProposalHint: 'Ela fica pendente até o usuário confirmar com /soul confirm ou recusar com /soul reject.'
}

export const COMMAND_MESSAGES_PT = {
  showTitle: '🧠 Configurações de personalização',
  colon: ': ',
  statusLabel: 'Status',
  nicknameLabel: 'Apelido',
  occupationLabel: 'Profissão',
  bioLabel: 'Autoapresentação',
  styleLabel: 'Estilo e tom',
  styleNames: {
    professional: 'Profissional',
    casual: 'Descontraído',
    humorous: 'Bem-humorado',
    roast: 'Debochado',
    efficient: 'Eficiente'
  },
  traitsLabel: 'Características',
  headingListsLabel: 'Títulos e listas',
  emojiLabel: 'Emoji',
  tablesLabel: 'Tabelas',
  replyLengthLabel: 'Comprimento da resposta',
  traitNames: {
    default: 'Padrão',
    more: 'Mais',
    less: 'Menos'
  },
  replyLengthNames: {
    concise: 'Conciso',
    normal: 'Equilibrado',
    detailed: 'Detalhado'
  },
  listSep: ', ',
  trailLabel: 'Rastro luminoso do campo de entrada',
  trailLine: (status, color, speedName, widthName) => `${status} (${color} / ${speedName} / ${widthName})`,
  trailSpeedNames: {
    slow: 'Lenta',
    normal: 'Normal',
    fast: 'Rápida'
  },
  trailWidthNames: {
    thin: 'Fino',
    normal: 'Normal',
    thick: 'Grosso'
  },
  instructionsLabel: 'Instruções personalizadas',
  enabled: 'ativada',
  disabled: 'desativada',
  notSet: 'não definido',
  toolConfirmLabel: 'Confirmação de ferramentas',
  onLabel: 'sim',
  offLabel: 'não',
  personasLabel: 'Personas',
  pendingHint: (at) => `⚠ Proposta de persona pendente (criada em ${at}): /soul confirm para aplicar, /soul reject para descartar`,
  noPending: 'Nenhuma proposta de persona pendente',
  sessionsGcReport: (plan, apply) => {
    const lines = []
    lines.push(apply ? '🧹 Limpeza dos ajustes por sessão' : '🧹 Limpeza dos ajustes por sessão (simulação — nada foi apagado)')
    lines.push(plan.scanComplete
      ? 'Lista de sessões: completa'
      : `Lista de sessões: INDISPONÍVEL — ${plan.persistenceProblem || 'motivo desconhecido'}`)
    lines.push(`Arquivos: ${plan.total} · candidatos: ${plan.markable.length} · removíveis: ${plan.collectable.length} · corrompidos: ${plan.quarantine.length}`)
    if (!plan.scanComplete) {
      lines.push('Enquanto a lista de sessões estiver indisponível, nada é marcado nem apagado — “não visto” não é “apagado”.')
    }
    for (const item of plan.collectable.slice(0, 20)) {
      lines.push(`  ✕ ${item.sessionId} — ${item.reason}`)
    }
    for (const item of plan.quarantine.slice(0, 20)) {
      lines.push(`  ⚠ ${item.file} — ${item.reason}`)
    }
    if (!apply && plan.collectable.length > 0) {
      lines.push('Execute `/soul sessions --apply` para apagar os itens acima.')
    }
    return lines.join('\n')
  },
  confirmDone: (detail) => `✅ Mudanças de persona aplicadas: ${detail}`,
  rejectDone: '✅ Proposta de persona pendente descartada',
  saveDone: (name) => `✅ Persona “${name}” salva`,
  builtinName: 'integrada',
  builtinSaveBlocked: (name) => `“${name}” é uma persona integrada — escolha outro nome`,
  duplicateSaveBlocked: (names) => `Já existe uma persona com conteúdo idêntico: “${names}” — use-a diretamente ou ajuste a persona antes de salvar`,
  builtinDeleteBlocked: (name) => `“${name}” é uma persona integrada e não pode ser apagada`,
  useDone: (name) => `✅ Persona “${name}” aplicada`,
  useUnchanged: (name) => `ℹ A persona “${name}” coincide com a configuração atual`,
  usePartial: (name, fields) => `⚠ A persona “${name}” foi aplicada em parte; ignorados por valores inválidos: ${fields}`,
  useAllInvalid: (name, fields) => `✗ A persona “${name}” não tem nenhum campo aplicável: ${fields}`,
  personaMissing: (name) => `A persona “${name}” não existe`,
  delDone: (name) => `✅ Persona “${name}” apagada`,
  listTitle: '📋 Personas',
  listEmpty: 'Ainda não há personas — salve a configuração atual com /soul save <nome>',
  listCovers: (n) => `cobre ${n} campo${n === 1 ? '' : 's'}`,
  saveUsage: 'Uso: /soul save <nome> (1-30 caracteres)',
  useUsage: 'Uso: /soul use <nome>',
  delUsage: 'Uso: /soul del <nome>',
  setUsage: 'Uso: /soul set chave=valor ... (campos: enabled / style / headingLists / emoji / tables / replyLength / language / nickname / occupation / bio / customInstructions / trailEnabled / trailColor / trailSpeed / trailWidth)',
  unknownField: 'Campo desconhecido',
  invalidBoolean: (key, value) => `${key} deve ser true ou false (recebido: ${JSON.stringify(value)})`,
  setNoChanges: 'Nenhuma mudança de configuração para aplicar',
  setDone: (keys) => `✅ Atualizado: ${keys.join(', ')}`,
  help: 'Use /soul show para ver os detalhes\nUse /soul set style=humorous para alterar campos\nUse /soul save <nome> / use <nome> / list / del <nome> para personas\nUse /soul confirm ou /soul reject para propostas pendentes\nUse /soul reset para redefinir\nUse /soul enable / disable para ativar ou desativar\nUse /soul <apelido> para definir seu apelido',
  resetDone: '✅ Configuração redefinida para os padrões',
  resetRecovered: (file) => `✅ Configuração redefinida (o arquivo danificado foi salvo como ${file})`,
  deliveryLabel: 'Entrega: ',
  deliveryOk: (delivered, total) => total === 0
    ? 'nenhuma sessão ativa (a configuração será aplicada em uma nova sessão)'
    : `injetada em ${delivered}/${total} sessões ativas`,
  deliveryNoAgentsService: 'o serviço `agents` está indisponível — a nova configuração só pode viajar pela seção do prompt de sistema, então pode exigir uma nova sessão para valer',
  deliveryInjectFailed: (detail) => `falha na injeção nas sessões ativas: ${detail}`,
  enableDone: '✅ Personalização ativada',
  disableDone: '✅ Personalização desativada',
  nicknameDone: (n) => `✅ Apelido definido: ${n}`,
  failed: (e) => `A operação falhou: ${e}`
}
