/**
 * dsh-context-archive — browser half (Web client).
 *
 * Renders the plugin's configuration on the sidebar Plugins page, as a
 * `plugins.bundle.config` section on the `dsh-context-archive` bundle (keyed by
 * the bundle's package name, exactly like `@linxin666/dsh-remote-web-ui`).
 *
 * The settings form is bound LAZILY: the Host names the entry by its profile
 * entry id, which is only known once `configForms.describe()` answers, and
 * `configForms.get()` may throw before then. A delegating scope resolves the
 * entry id from the describe mirror, binds the real form when it appears, and
 * republishes — so a late Host answer cannot leave the card permanently empty.
 *
 * Hand-authored in the browser module format (`window.__ModuleLoader__.load`):
 * no build step.
 */

window.__ModuleLoader__.load({
  id: 'dsh-context-archive',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const jsxRuntime = require('react/jsx-runtime')
    const prim = require('@deepseek-ai/dsh-client-ui-primitives')
    const jsx = jsxRuntime.jsx
    const jsxs = jsxRuntime.jsxs

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-context-archive'
    /** Bundle's package name: the `plugins.bundle.config` cell key. */
    const BUNDLE = 'dsh-context-archive'
    /**
     * Candidate profile entry ids the Host may serve this plugin's form under,
     * most specific first; the delegating scope picks the one the Host reports.
     */
    const ENTRY_IDS = ['context-archive', 'dsh-context-archive']

    /** Text fields the form edits, in display order. */
    const STRING_FIELDS = ['dir', 'agentsFile']
    /** Whole-number fields the form edits, in display order. */
    const NUMBER_FIELDS = ['parkAfterCompactions', 'retainTailNodes', 'indexMaxEntries', 'maxToolChars']
    /** The one boolean field. */
    const BOOLEAN_FIELDS = ['autoPark']

    /** Simplified Chinese copy (the key-set source of truth). */
    const zh = {
      title: '上下文归档设置',
      description: '把压缩过的上下文归档到工作区，并用指针替换历史。',
      summary: '把压缩过的上下文归档到工作区，并用指针替换历史。',
      save: '保存',
      saving: '保存中…',
      readOnly: '当前部署的配置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      saveFailed: '未接受这些值，已保留供你修改。',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalidNumber: '请填数字；留空表示恢复默认。',
      dir: '归档目录',
      'dir.hint': '相对会话工作区，越界会被拒绝。',
      agentsFile: '指针文件',
      'agentsFile.hint': '一句话指针的落点，只写一次。',
      autoPark: '自动归档（关闭后只能手动 /park）',
      parkAfterCompactions: '自动归档阈值',
      'parkAfterCompactions.hint': '累计多少次压缩后自动 park。',
      retainTailNodes: '保留尾部节点',
      'retainTailNodes.hint': '最新的 N 个表面节点永不归档。',
      indexMaxEntries: '索引条目上限',
      'indexMaxEntries.hint': '超出后旧条目轮换到 index-archive.md。',
      maxToolChars: '工具输出上限',
      'maxToolChars.hint': '归档原文里单个工具输出的字符数上限。',
    }

    /** English copy, checked complete against the zh key set. */
    const en = {
      title: 'Context archive settings',
      description: 'Archive compacted context into the workspace and replace history with a pointer.',
      summary: 'Archive compacted context into the workspace and replace history with a pointer.',
      save: 'Save',
      saving: 'Saving…',
      readOnly: 'This deployment serves configuration read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
      dir: 'Archive directory',
      'dir.hint': 'Relative to the session workspace; escaping it is refused.',
      agentsFile: 'Pointer file',
      'agentsFile.hint': 'Where the one-line pointer is installed, once.',
      autoPark: 'Park automatically (off: manual /park only)',
      parkAfterCompactions: 'Auto-park threshold',
      'parkAfterCompactions.hint': 'How many compactions before the context is parked.',
      retainTailNodes: 'Retained tail nodes',
      'retainTailNodes.hint': 'Newest surface nodes kept verbatim, never archived.',
      indexMaxEntries: 'Index entry cap',
      'indexMaxEntries.hint': 'Older entries rotate to index-archive.md past this.',
      maxToolChars: 'Tool output cap',
      'maxToolChars.hint': 'Per-tool-output character cap inside an archived transcript.',
    }

    /**
     * A boolean field spec. Schemastery has no boolean form control, so the
     * value rides the shared text control as `true`/`false`; the checkbox
     * reads and stages that text.
     * @param field - field name inside the namespace section.
     * @returns the field's conversion spec.
     */
    function settingsBooleanField(field) {
      return {
        field,
        format: (value) => (value === true ? 'true' : value === false ? 'false' : ''),
        parse: (text) => {
          const trimmed = text.trim().toLowerCase()
          if (trimmed === '') return { kind: 'clear' }
          if (trimmed === 'true') return { kind: 'set', value: true }
          if (trimmed === 'false') return { kind: 'set', value: false }
          return undefined
        },
      }
    }

    /** The snapshot a form reports before the Host has answered with this entry. */
    function pendingSnapshot() {
      return {
        status: 'loading',
        value: undefined,
        base: undefined,
        user: undefined,
        revision: undefined,
        writable: false,
        mode: 'host',
      }
    }

    /**
     * Bind the settings form to whichever of `entryIds` the Host currently
     * serves, and rebind whenever the describe mirror names a different one.
     *
     * Mirrors `@linxin666/dsh-remote-web-ui`'s `createServedEntryForm`: an
     * unanswered or empty mirror keeps the first candidate; a mirror that
     * answers without any of this package's rows leaves the last. `get()` is
     * guarded because it throws before the entry is served.
     *
     * @param forms - the client `configForms` service.
     * @param entryIds - candidate profile entry ids, most specific first.
     * @returns a scope with the shape `SettingsFormModel` expects.
     */
    function createServedEntryScope(forms, entryIds) {
      const fallbackId = entryIds[0]
      const namespaceId = entryIds[entryIds.length - 1]
      const listeners = new Set()
      let boundId
      let bound
      let offBound
      let snapshot = pendingSnapshot()

      const publish = () => {
        if (bound !== undefined) snapshot = bound.getSnapshot()
        for (const listener of [...listeners]) listener()
      }

      const resolve = () => {
        let served
        try {
          served = forms.describe().getSnapshot().view?.namespaces.map((row) => row.ns)
        } catch {
          served = undefined
        }
        if (served === undefined || served.length === 0) return fallbackId
        return entryIds.find((id) => served.includes(id)) ?? namespaceId
      }

      const bind = () => {
        const target = resolve()
        if (target === boundId) return
        offBound?.()
        offBound = undefined
        let form
        try {
          form = forms.get(target)
        } catch {
          boundId = undefined
          bound = undefined
          return
        }
        boundId = target
        bound = form
        offBound = form.subscribe(() => publish())
        publish()
      }

      try {
        forms.describe().subscribe(() => bind())
      } catch {
        /* describe mirror unavailable: bind() below still tries once */
      }
      bind()

      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set: (field, value) => bound?.set(field, value) ?? Promise.resolve(false),
        unset: (field) => bound?.unset(field) ?? Promise.resolve(false),
        mutate: (ops, revision) => bound?.mutate(ops, revision) ?? Promise.resolve(false),
      }
    }

    /**
     * The staged form over this plugin's settings entry.
     *
     * The bound translator rides inside the snapshot so the card reads this
     * plugin's dictionary regardless of which `t` the page hands the slot.
     */
    class ContextArchiveController {
      /**
       * @param ctx - the browser plugin context (needs `configForms`, `locale`).
       */
      constructor(ctx) {
        this.t = ctx.locale.bind(NS)
        this.scope = createServedEntryScope(ctx.configForms, ENTRY_IDS)
        this.form = new prim.SettingsFormModel(this.scope, [
          ...STRING_FIELDS.map((field) => prim.settingsTextField(field)),
          ...NUMBER_FIELDS.map((field) => prim.settingsNumberField(field)),
          ...BOOLEAN_FIELDS.map((field) => settingsBooleanField(field)),
        ])
        this.store = this.form.bind(() => this.projection())
      }

      /** Build the card's state from the form's reads and the bound translator. */
      projection() {
        const fields = {}
        for (const field of [...STRING_FIELDS, ...NUMBER_FIELDS, ...BOOLEAN_FIELDS]) {
          fields[field] = this.form.field(field)
        }
        return { ...this.form.shell(), ...fields, t: this.t }
      }

      /** The face the slot registration injects: the store hook and the form actions. */
      inject() {
        return { hooks: { contextArchiveCard: this.store }, ...this.form.actions() }
      }

      /** Release the form's subscription. */
      dispose() {
        this.form.dispose()
      }
    }

    /**
     * Render the bundle's configuration section.
     * @param props - the view asked for, the injected hook and the form actions.
     * @returns the section, or the one-liner for a summary view.
     */
    function ContextArchiveCard(props) {
      const state = props.useContextArchiveCard((snapshot) => snapshot)
      const t = state.t
      if (props.view === 'summary') return t('summary')
      const disabled = !state.writable
      const value = (field, numeric) =>
        jsx(prim.SettingsValueField, {
          id: `plugin-config-context-archive-${field}`,
          label: t(field),
          hint: t(`${field}.hint`),
          overriddenLabel: t('overridden'),
          resetLabel: t('reset'),
          invalidLabel: t('invalidNumber'),
          ...(numeric === true ? { numeric: true } : {}),
          disabled,
          ...state[field],
          onEdit: (text) => props.edit(field, text),
          onReset: () => props.resetField(field),
        })
      return jsxs('section', {
        style: { marginTop: '16px', marginBottom: '16px' },
        children: [
          jsx('h3', { style: { margin: '0 0 4px', fontSize: '14px', fontWeight: 600 }, children: t('title') }),
          jsx('p', { style: { margin: '0 0 12px', opacity: 0.7 }, children: t('description') }),
          jsxs(prim.SettingsForm, {
            labels: {
              unavailable: t('unavailable'),
              readOnly: t('readOnly'),
              saveFailed: t('saveFailed'),
              save: t('save'),
              saving: t('saving'),
            },
            state,
            onSave: props.save,
            onDiscard: props.discard,
            children: [
              ...STRING_FIELDS.map((field) => value(field, false)),
              ...NUMBER_FIELDS.map((field) => value(field, true)),
              jsx('div', {
                style: { marginTop: '12px' },
                children: jsx(prim.Checkbox, {
                  checked: state.autoPark.text === 'true',
                  disabled,
                  label: t('autoPark'),
                  onChange: (checked) => props.edit('autoPark', checked ? 'true' : 'false'),
                }),
              }),
            ],
          }),
        ],
      })
    }

    /** Required browser services. */
    const inject = ['slots', 'locale', 'configForms']

    /**
     * Register the bundle's configuration section while its page exists.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-context-archive: dictionaries')
      const card = new ContextArchiveController(ctx)
      ctx.effect(() => () => card.dispose(), 'dsh-context-archive: form subscription')
      ctx.effect(
        () =>
          ctx.slots.inject('plugins.bundle.config', () => {
            try {
              return ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: BUNDLE,
                  locale: NS,
                  inject: () => card.inject(),
                },
                ContextArchiveCard,
              )
            } catch (error) {
              console.warn('[dsh-context-archive] configuration card registration failed:', error)
              return () => {}
            }
          }),
        'dsh-context-archive: bundle configuration',
      )
    }

    exports.NS = NS
    exports.BUNDLE = BUNDLE
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
