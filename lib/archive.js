/**
 * dsh-context-archive — pure logic: pointer block, transcript rendering,
 * index/meta bookkeeping, park-range selection.
 *
 * No Cordis/DSH imports here, so this module is unit-testable in isolation
 * (`node --test test/`). The runtime glue lives in `./index.js`.
 *
 * Layout produced inside the session workspace:
 *
 *   docs/context-archive/index.md          newest-first index, capped
 *   docs/context-archive/index-archive.md  entries rotated out of index.md
 *   docs/context-archive/meta.json         machine bookkeeping (watermark source)
 *   docs/context-archive/segments/0007-<compactionId>.md
 */

/** Marker pair identifying the one-line pointer installed in AGENTS.md. */
export const POINTER_START = '<!-- dsh-context-archive:pointer -->'
export const POINTER_END = '<!-- /dsh-context-archive:pointer -->'

export const INDEX_FILE = 'index.md'
export const INDEX_ARCHIVE_FILE = 'index-archive.md'
export const META_FILE = 'meta.json'
export const SEGMENTS_DIR = 'segments'

/** Surface event types worth keeping in an archived transcript. */
const TRANSCRIPT_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result'])

/** Join the text blocks of one message, labelling non-text blocks. */
export function blocksToText(blocks, { maxChars = Infinity } = {}) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'image') {
      parts.push('[image]')
    } else if (block.type === 'file') {
      parts.push('[file' + (typeof block.path === 'string' ? ': ' + block.path : '') + ']')
    } else if (typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return clampText(parts.join('\n'), maxChars)
}

/** Truncate to `maxChars` code points, appending an explicit omission marker. */
export function clampText(text, maxChars = Infinity) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (!Number.isFinite(maxChars) || maxChars <= 0) return value
  const points = Array.from(value)
  if (points.length <= maxChars) return value
  return points.slice(0, maxChars).join('') + `\n\n[... ${points.length - maxChars} more characters omitted by dsh-context-archive]`
}

/**
 * Truncate to `maxChars` code points with a plain ellipsis.
 *
 * For one-line digests: the {@link clampText} omission marker is a full
 * sentence that would break a single-line index entry, so digests end in `…`.
 */
export function truncate(text, maxChars = Infinity) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (!Number.isFinite(maxChars) || maxChars <= 0) return value
  const points = Array.from(value)
  if (points.length <= maxChars) return value
  return points.slice(0, Math.max(1, maxChars - 1)).join('') + '…'
}

/**
 * Render the archived span of the session log as markdown.
 *
 * Reads the log (not the surface), so a span that compaction already shadowed
 * is still archived in full — that is what makes crash recovery lossless.
 *
 * @param events - session events in log order.
 * @param options - tool-output cap.
 * @returns markdown transcript; excluded event types produce nothing.
 */
export function renderTranscript(events, { maxToolChars = 2000 } = {}) {
  const list = Array.isArray(events) ? events : []
  const callNames = new Map()
  for (const event of list) {
    if (event?.type === 'tool/call' && typeof event.data?.callId === 'string') {
      callNames.set(event.data.callId, event.data.name)
    }
  }
  const chunks = []
  for (const event of list) {
    if (event === null || typeof event !== 'object') continue
    if (!TRANSCRIPT_TYPES.has(event.type)) continue
    const data = event.data ?? {}
    if (event.type === 'user/message') {
      // `user/message` carries the message as the event data itself (unlike
      // developer/system/assistant/tool, which nest it under `data.message`).
      const message = data
      const source = message.source ?? {}
      const kind = typeof source.kind === 'string' ? source.kind : ''
      const label = kind.startsWith('plugin:') ? kind : 'user'
      const text = blocksToText(message.content)
      if (text.trim().length === 0) continue
      chunks.push(`### [${event.seq}] ${label}\n\n${text}`)
    } else if (event.type === 'assistant/message') {
      const text = blocksToText(data.message?.content)
      if (text.trim().length === 0) continue
      chunks.push(`### [${event.seq}] assistant\n\n${text}`)
    } else if (event.type === 'tool/call') {
      chunks.push(`### [${event.seq}] tool-call ${data.name ?? 'unknown'}\n\n\`\`\`json\n${clampText(data.arguments ?? '', maxToolChars)}\n\`\`\``)
    } else if (event.type === 'tool/result') {
      const name = callNames.get(data.message?.toolCallId ?? data.callId) ?? 'tool'
      const text = blocksToText(data.message?.content, { maxChars: maxToolChars })
      const flag = data.message?.isError === true ? ' (error)' : ''
      chunks.push(`### [${event.seq}] tool-result ${name}${flag}\n\n${text}`)
    }
  }
  return chunks.join('\n\n')
}

