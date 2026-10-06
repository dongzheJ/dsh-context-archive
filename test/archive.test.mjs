import assert from 'node:assert/strict'
import test from 'node:test'
import {
  POINTER_START,
  archiveWindow,
  blocksToText,
  compactionInFlight,
  digestFromEvents,
  digestFromSummary,
  ensurePointerBlock,
  extendToTurnBoundary,
  insertIndexEntry,
  lastParkSeq,
  nextParkNumber,
  parseMeta,
  renderIndexEntry,
  renderPointerMessage,
  renderSegment,
  renderTranscript,
  segmentFileName,
  selectParkRange,
  serializeMeta,
  truncate,
  unarchivedCompactions,
} from '../lib/archive.js'

const DIR = 'docs/context-archive'

test('pointer block is added once and never rewritten', () => {
  const first = ensurePointerBlock('# AGENTS.md\n\n规则。\n', DIR)
  assert.equal(first.action, 'added')
  assert.ok(first.text.includes(POINTER_START))
  assert.ok(first.text.includes(`${DIR}/index.md`))

  const second = ensurePointerBlock(first.text, DIR)
  assert.equal(second.action, 'unchanged')
  assert.equal(second.text, first.text)

  // A hand edit inside the block must survive.
  const edited = first.text.replace('先读', '务必先读')
  assert.equal(ensurePointerBlock(edited, DIR).action, 'unchanged')
  assert.equal(ensurePointerBlock(edited, DIR).text, edited)
})

test('pointer block is replaced only when the directory changes', () => {
  const first = ensurePointerBlock('# AGENTS.md\n', DIR)
  const moved = ensurePointerBlock(first.text, 'archive/ctx')
  assert.equal(moved.action, 'updated')
  assert.ok(moved.text.includes('archive/ctx/index.md'))
  assert.ok(!moved.text.includes('docs/context-archive'))
  assert.equal(moved.text.match(/context-archive:pointer/g).length, 2)
})

test('selectParkRange skips the system head and keeps the tail verbatim', () => {
  const nodes = [10, 11, 12, 13, 14, 15]
  const range = selectParkRange(nodes, {
    retainTailNodes: 2,
    isSystemHead: (seq) => seq === 10,
    balancedBefore: () => true,
    balancedAfter: () => true,
  })
  assert.deepEqual(range, { start: 11, end: 13, shadowedSeqs: [11, 12, 13] })
})

test('selectParkRange shrinks from the end until the range is balanced', () => {
  const nodes = [10, 11, 12, 13, 14, 15]
  const range = selectParkRange(nodes, {
    retainTailNodes: 1,
    isSystemHead: () => false,
    balancedBefore: () => true,
    balancedAfter: (seq) => seq <= 13,
  })
  assert.equal(range.end, 13)
})

test('selectParkRange returns null when nothing is parkable', () => {
  assert.equal(selectParkRange([10], { isSystemHead: () => true }), null)
  assert.equal(selectParkRange([10, 11], { retainTailNodes: 2, isSystemHead: () => false }), null)
  assert.equal(selectParkRange([], {}), null)
})

test('watermark excludes the park\'s own compaction and heals crashed archives', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'compaction/summary', seq: 40, data: { compactionId: 'c1', shadowedSeqs: [11, 12] } },
    { type: 'compaction/end', seq: 42, data: { turn: 1 } },
    { type: 'compaction/summary', seq: 80, data: { compactionId: 'c2', shadowedSeqs: [50, 51] } },
  ]
  assert.deepEqual(
    unarchivedCompactions(events, 0).map((row) => row.compactionId),
    ['c1', 'c2'],
  )
  // After archiving the first park, its own compaction is behind the watermark.
  assert.deepEqual(
    unarchivedCompactions(events, 42).map((row) => row.compactionId),
    ['c2'],
  )

  const rows = [
    { sessionId: 's1', endSeq: 42, parkNumber: 1 },
    { sessionId: 's1', endSeq: 90, parkNumber: 2 },
    { sessionId: 's2', endSeq: 12, parkNumber: 1 },
  ]
  assert.equal(lastParkSeq(rows, 's1'), 90)
  assert.equal(lastParkSeq(rows, 's2'), 12)
  assert.equal(lastParkSeq(rows, 's3'), 0)
  assert.equal(nextParkNumber(rows, 's1'), 3)
  assert.equal(nextParkNumber(rows, 's3'), 1)

  // The window covers the current range plus every unarchived shadow.
  const window = archiveWindow([100, 101, 102], unarchivedCompactions(events, 42))
  assert.deepEqual(window, { from: 50, to: 102 })
  assert.equal(archiveWindow([], []), null)
})

