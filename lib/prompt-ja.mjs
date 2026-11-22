// 日本語のホスト側テキスト表（レイヤー A: 「言語の仕組み」）。
//
// 契約: キー集合はベンダーの `index.mjs` にある `PROMPT_TEXT.en` / `COMMAND_MESSAGES.en`
// と 1:1 で一致させる。意図的に異なるのは `replyLanguage.ja`（回答言語そのものを
// 指定する一行）だけで、`replyLanguage.zh` / `.en` はキー集合の一致のために残してある。
// この表では到達不可能: `buildBehavior()` は `replyLanguage[config.language]` を引き、
// JA 表は `language === 'ja'` のときだけ選ばれる。
//
// トーン: 硬すぎない丁寧な日本語。DSH 本体の用語（セッション / ワークスペース /
// プリセット / スキル / サブエージェント）はそのまま使う。役所口調や直訳調は避ける。
// プレースホルダ `${n}` / `${o}` / `${b}` / `${name}` と関数の引数個数は en 版と揃える:
// 統合側（`promptTextOf` / `commandMessages`）はまったく同じ形で値を差し込む。
//
// ベンダーの `index.mjs` はこのファイルを import しない。接続はレイヤー A
// （`promptTextOf` / `commandMessages`）が行い、ベンダーのリテラル `PROMPT_TEXT` /
// `COMMAND_MESSAGES` は手を付けない（そうしないとベンダー検証の
// 「tables / replyLength ブロックがちょうど 2 つ」が赤くなる）。

export const PROMPT_TEXT_JA = {
  roleHeader: '[役割]',
  profileHeader: '[ユーザー背景]',
  profileDisclaimer: '以下は、あなたと対話しているユーザー本人についての情報です。あなた自身の身分ではありません。ユーザーの職業・技術的背景・自己紹介を、あなたの役割として扱わないでください。',
  profileNickname: (n) => `- ニックネーム：${n}（返答ではこの名前で呼びかける）`,
  profileOccupation: (o) => `- 職業：${o}`,
  profileBio: (b) => `- 自己紹介：${b}`,
  // サブエージェント向けの保険: プリセットがスタイルだけを指定し、役割を持たない場合がある。
  subagentIdentityHint: (name) => `あなたは「${name}」という役割を演じます。その名称が意味するところの範囲で振る舞ってください。`,
  styleHeader: '[返答スタイル]',
  styleLabel: '返答のスタイルと語調: ',
  styles: {
    professional: '厳密かつ専門的に。論理と正確さを重んじ、丁寧で礼儀正しく',
    casual: '自然でくだけた、友人と話すような調子。中立的かつ客観的に',
    humorous: 'ユーモアを交え、適度に比喩や冗談を使い、口語的に',
    roast: '親しみのあるツッコミ。辛辣で軽妙だが悪意はなく、口語的に',
    efficient: '効率的で端的に。要点をまっすぐ示し、回りくどい言い方をしない'
  },
  headingLists: {
    more: '見やすい構成を心がけ、見出しや箇条書きを活用して整理する',
    less: '文章の段落を多めにし、見出しや箇条書きは控えめにする'
  },
  emoji: {
    more: '返答の中で絵文字を多めに使う',
    less: '絵文字の使用は最小限にする'
  },
  tables: {
    more: '比較や複数項目の情報など、構造化された内容では表を優先する',
    less: '表を使わず、箇条書きや文章で示す'
  },
  replyLength: {
    concise: 'できるだけ簡潔に。要点だけを示し、関係のない内容は広げない',
    detailed: 'できるだけ詳しく。背景、手順、推論の過程まで十分に展開する'
  },
  replyLanguage: {
    zh: '簡体字中国語で回答すること。',
    en: '英語で回答すること。',
    ja: '日本語で回答すること。'
  },
  joiner: '、',
  rulesHeader: '[実行ルール]',
  rules: 'あらゆる返答で、上記の役割設定と返答スタイルを厳守すること。ユーザー背景に関わる場面では、それを手がかりにユーザーを理解し、そのニーズとレベルに合わせて答えること。ただし、それをあなた自身の身分と取り違えてはならない。コードの説明、技術的な質問、日常的な雑談、知識の解説など、あらゆる場面が対象である。このルールに違反した返答は失敗とみなす。',
  injectUpdatedHeader: '[dsh-soul パーソナライズ設定を更新しました]',
  injectUpdatedBody: [
    '以下は最新のパーソナライズ設定のスナップショットです（ニックネーム、返答スタイルと語調、特徴、回答言語など）。',
    'これ以降はこの設定に従って返答し、以前のニックネーム・役割・スタイル・語調・特徴・回答言語を引き続き使わないでください。'
  ].join('\n'),
  injectDisabled: [
    '[dsh-soul パーソナライズ設定を無効にしました]',
    'これ以降、dsh-soul が以前に注入したニックネーム・役割・返答スタイル・語調・特徴・回答言語は使わないでください。',
    'エージェント本来の既定の動作に戻してください。'
  ].join('\n'),
  injectCleared: [
    '[dsh-soul サブエージェントのパーソナライズ設定を解除しました]',
    'これ以降、dsh-soul が以前にあなたへ注入したニックネーム・役割・返答スタイル・語調・特徴は使わないでください。',
    'タスクそのものに沿って作業してください。'
  ].join('\n'),
  toolUpdated: 'パーソナライズ設定を更新しました',
  subagentRule: '[サブエージェント] サブエージェントはあなたの役割を継承しません（設定で継承を有効にした場合を除く）。サブエージェントに特定の役割を演じさせるには、起動前に pending: true を付けて set_subagent_persona を呼んでください。その役割を持った状態で起動します。すでに起動済みのサブエージェントは session で指定できますが、それが有効なのは稼働中のみです。',
  toolSubagentMissing: 'そのプリセットは存在しません: ',
  toolSubagentNoTarget: '役割を割り当てられる稼働中のサブエージェントが見つかりません。session（spawn が返した subagentId）を渡してください。次のサブエージェントに役割を予約する場合は、起動前に pending: true を渡してください',
  toolSubagentNeedTarget: '稼働中のサブエージェントが複数あります。session で 1 つ選んでください: ',
  toolSubagentNotMine: 'このセッションはあなたの稼働中のサブエージェントではありません。変更できるのは、あなたが起動し、まだ稼働しているサブエージェントだけです。次のサブエージェントに役割を設定するには pending: true を使ってください。',
  toolSubagentUpdated: 'サブエージェントの役割を更新しました（次回の組み立て時に適用されます）',
  toolSubagentCleared: 'サブエージェントの役割を解除しました',
  toolSubagentQueued: '予約しました: 次に起動するサブエージェントはこの役割を持って起動します',
  toolSubagentQueueCleared: 'サブエージェント役割の予約を解除しました',
  toolNoChanges: '変更する設定はありません',
  toolValidationFailed: '設定の検証に失敗しました: ',
  toolProposal: '役割の変更リクエストを受け付けました（確認モードが有効なため、まだ反映されていません）:',
  toolRejected: '確認パネルでこの役割の変更を却下しました。何も変更されていません。',
  toolApprovalDisabled: '補足: このセッションでは確認チャネルが無効です（approval policy = never）。そのため確認パネルは表示されませんでしたが、却下したわけではありません。',
  toolProposalHint: 'ユーザーが /soul confirm で承認するか /soul reject で却下するまで、変更は反映されません。'
}

