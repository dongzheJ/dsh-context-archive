/**
 * dsh-context-archive — Cordis plugin (host plane).
 *
 * Strategy: once the session's own compaction has fired N times
 * (`parkAfterCompactions`, default 3), archive the compacted span — the
 * summaries the compaction engine already produced, plus the full transcript
 * read back out of the append-only log — into the session workspace, replace
 * that span on the model-visible surface with a single pointer message, and
 * keep one write-once pointer line in AGENTS.md.
 *
 * Why it does NOT use `ctx.compaction`: in the Web/Desktop composition the
 * compaction engine is mounted inside a realm owned by each agent preset
 * (`isolate: { compaction: true }`), so a host-plane plugin can never inject
 * it. Everything here therefore runs on host-plane services only — `fs`,
 * `sessions`, an optional `tokenMeter`, and an optional `commands`
 * registration — and the replacement is an ordinary surface `replace`.
 *
 * Properties that follow from that:
 *   - no extra LLM call: the summary is the one compaction already wrote;
 *   - no data-loss window: the archive is rendered from the append-only log,
 *     so a crash before the files land is repaired by the next park;
 *   - the human transcript is unaffected: it reads append-origin events, so
 *     the UI still shows the whole conversation while the model sees the
 *     pointer.
 *
 * @module dsh-context-archive
 */
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import {
  INDEX_ARCHIVE_FILE,
  INDEX_FILE,
  META_FILE,
  SEGMENTS_DIR,
  archiveWindow,
  blocksToText,
  compactionInFlight,
  digestFromEvents,
  digestFromSummary,
  ensurePointerBlock,
  extendToTurnBoundary,
  indexHeader,
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
  unarchivedCompactions,
} from './archive.js'

const name = 'context-archive'

/**
 * Host-plane services only. `compaction` is deliberately absent — see the
 * module doc. `tokenMeter` and `commands` are resolved optionally.
 */
const inject = ['fs', 'sessions']

const Config = z.object({
  /** Archive directory, relative to the session workspace. */
  dir: z.string().default('docs/context-archive').volatile(),
  /** File receiving the one-line pointer (written once). */
  agentsFile: z.string().default('AGENTS.md').volatile(),
  /** Park automatically once the compaction count reaches the threshold. */
  autoPark: z.boolean().default(true).volatile(),
  /** Auto-compactions tolerated before the context is parked. */
  parkAfterCompactions: z.number().default(3).volatile(),
  /** Newest surface nodes kept verbatim (never archived). */
  retainTailNodes: z.number().default(2).volatile(),
  /** Index entries kept in index.md before rotating to the archive shard. */
  indexMaxEntries: z.number().default(150).volatile(),
  /** Per-tool-output character cap inside an archived transcript. */
  maxToolChars: z.number().default(2000).volatile(),
})

const FAILURE_TEXT = {
  'no-session': '没有可归档的会话。',
  busy: '已有一次 park 正在进行，请稍后重试。',
  'nothing-to-park': '当前上下文还没有可归档的内容（历史太短，或只剩保留尾部）。',
  'compaction-active': '压缩通道正忙（日志尾部停在一次未结束的 compaction），请稍后重试。',
  'surface-changed': '会话表面在归档过程中被改写，本次放弃（下一轮会自动重试）。',
}

/** Resolve `rel` under the workspace and refuse to escape it. */
async function resolveInside(ctx, rel, cwd, signal) {
  const target = await ctx.fs.resolve(rel, cwd === undefined ? { signal } : { cwd, signal })
  if (cwd !== undefined) {
    const root = await ctx.fs.resolve('.', { cwd, signal })
    if (!ctx.fs.contains(root, target)) {
      throw new Error(`context-archive: "${rel}" escapes the session workspace`)
    }
  }
  return target
}

/** Read a workspace file, treating a missing file as empty. */
async function readWorkspaceFile(ctx, rel, cwd, signal) {
  const target = await resolveInside(ctx, rel, cwd, signal)
  const info = await ctx.fs.stat(target, signal)
  if (info === undefined) return ''
  return await ctx.fs.readText(target, signal)
}

/**
 * The per-call sandbox policy for a session-scoped mutation.
 *
 * Shipped compositions mount the sandboxed filesystem as `ctx.fs`; its
 * mutations fence against the policy supplied as the fifth `writeText`
 * argument. Omitting it makes the backend fall back to the DEPLOYMENT policy
 * (its default mode plus `process.cwd()` as the workspace root), which denies
 * writes into the session workspace. A backend that does not confine reports
 * `sandboxMode === undefined` and needs no policy.
 */