test('index entries prepend and rotate into the overflow shard', () => {
  const meta = (n) => ({
    parkNumber: n,
    time: Date.UTC(2026, 9, 5, 14, 30),
    turnFrom: 10 * n,
    turnTo: 10 * n + 5,
    tokensBefore: 96400,
    tokensAfter: 12100,
    file: segmentFileName(n, `cid${n}`),
    indexLine: `第 ${n} 次归档的摘要`,
  })
  let text = ''
  let overflow = ''
  for (let n = 1; n <= 3; n += 1) {
    const result = insertIndexEntry(text, renderIndexEntry(meta(n)), { maxEntries: 2 })
    text = result.text
    if (result.overflowText.length > 0) overflow += result.overflowText
  }
  assert.ok(text.indexOf('park #3') < text.indexOf('park #2'))
  assert.ok(!text.includes('park #1'))
  assert.ok(overflow.includes('park #1'))
  assert.ok(text.includes('96.4k→12.1k'))
  assert.ok(text.includes('segments/0003-cid3.md'))
})

test('renderTranscript keeps dialogue and caps tool output', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { role: 'user', content: [{ type: 'text', text: '把日志改成 JSON' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 3, data: { message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } } },
    { type: 'tool/call', seq: 4, data: { callId: 't1', name: 'bash', arguments: '{"command":"ls"}' } },
    { type: 'tool/result', seq: 5, data: { message: { role: 'tool', toolCallId: 't1', content: [{ type: 'text', text: 'x'.repeat(50) }] } } },
    { type: 'user/message', seq: 6, data: { role: 'user', content: [{ type: 'text', text: '早期上下文已归档' }], source: { kind: 'plugin:context-archive' } } },
    { type: 'request/header', seq: 7, data: {} },
    { type: 'compaction/summary', seq: 8, data: {} },
  ]
  const text = renderTranscript(events, { maxToolChars: 10 })
  // user/message carries the message as `data` itself; it must not be dropped.
  assert.ok(text.includes('### [2] user\n\n把日志改成 JSON'))
  assert.ok(text.includes('### [6] plugin:context-archive'))
  assert.ok(text.includes('tool-call bash'))
  assert.ok(text.includes('tool-result bash'))
  assert.ok(text.includes('more characters omitted'))
  assert.ok(!text.includes('request/header'))
  assert.ok(!text.includes('compaction'))
})

test('segment rendering and summary digest', () => {
  const meta = {
    parkNumber: 7,
    sessionId: 'session-ab12',
    compactionId: 'a1b2c3d4',
    time: Date.UTC(2026, 9, 5, 14, 30, 12),
    startSeq: 512,
    endSeq: 1043,
    turnFrom: 41,
    turnTo: 78,
    tokensBefore: 96400,
    tokensAfter: 12100,
    eventCount: 532,
    maxToolChars: 2000,
    file: segmentFileName(7, 'a1b2c3d4'),
  }
  const segment = renderSegment({ meta, summary: '## 目标\n给会话加归档\n\n## 下一步\n补测试', transcript: '### [2] user\n\n你好' })
  assert.ok(segment.includes('park #7'))
  assert.ok(segment.includes('turn 41–78 / seq 512–1043'))
  assert.ok(segment.includes('## 摘要'))
  assert.ok(segment.includes('## 原文'))
  assert.equal(segmentFileName(7, 'a1b2c3d4'), '0007-a1b2c3d4.md')
  assert.equal(segmentFileName(1, 'x/y:z'), '0001-xyz.md')
  assert.equal(digestFromSummary('## 目标\n给会话加归档\n\n- 下一步：补测试', { maxChars: 500 }), '目标；给会话加归档；下一步：补测试')

  // The segment is written before the surface commit, so the post-archive
  // token figure may not exist yet: the renderer must degrade, not print "?".
  const draft = renderSegment({ meta: { ...meta, tokensAfter: undefined }, summary: '', transcript: '' })
  assert.ok(draft.includes('上下文: 96.4k tokens（'))
  assert.ok(!draft.includes('96.4k → ?'))

  // Coverage wording reflects the tool-output cap instead of claiming total fidelity.
  assert.ok(segment.includes('工具输出按 maxToolChars=2000 截断'))
  assert.ok(!segment.includes('未裁剪'))
})

test('digests stay single-line: no clampText omission marker', () => {
  // A long summary must end in an ellipsis, not in the multi-line marker.
  const long = digestFromSummary('x'.repeat(500), { maxChars: 50 })
  assert.equal(long.length, 50)
  assert.ok(long.endsWith('…'))
  assert.ok(!long.includes('more characters omitted'))
  assert.ok(!long.includes('\n'))

  // No whitespace to trim: the marker text would otherwise leak into index.md.
  const clean = digestFromSummary('## 标题\n正文一\n\n- 正文二', { maxChars: 200 })
  assert.equal(clean, '标题；正文一；正文二')
})

