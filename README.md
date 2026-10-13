# dsh-context-archive

把**压缩过的上下文**归档进工作区，用摘要替换历史，并在 `AGENTS.md` 里只留**一句话**指向归档目录。

- **不是**轮换新会话：同一 session、同一 agent，原地替换表面（surface），没有 UI 跳转。
- **不是**每次压缩都改 `AGENTS.md`：指针只写一次，之后永不重写（手工编辑也保留）。
- 触发策略可配：自动压缩 `parkAfterCompactions` 次后 park，默认 **3**；也可随时 `/park` 手动触发。
- **`/park switch [预设id]`**：先 park 当前会话，再由宿主开一条同一工作区/目录的新会话并切过去（可选 agent preset），适合"归档旧账、从头开始"。

## 工作方式

```text
压缩第 N 次（官方压缩后端写的 compaction/summary） ──► 达到阈值（默认 3）
                        │
                        ├─ 1. 读压缩事件里已有的摘要（不额外调 LLM）
                        ├─ 2. 从 append-only 日志回放该区间原文（含更早被遮蔽的内容）
                        ├─ 3. 归档 → docs/context-archive/segments/0007-<compactionId>.md
                        ├─ 4. 追加索引 → docs/context-archive/index.md
                        ├─ 5. 记账 → docs/context-archive/meta.json（水位线，崩溃可重放）
                        ├─ 6. session.append('user/message', 指针, {surfaceOp:{op:'replace', …}})
                        │     把整段表面换成一个指针消息 —— 官方 SurfaceOp 公开机制
                        └─ 7. 校验 AGENTS.md 指针块（存在则一个字节都不写）
```

### 为什么不调用 `ctx.compaction`

Web/Desktop 组合把压缩后端挂在**每个 agent 预设的隔离域**里（`isolate: { compaction: true }`），宿主平面甚至显式 `disabled: true` 掉了 `compaction-basic` / `command-compact`。宿主插件因此**永远** inject 不到 `compaction` —— 这正是"运行状态：等待依赖"的原因。

所以本插件只依赖宿主平面服务（`fs` / `sessions`，可选 `tokenMeter` / `commands`），自己完成表面替换。三个直接收益：

- **零额外 LLM 调用**：摘要是压缩后端已经写好、已经付过钱的那份；
- **没有数据丢失窗口**：归档从 append-only 日志渲染，替换后崩溃也能在下次 park 补写（`meta.json` 按 `compactionId` 去重）；
- **人类视角不受影响**：会话 UI 读的是 append-origin 事件，所以你仍能在侧边栏看到完整历史，而模型看到的是指针。

产出的目录：

```text
docs/context-archive/
  index.md               # 唯一读入口：新条目在前，每条 3 行；超上限轮换到 index-archive.md
  index-archive.md       # 轮换出去的旧索引条目
  meta.json              # 机器记账：{parkNumber, sessionId, compactionId, endSeq, ...}
  segments/0007-a1b2c3d4.md   # 摘要 + 元信息 + 该区间原文（全量，未裁剪）
```

`AGENTS.md` 里新增的内容（只加一次）：

```markdown
<!-- dsh-context-archive:pointer -->
早期对话会归档到 `docs/context-archive/`：需要回忆先前工作、或不确定上下文是否完整时，先读 `docs/context-archive/index.md` 定位，再按需 grep/read `docs/context-archive/segments/` 下对应文件。
<!-- /dsh-context-archive:pointer -->
```

## 切换会话：`/park switch [预设id]`

`/park` 只归档；加上 `switch` 就在归档之后另起一条新会话：

```
/park                 # 仅归档（不变）
/park switch          # 归档 + 开新会话（宿主默认 agent preset）
/park switch ptc      # 归档 + 开新会话并指定 agent preset
```

要点：

- **新会话由宿主创建，不是浏览器**。这样 GUI 和聊天室驱动（`dsh-lobby-bot`）会指向**同一条**新会话：浏览器半区只是 `openSession` 切过去，驱动则把房间的 `(bot, room)→会话` 记账重绑到新会话（见下）。
- 新会话与当前会话**同一工作区/目录**（继承 `cwd`，能解析到就带 `workspaceId`）；`agentPreset` 缺省用宿主默认。
- **归档失败也会切换**：`nothing-to-park` / `busy` / `compaction-active` 只作为提示，新会话照常开——目的是"换个干净上下文"，不该被一次归档失败卡住。
- 宿主开完新会话后 emit 一个宿主事件 **`context-archive/switch`**，体为 `{ fromSessionId, toSessionId, preset }`：
  - 浏览器半区据此把界面切到 `toSessionId`；
  - `dsh-lobby-bot` 若正在驱动 `fromSessionId`，把该房间的记账指向 `toSessionId`，下一轮房间消息就用新会话。没有别的插件监听时该事件被忽略，两个插件可各自独立升级。
- 需要浏览器半区能拿到 `sessions` / `remote` / `uiWorkspace`（见 `package.json` 的 `dsh.client.inject`）；旧部署缺这些服务时只是不切换，归档功能不受影响。

```text
config/cordis.patch.yml   无需改；`/park` 命令的 input 描述符在代码里
```

## 配置

全部在 composition row 的 `config` 上（见 `cordis.patch.yml`）：