function sandboxPolicyFor(ctx, session) {
  if (ctx.fs.sandboxMode === undefined) return undefined
  const policy = ctx.get('sandboxPolicy')
  if (policy === undefined) {
    throw new Error('context-archive: the mounted filesystem confines but ctx.sandboxPolicy is missing')
  }
  return policy.resolve(session === undefined ? {} : { session })
}

/** Write a workspace file through the fs seam, fenced by the session policy. */
async function writeWorkspaceFile(ctx, rel, cwd, content, signal, session) {
  const target = await resolveInside(ctx, rel, cwd, signal)
  await ctx.fs.writeText(target, content, undefined, signal, sandboxPolicyFor(ctx, session))
  return target
}

/** Run a tool-pairing predicate, treating a throw as "not balanced". */
function safeBalance(predicate, session, seq) {
  try {
    return predicate(session, seq) === true
  } catch {
    return false
  }
}

/** Route-priced tokens of the surface nodes in `seqs`; undefined without a meter. */
function priceRange(meter, session, seqs) {
  if (meter === null || meter === undefined) return undefined
  try {
    const nodes = meter.measure(session)?.nodes
    if (!Array.isArray(nodes)) return undefined
    const wanted = new Set(seqs)
    let total = 0
    for (const node of nodes) if (wanted.has(node.seq)) total += Number(node.tokens) || 0
    return total
  } catch {
    return undefined
  }
}

/** Whole-surface request tokens; undefined without a meter. */
function measureSurface(meter, session) {
  if (meter === null || meter === undefined) return undefined
  try {
    const value = meter.measure(session)?.surfaceTokens
    return Number.isFinite(value) ? Number(value) : undefined
  } catch {
    return undefined
  }
}

/**
 * Register the `/park` command, the compaction counter, and the auto-park hook.
 * @param ctx - registrant context carrying fs and sessions.
 * @param config - validated plugin configuration.
 */