test('digestFromEvents locates a park by its user prompts', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '忽略我' }] } } },
    { type: 'user/message', seq: 3, data: { role: 'user', content: [{ type: 'text', text: '第一句\n第一句的后半' }] } },
    { type: 'user/message', seq: 4, data: { message: { content: [{ type: 'text', text: '第二句（嵌套形状也要认）' }] } } },
    { type: 'user/message', seq: 5, data: { role: 'user', content: [{ type: 'text', text: '第三句' }] } },
    { type: 'user/message', seq: 6, data: { role: 'user', content: [{ type: 'text', text: '第四句（超上限被丢弃）' }] } },
  ]
  const digest = digestFromEvents(events, { maxItems: 3 })
  assert.equal(digest, '第一句；第二句（嵌套形状也要认）；第三句')
  assert.ok(!digest.includes('忽略我'))
  assert.ok(!digest.includes('第四句'))
  assert.equal(digestFromEvents([{ type: 'turn/start', data: {} }]), '')
  assert.equal(digestFromEvents([]), '')
  // Per-item truncation is a plain ellipsis.
  assert.equal(digestFromEvents(events, { maxItems: 1, perItem: 2 }), '第…')
})

test('truncate is code-point safe and marker-free', () => {
  assert.equal(truncate('abcdef', 4), 'abc…')
  assert.equal(truncate('abc', 4), 'abc')
  assert.equal(truncate('abc', Infinity), 'abc')
  assert.equal(truncate('😀😀😀', 2), '😀…')
})

test('meta parsing survives corruption and block text degrades gracefully', () => {
  assert.deepEqual(parseMeta(''), [])
  assert.deepEqual(parseMeta('{ not json'), [])
  assert.deepEqual(parseMeta('{"a":1}'), [])
  assert.equal(parseMeta(serializeMeta([{ a: 1 }]))[0].a, 1)
  assert.equal(blocksToText([{ type: 'text', text: 'hi' }, { type: 'image' }, { type: 'file', path: 'a.png' }]), 'hi\n[image]\n[file: a.png]')
  assert.equal(blocksToText(undefined), '')
})

test('compaction bracket: live tail blocks, ancient orphan does not', () => {
  assert.equal(compactionInFlight([]), false)
  assert.equal(compactionInFlight([{ type: 'compaction/start' }, { type: 'compaction/end' }]), false)
  assert.equal(compactionInFlight([{ type: 'compaction/end' }, { type: 'compaction/start' }]), true)
  // An orphaned start followed by a long stretch of normal events is stale.
  const stale = [{ type: 'compaction/start' }, ...Array.from({ length: 12 }, () => ({ type: 'user/message' }))]
  assert.equal(compactionInFlight(stale), false)
  assert.equal(compactionInFlight(stale, { withinTail: 20 }), true)
})

test('pointer message states where the archive is and how to read it', () => {
  const text = renderPointerMessage({ dir: 'docs/context-archive', file: '0007-a1b2c3d4.md', turnFrom: 41, turnTo: 78, hasSummary: true })
  assert.ok(text.includes('turn 41–78'))
  assert.ok(text.includes('docs/context-archive/segments/0007-a1b2c3d4.md'))
  assert.ok(text.includes('docs/context-archive/index.md'))
  assert.ok(text.includes('压缩摘要'))
  assert.ok(text.includes('不要凭记忆'))
  const withoutSummary = renderPointerMessage({ dir: 'd', file: 'f.md', hasSummary: false })
  assert.ok(withoutSummary.includes('turn ?–?'))
  assert.ok(withoutSummary.includes('原文'))
})

test('unarchived compactions carry the summary compaction already paid for', () => {
  const events = [
    { type: 'compaction/summary', seq: 7, data: { compactionId: 'c1', summary: [{ type: 'text', text: '摘要正文' }], shadowedSeqs: [2, 3] } },
  ]
  const rows = unarchivedCompactions(events, 0)
  assert.equal(rows[0].compactionId, 'c1')
  assert.equal(blocksToText(rows[0].summary), '摘要正文')
  assert.deepEqual(rows[0].shadowedSeqs, [2, 3])
})

test('window start extends back to the enclosing turn boundary', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 5 } },
    { type: 'user/message', seq: 2, data: {} },
    { type: 'turn/start', seq: 9, data: { turn: 6 } },
    { type: 'user/message', seq: 10, data: {} },
  ]
  assert.equal(extendToTurnBoundary(events, 10), 9)
  assert.equal(extendToTurnBoundary(events, 5), 1)
  assert.equal(extendToTurnBoundary(events, 0), 0)
})