/** Human-readable UTC stamp for index entries. */
export function formatTime(ms) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}Z`
}

/** Compact token figure: 96400 -> "96.4k". */
export function formatTokens(count) {
  const value = Number(count)
  if (!Number.isFinite(value) || value < 0) return '?'
  if (value < 1000) return String(Math.round(value))
  return (value / 1000).toFixed(1) + 'k'
}

/** Zero-padded segment file name; the compactionId makes archival idempotent. */
export function segmentFileName(parkNumber, compactionId) {
  const id = String(compactionId ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'unknown'
  return `${String(parkNumber).padStart(4, '0')}-${id}.md`
}

/** The one sentence installed (once) in AGENTS.md. */
export function pointerSentence(dir) {
  return `早期对话会归档到 \`${dir}/\`：需要回忆先前工作、或不确定上下文是否完整时，先读 \`${dir}/index.md\` 定位，再按需 grep/read \`${dir}/segments/\` 下对应文件。`
}

/**
 * The message that REPLACES the archived span on the model-visible surface.
 *
 * It is the model's only in-context evidence that its history moved, so it
 * states where the archive is, what the index is, and how to read it back.
 *
 * @param meta - `{ dir, file, turnFrom, turnTo, hasSummary }`.
 * @returns the pointer text.
 */
export function renderPointerMessage({ dir, file, turnFrom, turnTo, hasSummary }) {
  return [
    `早期上下文已归档（turn ${turnFrom ?? '?'}–${turnTo ?? '?'}），本会话继续。`,
    `- 归档文件：\`${dir}/${SEGMENTS_DIR}/${file}\``,
    `- 索引：\`${dir}/${INDEX_FILE}\`（新条目在前）`,
    hasSummary
      ? '- 归档文件的「摘要」一节就是这次归档的压缩摘要，可直接读。'
      : '- 本次未消费压缩摘要，归档文件的「原文」一节有完整内容。',
    '需要回忆细节时：先读索引定位，再 grep/read 对应 segment；不要凭记忆断言已归档的内容。',
  ].join('\n')
}

/**
 * Install or verify the pointer block.
 *
 * Write-once semantics: an existing block whose directory still matches is
 * never rewritten (hand edits survive); only an explicit directory change
 * replaces it.
 *
 * @param text - current AGENTS.md content.
 * @param dir - configured archive directory.
 * @returns next content and the action taken.
 */
export function ensurePointerBlock(text, dir) {
  const current = typeof text === 'string' ? text : ''
  const block = `${POINTER_START}\n${pointerSentence(dir)}\n${POINTER_END}`
  const start = current.indexOf(POINTER_START)
  if (start === -1) {
    const separator = current.length === 0 || current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n'
    return { text: current + separator + block + '\n', action: 'added' }
  }
  const end = current.indexOf(POINTER_END, start)
  if (end === -1) return { text: current, action: 'unterminated' }
  const existing = current.slice(start, end + POINTER_END.length)
  if (existing.includes(`${dir}/`) || existing.includes(dir)) return { text: current, action: 'unchanged' }
  return { text: current.slice(0, start) + block + current.slice(end + POINTER_END.length), action: 'updated' }
}

/** Render one index entry: heading, one-line digest, pointer to the segment. */
export function renderIndexEntry(meta) {
  const range = `turn ${meta.turnFrom ?? '?'}–${meta.turnTo ?? '?'}`
  const size = `${formatTokens(meta.tokensBefore)}→${formatTokens(meta.tokensAfter)}`
  const head = `## park #${meta.parkNumber} — ${formatTime(meta.time)} — ${range} — ${size}`
  const line = meta.indexLine && meta.indexLine.trim().length > 0 ? meta.indexLine.trim() : '(摘要见 segment 文件)'
  return `${head}\n${line}\n→ \`${SEGMENTS_DIR}/${meta.file}\``
}

/** Header used by both index files. */
export function indexHeader() {
  return '# Context archive index\n\n每次自动 park 一条，新条目在前。定位到某次后，按 `segments/` 下的文件读全文。'
}

/**
 * Prepend one entry, rotating the oldest entries past `maxEntries` out.
 * @returns next index text and the overflow text (empty when nothing rotated).
 */