function apply(ctx, config) {
  // Volatile fields are live references (`.get()`), so a settings edit applies
  // without reloading the plugin.
  const dirOf = () => String(config.dir.get() ?? '').replace(/\/+$/, '')
  const inFlight = new Set()
  const lastAttempt = new Map()
  const pathLocks = new Map()
  let meter = null

  // Optional: the token meter stays on the host plane, but a deployment may
  // mount it later than this plugin. Absent = the archive reports "?" sizes.
  ctx.inject(['tokenMeter'], (scoped) => {
    meter = scoped.tokenMeter
  })

  /** Serialize read-modify-write of one workspace file inside this process. */
  function withPathLock(key, task) {
    const previous = pathLocks.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    pathLocks.set(
      key,
      next.then(
        () => {},
        () => {},
      ),
    )
    return next
  }

  const sub = (rel) => `${dirOf()}/${rel}`

  /** Load the machine bookkeeping rows for this workspace. */
  async function loadMeta(cwd, signal) {
    return parseMeta(await readWorkspaceFile(ctx, sub(META_FILE), cwd, signal))
  }

  /** Install (or verify) the write-once pointer in AGENTS.md. */
  async function ensurePointer(cwd, signal, session) {
    const target = await resolveInside(ctx, config.agentsFile.get(), cwd, signal)
    return await withPathLock(ctx.fs.processPath(target), async () => {
      const info = await ctx.fs.stat(target, signal)
      const current = info === undefined ? '' : await ctx.fs.readText(target, signal)
      const next = ensurePointerBlock(current, dirOf())
      if (next.action === 'unchanged' || next.action === 'unterminated') return next.action
      await ctx.fs.writeText(target, next.text, undefined, signal, sandboxPolicyFor(ctx, session))
      return next.action
    })
  }

  /** Count compactions recorded after this session's archive watermark. */
  async function pendingCompactions(session, signal) {
    const cwd = session.header?.cwd
    const rows = await loadMeta(cwd, signal)
    const watermark = lastParkSeq(rows, session.id)
    return { rows, watermark, pending: unarchivedCompactions(session.snapshotEvents(), watermark) }
  }

  /**
   * Archive the compacted span and replace it on the surface with a pointer.
   * @param target - `{ session }`.
   * @param signal - caller cancellation.
   * @param trigger - `auto` | `manual`, recorded in the index.
   */
  async function park({ session }, signal, trigger) {
    if (session === undefined || session === null) return { ok: false, reason: 'no-session' }
    if (inFlight.has(session.id)) return { ok: false, reason: 'busy' }
    inFlight.add(session.id)
    try {
      const cwd = session.header?.cwd
      const rows = await loadMeta(cwd, signal)
      const watermark = lastParkSeq(rows, session.id)
      const events = session.snapshotEvents()
      if (compactionInFlight(events)) return { ok: false, reason: 'compaction-active' }
      const pending = unarchivedCompactions(events, watermark)

      const pick = () =>
        selectParkRange(session.surface.nodes, {
          retainTailNodes: config.retainTailNodes.get(),
          isSystemHead: (seq) => session.eventAt(seq)?.type === 'system/message',
          balancedBefore: (seq) => safeBalance(toolPairingBalancedBefore, session, seq),
          balancedAfter: (seq) => safeBalance(toolPairingBalancedAfter, session, seq),
        })

      const range = pick()
      if (range === null) return { ok: false, reason: 'nothing-to-park' }

      // The window spans the surface range *and* every shadowed span of the
      // compactions being archived: the log is append-only, so content an
      // earlier compaction shadowed is still readable here.
      const window = archiveWindow(range.shadowedSeqs, pending)
      const windowFrom = window === null ? null : extendToTurnBoundary(events, window.from)
      const windowEvents = windowFrom === null ? [] : session.snapshotEvents(windowFrom, window.to + 1)
      const transcript = renderTranscript(windowEvents, { maxToolChars: config.maxToolChars.get() })
      const turns = windowEvents
        .filter((event) => event.type === 'turn/start')
        .map((event) => Number(event.data?.turn))
        .filter((turn) => Number.isFinite(turn))
      const summary = pending
        .map((row) => blocksToText(row.summary))
        .filter((text) => text.trim().length > 0)
        .join('\n\n---\n\n')

      // Re-derive the range immediately before mutating: if anything rewrote
      // the surface while the reads above were in flight, defer to next turn.
      const confirmed = pick()
      if (confirmed === null || confirmed.start !== range.start || confirmed.end !== range.end) {
        return { ok: false, reason: 'surface-changed' }
      }

      const surfaceBefore = measureSurface(meter, session)
      const replacedTokens = priceRange(meter, session, range.shadowedSeqs)
      const parkNumber = nextParkNumber(rows, session.id)
      const compactionId = pending.at(-1)?.compactionId
      const fileName = segmentFileName(parkNumber, compactionId ?? `seq${range.end}`)
      const meta = {
        parkNumber,
        sessionId: session.id,
        compactionId: compactionId ?? null,
        trigger,
        time: Date.now(),
        rangeStartSeq: range.start,
        rangeEndSeq: range.end,
        // Watermark: everything up to this seq is already archived, so the
        // next park counts only compactions recorded after it.
        endSeq: pending.length > 0 ? Math.max(...pending.map((row) => row.seq)) : watermark,
        turnFrom: turns.length > 0 ? Math.min(...turns) : undefined,
        turnTo: turns.length > 0 ? Math.max(...turns) : undefined,
        tokensBefore: surfaceBefore,
        replacedTokens,
        tokensAfter: undefined,
        eventCount: windowFrom === null ? 0 : window.to - windowFrom + 1,
        maxToolChars: config.maxToolChars.get(),
        archivedCompactionSeqs: pending.map((row) => row.seq),
        file: fileName,
        indexLine: summary.length > 0 ? digestFromSummary(summary) : digestFromEvents(windowEvents),
      }

      const pointerText = renderPointerMessage({
        dir: dirOf(),
        file: fileName,
        turnFrom: meta.turnFrom,
        turnTo: meta.turnTo,
        hasSummary: summary.length > 0,
      })

      // Fail before mutating anything if the deployment confines writes but no
      // policy is reachable; the segment write below would deny anyway.
      const policy = sandboxPolicyFor(ctx, session)

      // Durable payload FIRST: the segment is the model's only route back to the
      // archived span, so it must exist before the surface pointer can name it.
      // The post-archive token figure is filled in by meta.json / index.md below.
      await writeWorkspaceFile(ctx, sub(`${SEGMENTS_DIR}/${fileName}`), cwd, renderSegment({ meta, summary, transcript }), signal, session)

      // Commit point: replace the archived span on the model-visible surface.
      session.append(
        'user/message',
        createUserMessage({
          content: [{ type: 'text', text: pointerText }],
          source: {
            kind: 'plugin:context-archive',
            form: 'snapshot',
            sections: [{ name: 'context-archive:pointer', text: pointerText }],
          },
        }),
        {
          surfaceOp: { op: 'replace', startSeq: range.start, endSeq: range.end },
          sourceEventSeqs: [...range.shadowedSeqs],
        },
      )
      meta.tokensAfter = measureSurface(meter, session)

      const metaTarget = await resolveInside(ctx, sub(META_FILE), cwd, signal)
      const indexTarget = await resolveInside(ctx, sub(INDEX_FILE), cwd, signal)
      const overflowTarget = await resolveInside(ctx, sub(INDEX_ARCHIVE_FILE), cwd, signal)

      await withPathLock(ctx.fs.processPath(metaTarget), async () => {
        const fresh = await loadMeta(cwd, signal)
        const deduped = fresh.filter((row) => row.file !== meta.file)
        await ctx.fs.writeText(metaTarget, serializeMeta([meta, ...deduped].slice(0, 500)), undefined, signal, policy)
      })

      await withPathLock(ctx.fs.processPath(indexTarget), async () => {
        const info = await ctx.fs.stat(indexTarget, signal)
        const current = info === undefined ? indexHeader() + '\n' : await ctx.fs.readText(indexTarget, signal)
        const { text, overflowText } = insertIndexEntry(current, renderIndexEntry(meta), { maxEntries: config.indexMaxEntries.get() })
        await ctx.fs.writeText(indexTarget, text, undefined, signal, policy)
        if (overflowText.length > 0) {
          const overflowInfo = await ctx.fs.stat(overflowTarget, signal)
          const existing = overflowInfo === undefined ? indexHeader() + '\n\n' : await ctx.fs.readText(overflowTarget, signal)
          await ctx.fs.writeText(overflowTarget, existing.trimEnd() + '\n\n' + overflowText, undefined, signal, policy)
        }
      })

      const pointerAction = await ensurePointer(cwd, signal, session)
      await ctx.sessions.flush(session)
      lastAttempt.delete(session.id)
      return {
        ok: true,
        fileName,
        path: `${dirOf()}/${SEGMENTS_DIR}/${fileName}`,
        parkNumber,
        turnFrom: meta.turnFrom,
        turnTo: meta.turnTo,
        tokensBefore: meta.tokensBefore,
        replacedTokens: meta.replacedTokens,
        tokensAfter: meta.tokensAfter,
        pointerAction,
        archived: pending.length,
      }
    } catch (error) {
      return { ok: false, reason: 'error', message: error?.message ?? String(error) }
    } finally {
      inFlight.delete(session.id)
    }
  }

  /** Auto-park when the threshold is reached; never throws into the loop. */
  async function maybeAutoPark(agent, signal) {
    if (!config.autoPark.get()) return
    const session = agent?.session
    if (session === undefined) return
    const cooldownUntil = lastAttempt.get(session.id) ?? 0
    if (Date.now() < cooldownUntil) return
    try {
      const { pending } = await pendingCompactions(session, signal)
      if (pending.length < Math.max(1, config.parkAfterCompactions.get())) return
      const outcome = await park({ session }, signal, 'auto')
      if (!outcome.ok) lastAttempt.set(session.id, Date.now() + 30_000)
    } catch {
      lastAttempt.set(session.id, Date.now() + 30_000)
    }
  }

  ctx.on(
    'agent/pre-step',
    async ({ agent, step, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      // Only at a turn's first step: the threshold is a coarse policy, and this
      // keeps the per-step cost at zero for the rest of the turn.
      if (step === 1) await maybeAutoPark(agent, signal)
      return decision
    },
    { prepend: true },
  )

  // Optional: the command runtime is host-plane, but a minimal profile may not
  // mount it. Without it, auto-park still works.
  ctx.inject(['commands'], (scoped) => {
    scoped.effect(
      () =>
        scoped.commands.register({
          name: 'park',
          description: '把压缩过的上下文归档到工作区，并用指针替换历史（dsh-context-archive）',
          handler: async (invocation) => {
            const outcome = await park({ session: invocation.agent?.session }, invocation.signal, 'manual')
            if (outcome.ok) {
              const size = outcome.replacedTokens === undefined ? '' : `，移出 ${Math.round(outcome.replacedTokens)} tokens`
              return {
                kind: 'success',
                text: `已归档 turn ${outcome.turnFrom ?? '?'}–${outcome.turnTo ?? '?'}${size} → ${outcome.path}；历史已替换为指针，指针块 ${outcome.pointerAction}。`,
              }
            }
            const text = outcome.message ?? FAILURE_TEXT[outcome.reason] ?? `park 失败：${outcome.reason}`
            return { kind: 'error', text }
          },
        }),
      'context-archive.park',
    )
  })
}

export { Config, apply, inject, name }