| key | 默认 | 含义 |
|---|---|---|
| `dir` | `docs/context-archive` | 归档目录，相对 session workspace（越界会被拒绝） |
| `agentsFile` | `AGENTS.md` | 指针落点；写一次后不再改动 |
| `autoPark` | `true` | `false` 时只能用 `/park` |
| **`parkAfterCompactions`** | **`3`** | 自动压缩多少次后 park（最小 1） |
| `retainTailNodes` | `2` | 始终保留最新的 N 个表面节点不归档 |
| `indexMaxEntries` | `150` | `index.md` 条目上限，超出轮换 |
| `maxToolChars` | `2000` | 归档原文里单个工具输出的字符上限 |

改配置：编辑本包的 `cordis.patch.yml`（升级会覆盖），**推荐**在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里加一条 id 覆盖行（profile patch 层在 bundle 层之后应用，升级不会冲掉）：

```yaml
- id: context-archive
  config:
    parkAfterCompactions: 3
```

### 前端配置入口

插件带一个浏览器半区，把上面这些键做成表单，渲染在左侧边栏 **插件（Plugins）** → `dsh-context-archive` 这个 bundle 的**详情页**上（`plugins.bundle.config` 槽，key = 包名）。保存即写进活动 profile 的 `cordis.patch.yml` 覆盖行并热生效，不必手改 YAML。

表单只暴露标了 `.volatile()` 的字段（本插件全部字段都标了，见 `lib/index.js` 的 `Config`；因为这些字段是热更新引用，插件内部一律用 `config.<key>.get()` 读取）。表单的 namespace 按 profile entry id 解析（`configForms.describe()`），因此 entry id 变化时客户端会自动重绑。

## 安装

### 分发给同事（GitHub）

仓库推上去后，同事在 DSH 的左侧边栏 **插件（Plugins）** → **添加插件** 里粘贴：

```text
github:dongzheJ/dsh-context-archive#v0.3.0
```

（或完整仓库地址 `https://github.com/dongzheJ/dsh-context-archive`；带 `#vX.Y.Z` / `#<commit>` 可固定版本）。点安装、启用即可，插件会随 bundle 一起挂载。**注意**：① 需要 GitHub 可达（对话框里的「中国大陆镜像源」镜像是 npm，不代理 GitHub）；② 升级需先卸载再装新版。

> 其它来源：也可以填 npm 包名（需先 `npm publish`），或把 tarball/目录放到本地后填其**绝对路径**。

### 本机 / CLI

```sh
dsh plugin --profile <profile> add /绝对路径/dsh-context-archive
# 重启 dsh，然后确认挂载行：
dsh --profile <profile> --dump-config | grep -A 10 context-archive
```

> DSH Desktop 的 `desktop` profile 被 App 独占（`dsh` CLI 会拒绝）；在 Desktop 里请直接用「插件」页的 **添加插件**。仓库里的 `scripts/install-desktop.sh` 是早期 CLI 不可用时的兜底脚本。

## 已知边界

- **不调用 `ctx.compaction`**：表面替换由本插件用公开的 `SurfaceOp.replace` 完成。因此**不会**写 `compaction/start|summary|end` 事件——那三个由官方后端在它自己的压缩里写，本插件只读取。
- **同进程串行**：`meta.json` / `index.md` 的读改写用进程内路径锁；**两个 DSH 进程**同时跑同一个 workspace 不做跨进程互斥。
- **不切断裂 tool 配对**：替换边界用 `toolPairingBalancedBefore/After` 校验，不满足就向前收缩；历史太短时 `/park` 报 `nothing-to-park`。
- **保留尾部不会被归档**：`retainTailNodes` 之外的内容才进归档；这些节点仍会随历史增长，最终由下一次 park 收走。
- **只有压缩过的会话才有摘要可复用**：池子为空时（例如手动 `/park` 一个从未压缩的会话）「摘要」一节写"(本次压缩未产出摘要文本)"，索引行退化为原文首段摘要；原文始终是全量。
- **崩溃安全**：归档从 append-only 日志渲染，替换后崩溃也能在下次 park 补写；`meta.json` 按 `compactionId` 去重，文件名由 `parkNumber`+`compactionId` 决定，天然幂等。
- **人类仍看得到完整历史**：会话 UI 读 append-origin 事件，只有模型看到指针——这不是"删历史"，是"换模型可见视图"。
- **前端配置入口依赖较新的 DSH**：配置表单用的是 `plugins.bundle.config` 槽 + `dsh-settings` 的 volatile 表单；较旧的 DSH 只是看不到配置 UI，Host 归档功能不受影响。

## 验证清单（装完先跑一遍）

1. `/park` 手动触发 → `docs/context-archive/` 三件套生成，`AGENTS.md` 只多那一块。
2. 连续 `/park` 两次 → `index.md` 新条目在前、`park #` 递增，`AGENTS.md` **零变化**（`md5` 不变）。
3. 把 `parkAfterCompactions` 设为 `1`，正常聊到触发一次真实压缩 → 下一轮开工时应自动 park。
4. 让模型"回忆第 N 轮说过什么" → 它应当先读 `index.md` 再 grep `segments/`。
5. 卸载插件后重开被 park 过的会话 → 日志仍能正常重建（本插件不自造事件类型，只追加一条官方 `user/message` 替换）。
6. `/park switch`（可选带 preset）→ 界面切到新会话、标题栏是新会话；若同一会话由 `dsh-lobby-bot` 驱动，房间里再 `@` 它时用的是新会话（旧会话不再被接上）。park 失败时仍切，但提示里带归档失败原因。

## 测试

```sh
node --test test/archive.test.mjs   # 17 项纯逻辑用例：指针幂等、范围选择、水位线、索引轮换、转录渲染、压缩括号、turn 边界、指针文案、摘要/事件回退 digests、截断
```

## 许可

MIT