export const COMMAND_MESSAGES_JA = {
  showTitle: '🧠 パーソナライズ設定',
  colon: ': ',
  statusLabel: '状態',
  nicknameLabel: 'ニックネーム',
  occupationLabel: '職業',
  bioLabel: '自己紹介',
  styleLabel: 'スタイルと語調',
  styleNames: {
    professional: 'プロフェッショナル',
    casual: 'カジュアル',
    humorous: 'ユーモア',
    roast: 'ツッコミ',
    efficient: '効率的'
  },
  traitsLabel: '特徴',
  headingListsLabel: '見出しと箇条書き',
  emojiLabel: '絵文字',
  tablesLabel: '表',
  replyLengthLabel: '返答の長さ',
  traitNames: {
    default: '既定',
    more: '多め',
    less: '控えめ'
  },
  replyLengthNames: {
    concise: '簡潔',
    normal: '標準',
    detailed: '詳細'
  },
  listSep: '、',
  trailLabel: '入力欄の光の軌跡',
  trailLine: (status, color, speedName, widthName) => `${status}（${color} / ${speedName} / ${widthName}）`,
  trailSpeedNames: {
    slow: 'ゆっくり',
    normal: '標準',
    fast: '速く'
  },
  trailWidthNames: {
    thin: '細い',
    normal: '標準',
    thick: '太い'
  },
  instructionsLabel: '独自の指示',
  enabled: '有効',
  disabled: '無効',
  notSet: '未設定',
  toolConfirmLabel: 'ツールの確認',
  onLabel: 'オン',
  offLabel: 'オフ',
  personasLabel: 'プリセット',
  // 提案はメモリ上にあり（再起動で消える）、TTL もない。そのため、いつ出たものかを
  // ユーザーが見て分かるようにする。
  pendingHint: (at) => `⚠ 提案中の役割変更があります（${at} に登録）: /soul confirm で適用、/soul reject で却下`,
  noPending: '提案中の役割変更はありません',
  // セッション整理のレポート。形式は en 版に合わせる: 行を組み立てるのは同じ planSessionGc。
  sessionsGcReport: (plan, apply) => {
    const lines = []
    lines.push(apply ? '🧹 セッション個別設定の整理' : '🧹 セッション個別設定の整理（試行のみ・何も削除していません）')
    lines.push(plan.scanComplete
      ? 'セッション一覧: 完全'
      : `セッション一覧: 取得できません — ${plan.persistenceProblem || '原因不明'}`)
    lines.push(`ファイル：${plan.total} · 候補：${plan.markable.length} · 削除対象：${plan.collectable.length} · 破損：${plan.quarantine.length}`)
    if (!plan.scanComplete) {
      lines.push('セッション一覧が取得できない間は、どの記録もマークも削除もしません。「見えなかった」は「削除された」ではありません。')
    }
    for (const item of plan.collectable.slice(0, 20)) {
      lines.push(`  ✕ ${item.sessionId} — ${item.reason}`)
    }
    for (const item of plan.quarantine.slice(0, 20)) {
      lines.push(`  ⚠ ${item.file} — ${item.reason}`)
    }
    if (!apply && plan.collectable.length > 0) {
      lines.push('`/soul sessions --apply` を実行すると、上記の記録を削除します。')
    }
    return lines.join('\n')
  },
  confirmDone: (detail) => `✅ 役割の変更を適用しました：${detail}`,
  rejectDone: '✅ 提案された役割変更を却下しました',
  saveDone: (name) => `✅ プリセット「${name}」を保存しました`,
  builtinName: '組み込み',
  builtinSaveBlocked: (name) => `「${name}」は組み込みプリセットです。別の名前を選んでください`,
  duplicateSaveBlocked: (names) => `まったく同じ内容のプリセットがすでにあります: 「${names}」。それを使うか、保存前に設定を変えてください`,
  builtinDeleteBlocked: (name) => `「${name}」は組み込みプリセットのため削除できません`,
  useDone: (name) => `✅ プリセット「${name}」を適用しました`,
  useUnchanged: (name) => `ℹ プリセット「${name}」は現在の設定と同一です`,
  // プリセットには不正な値が混ざりうる（古い値や手編集）。有効な値は通常どおり適用し、
  // 読み飛ばした項目は必ず名指しする。
  usePartial: (name, fields) => `⚠ プリセット「${name}」を一部だけ適用しました。無効なため読み飛ばした項目：${fields}`,
  useAllInvalid: (name, fields) => `✗ プリセット「${name}」に適用できる項目がありません：${fields}`,
  personaMissing: (name) => `プリセット「${name}」はありません`,
  delDone: (name) => `✅ プリセット「${name}」を削除しました`,
  listTitle: '📋 プリセット',
  listEmpty: 'プリセットはまだありません。`/soul save <名前>` で現在の設定を保存できます',
  // 一覧の行には、そのプリセットが実際に何項目の役割を定めているかを出す。
  listCovers: (n) => `${n} 項目を設定`,
  saveUsage: '使い方: /soul save <名前>（1〜30 文字）',
  useUsage: '使い方: /soul use <名前>',
  delUsage: '使い方: /soul del <名前>',
  setUsage: '使い方: /soul set key=value ...（項目: enabled / style / headingLists / emoji / tables / replyLength / language / nickname / occupation / bio / customInstructions / trailEnabled / trailColor / trailSpeed / trailWidth）',
  unknownField: '不明な項目です',
  invalidBoolean: (key, value) => `${key}: true または false を期待しました（受け取った値：${JSON.stringify(value)}）`,
  setNoChanges: '適用する変更はありません',
  setDone: (keys) => `✅ 更新しました：${keys.join('、')}`,
  help: '詳細は /soul show\n項目を変更する — /soul set style=humorous\nプリセット — /soul save <名前> / use <名前> / list / del <名前>\n提案された役割の承認・却下 — /soul confirm または /soul reject\nリセット — /soul reset\n有効・無効の切り替え — /soul enable / disable\nニックネームを設定 — /soul <ニックネーム>',
  resetDone: '✅ 設定を既定値に戻しました',
  resetRecovered: (file) => `✅ 設定を既定値に戻しました（破損していたファイルは ${file} として保存しました）`,
  // ベンダーの `/soul show` は `${label}${colon}${value}` と連結するが、en / zh では
  // deliveryLabel 側にすでにコロンが付いている（そのため en / zh では二重コロンになる）。
  // ja ではコロンを付けないラベルにして、この不具合を踏襲しない。
  deliveryLabel: '配信',
  deliveryOk: (delivered, total) => total === 0
    ? '稼働中のセッションはありません（設定は新しいセッションで反映されます）'
    : `稼働中のセッションへ設定を配信しました：${delivered} / ${total}`,
  deliveryNoAgentsService: '`agents` サービスが利用できないため、新しい設定はシステムプロンプトのセクション経由でのみ伝わります。そのため新しいセッションでのみ反映される可能性があります',
  deliveryInjectFailed: (detail) => `稼働中のセッションへの注入に失敗しました：${detail}`,
  enableDone: '✅ パーソナライズを有効にしました',
  disableDone: '✅ パーソナライズを無効にしました',
  nicknameDone: (n) => `✅ ニックネームを設定しました：${n}`,
  failed: (e) => `実行できませんでした：${e}`
}