export function insertIndexEntry(indexText, entry, { maxEntries = 150 } = {}) {
  const current = typeof indexText === 'string' && indexText.trim().length > 0 ? indexText : indexHeader() + '\n'
  const headerEnd = current.search(/^## park #/m)
  const header = (headerEnd === -1 ? current : current.slice(0, headerEnd)).trimEnd()
  const body = headerEnd === -1 ? '' : current.slice(headerEnd)
  const entries = body
    .split(/^(?=## park #)/m)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const all = [entry, ...entries]
  const kept = all.slice(0, Math.max(1, maxEntries))
  const overflow = all.slice(Math.max(1, maxEntries))
  const text = `${header}\n\n${kept.join('\n\n')}\n`
  const overflowText = overflow.length === 0 ? '' : `${overflow.join('\n\n')}\n`
  return { text, overflowText }
}

/** Render the archived segment file. */
export function renderSegment({ meta, summary, transcript }) {
  const range = `turn ${meta.turnFrom ?? '?'}–${meta.turnTo ?? '?'} / seq ${meta.rangeStartSeq ?? meta.startSeq}–${meta.rangeEndSeq ?? meta.endSeq}`
  const removed = meta.replacedTokens ?? meta.tokensBefore
  const after = Number(meta.tokensAfter)
  const context = Number.isFinite(after)
    ? `${formatTokens(meta.tokensBefore)} → ${formatTokens(after)} tokens`
    : `${formatTokens(meta.tokensBefore)} tokens（归档后水位见 meta.json / index.md）`
  const cap = Number(meta.maxToolChars)
  const coverage = Number.isFinite(cap) && cap > 0
    ? `对话原文全量；工具输出按 maxToolChars=${cap} 截断`
    : '本文件为全量文本，未裁剪'
  const lines = [
    `# park #${meta.parkNumber} — ${new Date(meta.time).toISOString()}`,
    '',
    `- session: ${meta.sessionId}`,
    `- compactionId: ${meta.compactionId ?? '(none)'}`,
    `- 范围: ${range}（本次移出 ${formatTokens(removed)} tokens）`,
    `- 上下文: ${context}`,
    `- 覆盖事件: ${meta.eventCount} 条（${coverage}）`,
    '',
    '## 摘要',
    '',
    summary && summary.trim().length > 0 ? summary.trim() : '(本次压缩未产出摘要文本)',
    '',
    '## 原文',
    '',
    transcript && transcript.trim().length > 0 ? transcript : '(该范围内没有可读的对话事件)',
  ]
  return lines.join('\n') + '\n'
}

/** Parse meta.json defensively; a corrupt file degrades to an empty list. */
export function parseMeta(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter((row) => row !== null && typeof row === 'object') : []
  } catch {
    return []
  }
}

/** Serialize meta rows (newest first, bounded by the caller). */
export function serializeMeta(rows) {
  return JSON.stringify(Array.isArray(rows) ? rows : [], null, 2) + '\n'
}

/** Highest archived `endSeq` for one session; the compaction watermark. */
export function lastParkSeq(rows, sessionId) {
  let watermark = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.sessionId !== sessionId) continue
    const value = Number(row.endSeq)
    if (Number.isFinite(value) && value > watermark) watermark = value
  }
  return watermark
}

/** Next park number for a session (1-based). */
export function nextParkNumber(rows, sessionId) {
  let highest = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.sessionId !== sessionId) continue
    const value = Number(row.parkNumber)
    if (Number.isFinite(value) && value > highest) highest = value
  }
  return highest + 1
}

/**
 * Compactions recorded after the watermark and therefore not yet archived.
 *
 * `summary` travels with each row: it is the summary the compaction engine
 * already produced and paid for, so parking never needs a second LLM call.
 *
 * @returns rows of `{ seq, compactionId, summary, shadowedSeqs, shadowedTokenCount }`, log order.
 */
export function unarchivedCompactions(events, watermark) {
  const list = Array.isArray(events) ? events : []
  return list
    .filter((event) => event?.type === 'compaction/summary' && Number(event.seq) > Number(watermark ?? 0))
    .map((event) => ({
      seq: event.seq,
      compactionId: event.data?.compactionId,
      summary: Array.isArray(event.data?.summary) ? event.data.summary : [],
      shadowedSeqs: Array.isArray(event.data?.shadowedSeqs) ? event.data.shadowedSeqs : [],
      shadowedTokenCount: event.data?.shadowedTokenCount,
    }))
}

/**
 * Walk `from` back to the nearest preceding `turn/start`, so an archived
 * window begins at a turn boundary and the entry can name its turns.
 *
 * @param events - session events in log order.
 * @param from - inclusive seq the window would otherwise start at.
 * @returns the adjusted inclusive start seq.
 */
export function extendToTurnBoundary(events, from) {
  const start = Number(from)
  if (!Number.isFinite(start)) return from
  let boundary = start
  for (const event of Array.isArray(events) ? events : []) {
    const seq = Number(event?.seq)
    if (!Number.isFinite(seq)) continue
    if (seq > start) break
    if (event.type === 'turn/start' && seq <= start) boundary = seq
  }
  return boundary
}

/**
 * Whether the log's tail sits inside an unclosed compaction bracket.
 *
 * Compaction brackets its whole operation with `compaction/start` …
 * `compaction/end`. A start with no later end means one is in flight — but a
 * start orphaned by a crash would otherwise block every future park, so only a
 * bracket opened within the last few events counts as live. (The caller also
 * re-validates its range immediately before mutating, so a false negative is
 * still caught.)
 *
 * @param events - session events in log order.
 * @param options - `withinTail`: how recent an open bracket must be to count.
 * @returns true when a compaction transaction looks live right now.
 */
export function compactionInFlight(events, { withinTail = 10 } = {}) {
  const list = Array.isArray(events) ? events : []
  let open = -1
  for (let index = 0; index < list.length; index += 1) {
    const type = list[index]?.type
    if (type === 'compaction/start') open = index
    else if (type === 'compaction/end') open = -1
  }
  if (open === -1) return false
  return list.length - open <= Math.max(1, withinTail)
}

/** Inclusive seq window covering the current range plus every unarchived shadow. */
export function archiveWindow(rangeSeqs, compactions) {
  const values = []
  for (const seq of Array.isArray(rangeSeqs) ? rangeSeqs : []) values.push(Number(seq))
  for (const row of Array.isArray(compactions) ? compactions : []) {
    for (const seq of row?.shadowedSeqs ?? []) values.push(Number(seq))
  }
  const finite = values.filter((value) => Number.isFinite(value))
  if (finite.length === 0) return null
  return { from: Math.min(...finite), to: Math.max(...finite) }
}

/**
 * Choose the surface range to replace: from the first non-system node, keeping
 * `retainTailNodes` newest nodes verbatim, shrinking from the end until both
 * edges are balanced.
 *
 * @param nodes - current surface seqs in model-visible order.
 * @param options - isSystemHead / balancedBefore / balancedAfter predicates and tail size.
 * @returns `{ start, end, shadowedSeqs }` or null when nothing is parkable.
 */
export function selectParkRange(nodes, { retainTailNodes = 2, isSystemHead, balancedBefore, balancedAfter } = {}) {
  const list = Array.isArray(nodes) ? nodes : []
  if (list.length === 0) return null
  const firstIdx = typeof isSystemHead === 'function' && isSystemHead(list[0]) ? 1 : 0
  let endIdx = list.length - 1 - Math.max(0, retainTailNodes)
  if (endIdx < firstIdx) return null
  const before = typeof balancedBefore === 'function' ? balancedBefore : () => true
  const after = typeof balancedAfter === 'function' ? balancedAfter : () => true
  while (endIdx >= firstIdx) {
    if (after(list[endIdx]) && before(list[firstIdx])) {
      return { start: list[firstIdx], end: list[endIdx], shadowedSeqs: list.slice(firstIdx, endIdx + 1) }
    }
    endIdx -= 1
  }
  return null
}

/**
 * Parse the text a `/park` invocation carries after the command name.
 *
 * Grammar: empty = archive only; `switch` = archive then open a new session on
 * the Host-default preset; `switch <preset>` names the preset for the new
 * session. Anything else is a usage error.
 *
 * @param raw - the invocation's raw input (leading separator whitespace included).
 * @returns `{ action: 'park' }`, `{ action: 'switch', preset }` (preset may be
 * undefined), or `{ action: 'error', text }`.
 */
export function parseParkInput(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0) return { action: 'park' }
  const parts = text.split(/\s+/u)
  if (parts[0] !== 'switch' || parts.length > 2) {
    return { action: 'error', text: '用法：/park（仅归档）或 /park switch [预设id]' }
  }
  return { action: 'switch', preset: parts[1] }
}

/** Build the one-line digest stored in the index from a summary text. */
export function digestFromSummary(summary, { maxChars = 220 } = {}) {
  const text = typeof summary === 'string' ? summary : ''
  const cleaned = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[#>*\-\s]+/, '').trim())
    .filter((line) => line.length > 0)
    .join('；')
  return truncate(cleaned, maxChars)
}

/**
 * Locator digest for a park with no compaction summary to reuse.
 *
 * The full transcript is a poor digest (it is long and starts with tool/event
 * noise), so fall back to what a reader scans for: the first non-empty line of
 * the first few user prompts in the archived window.
 *
 * @param events - window events in log order.
 * @param options - item/line/total character bounds.
 * @returns a single-line digest, `''` when the window has no readable prompt.
 */
export function digestFromEvents(events, { maxItems = 3, perItem = 60, maxChars = 200 } = {}) {
  const parts = []
  for (const event of Array.isArray(events) ? events : []) {
    if (parts.length >= maxItems) break
    if (event === null || typeof event !== 'object' || event.type !== 'user/message') continue
    // `user/message` carries the message as `data`; tolerate the nested shape.
    const content = event.data?.content ?? event.data?.message?.content
    const text = blocksToText(content)
    const line = text
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find((value) => value.length > 0)
    if (line === undefined) continue
    parts.push(truncate(line, perItem))
  }
  return truncate(parts.join('；'), maxChars)
}
