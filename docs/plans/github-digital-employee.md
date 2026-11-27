# 实施设计：隐私优先的 GitHub 数字员工

> 状态：设计稿，待评审。目标仓库：`Colin4k1024/openmuse`（fork）。
> 本文档是 Epic 与各 Issue 的母稿；Issue 正文由此复制。

## 0. 目标 / 范围 / 非目标 / 约束

**业务目标**：基于 OpenMuse 构建一个接管日常 GitHub 开发工作的数字员工（PR 分诊与摘要、issue 处理、CI 失败跟进、起草 review 与修复 PR），同时代码、凭证、对话数据不出本机/内网。

**范围（包含）**：
- GitHub 只读适配器（`gh` CLI 封装）与契约测试
- fine-grained PAT 的加密存储与连接生命周期管理
- Agent 只读 GitHub 工具集 + 每日开发摘要（standup digest）
- 写操作工具集（分支/提交/PR/评论），全部接入既有 ActionService 人工审批
- 本地 LLM（OpenAI 兼容端点）运行验证与文档
- CopilotKit Intelligence 本地替代的落地方案（与上游 #73/#179 对齐）

**非目标（明确不做）**：
- 不做自动合并 PR、自动关闭 issue、自动发布 release 等不可逆写操作
- 不做 GitHub App 形态的多租户分发（仅单用户自托管）
- 不改动移动端 UI 框架；证据卡片复用现有 inline card 体系
- 不实现 GitLab/Gitea 适配（仅在设计中预留接口形状）
- 不修改 OpenBot 适配器

**约束**：
- 兼容性：Node 24 / pnpm 11.19.0；不破坏现有 CI 五个 job（quality / platform×3 / browser / browser-container / computer-container）；DB schema 变更只允许 additive
- 安全：GitHub 凭证仅用 `TOKEN_ENCRYPTION_KEY`（AES-256-GCM，`packages/integrations/src/vault.ts`）加密落盘；任何外部写入必须经 `awaiting_review` 人工审批；无隐式重试
- 隐私：默认配置下仅 `api.github.com` 一个出网点；LLM 走 `OPENAI_BASE_URL` 指向的本地端点
- 平台：服务端适配器为 Node-only，不进移动端 bundle

---

## 1. 当前事实、缺口、风险、关键依赖

### 1.1 已核实的事实（代码级）

> 行号以 main `f593317` 为基准。

| 事实 | 证据 |
| --- | --- |
| 任务状态机有 9 态：`queued/running/waiting_approval/waiting_input/scheduled/paused/succeeded/failed/cancelled` | `packages/domain/src/agent.ts:3-12` |
| 任务 worker 用 SQL lease（默认 60s 见 `:127`，心跳 leaseMs/3 见 `:189`），lease 过期任务可被恢复；`waiting_approval` 不被重复 claim（`:91-110`） | `apps/server/src/engine/worker.ts:87-136,184-190` |
| 审批服务 ActionService：proposal 带 hash，过期/变更返回 409；approve 前检查连接有效性（`connected()`，`:136`） | `apps/server/src/actions.ts:102-138` |
| 模型任务工具骨架：`defineTool` + 串行队列 + `operations` sha256 幂等缓存 + checkpoint（`:43`）+ `ctx.guard()`（`defineTool` 于 `:63`，`serial` 于 `:48`，`cached` 于 `:86`） | `apps/server/src/engine/model.ts:43-95` |
| 密钥信封：AES-256-GCM versioned envelope（`v1.nonce.tag.ct`） | `packages/integrations/src/vault.ts` |
| 本地 LLM 通路已存在：`OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` | `apps/server/src/engine/tanstack-agent.ts:38,48` |
| **CopilotKit Intelligence 在所有模式强制要求**（线程持久化上云） | `apps/server/src/config.ts:169` |
| Google 集成是现成的适配器范式（816 行，OAuth + 加密存储 + reviewed 写入） | `packages/integrations/src/google.ts` |
| `Evidence.kind` 仅 `mail/file/web/user`，无 `github` | `packages/domain/src/agent.ts:15` |
| 测试基建：`tests/` 下 21 个测试文件（全仓含 mobile/worker/computer 共 28 个），含 provider 契约测试模式（`tests/google.test.ts`、`tests/openbot.test.ts`） | `tests/` |
| 集成契约文档范式：`docs/OPENBOT-INTEGRATION.md` | docs/ |

### 1.2 缺口

1. **无 GitHub 适配器**：`packages/integrations/` 仅 google/pdf/vault
2. **无 GitHub 连接/凭证管理**：没有 token 存储、`connected()` 检查对象
3. **无 GitHub 工具**：`model.ts` 现有工具不含 VCS 能力
4. **Evidence/domain 类型缺 `github` 种类**（additive 变更）
5. **线程持久化强依赖 CPK 云**：与"数据不出本机"目标冲突
6. **本地 LLM 路径未验证**：`OPENAI_BASE_URL` 支持存在但无测试/文档证明 tool-calling 可用

### 1.3 风险

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 本地小模型 function-calling 质量不足，agent 循环翻车 | 高 | Issue #7 设明确模型准入门槛；失败回退 sample/云端模型（用户自选） |
| 替换 CPK Intelligence 工作量大且与上游演进冲突 | 高 | 单独 Issue #8，对齐上游 #73/#179；前期可接受"线程上云、代码不出本地"的折中并显式记录 |
| Agent 误写仓库（错误分支/错误 repo） | 高 | 全部写操作走审批 + repo 白名单 + diff 绑定 hash；默认 deny |
| 写操作执行中崩溃导致外部状态不确定 | 中 | 创建类操作先查重（幂等键）；README 已有"不隐式重试"语义，扩展文档 |
| `gh` CLI 版本/输出漂移 | 中 | 契约测试固定 fake `gh`；运行时用 `--json` 结构化输出 |
| fork 与上游分叉加剧 | 低 | 适配器放 `packages/integrations`，最小侵入；契约文档仿 OPENBOT-INTEGRATION |

### 1.4 关键依赖

- 外部：`gh` CLI ≥ 2.4x（或 Octokit，见 Issue #2 决策）；本地推理服务（Ollama/vLLM 任一，OpenAI 兼容）
- 内部：ActionService、TaskWorker、vault、`@tanstack/ai-openai`
- 上游：CopilotKit/OpenMuse #73、#179（Intelligence 可选化/本地线程存储）——Issue #8 应跟踪而非重复造轮子

---

## 2. Issue 拆分（可独立交付、独立验收）

依赖图：

```
#1 契约与ADR ──┬──> #2 只读适配器 ──> #4 只读工具 ──> #5 每日摘要
              │                          │
              ├──> #3 凭证管理 ──────────┴──> #6 写工具+审批
              │
#7 本地LLM验证（独立）   #8 本地线程存储（独立，跟踪上游）
```

### Issue #1 [Docs] GitHub 集成契约与 ADR

- **目标**：在写代码前冻结数据边界、权限模型、状态机扩展，形成评审基线
- **范围**：`docs/GITHUB-INTEGRATION.md`（仿 OPENBOT-INTEGRATION.md：边界、契约、验证）；`docs/adr/0001-github-integration.md`（选型决策：`gh` CLI vs Octokit、PAT vs GitHub App、为何写操作必须过审批）
- **非目标**：任何运行时代码；不承诺 GitLab/Gitea 实现
- **依赖**：无
- **回滚**：删除文档文件
- **验收标准**：
  1. 文档明确定义出网清单（默认仅 `api.github.com`）
  2. 定义写操作审批矩阵（每种写操作 → proposal kind → hash 绑定内容）
  3. 定义 repo 白名单配置与默认 deny 语义
  4. ADR 记录被拒方案及理由
  5. `pnpm lint` 通过（markdown 不入 lint 则人工评审通过）

### Issue #2 [Adapter] 只读 GitHub 适配器（gh CLI 封装）

- **目标**：`packages/integrations/src/github.ts` 提供结构化只读能力：`listPullRequests` / `getPullRequest(diff)` / `listIssues` / `getChecksStatus` / `searchCode(只读)`
- **范围**：封装 `gh` CLI（`--json` 输出 + zod 校验）；repo 白名单校验；统一错误类型（未安装/未认证/rate-limit/无权限可区分）；契约测试用 fake `gh` binary（仿 `tests/helpers` 现有模式）
- **非目标**：任何写操作；token 管理（依赖 `gh auth` 自身）；移动端代码
- **依赖**：#1
- **回滚**：整文件删除 + 移除导出；无 DB 变更
- **验收标准**：
  1. 契约测试覆盖 5 个方法的成功 + 负向（gh 缺失 ENOENT、`gh auth` 失效 exit 4、403 rate-limit、404 私有仓库无权限、JSON 解析失败）
  2. 白名单外 repo 请求被拒绝且不发起子进程
  3. 所有方法不读取/不打印 token；stderr 脱敏
  4. `pnpm test` 与 CI quality job 通过

### Issue #3 [Credentials] GitHub token 加密存储与连接生命周期

- **目标**：支持 fine-grained PAT 加密落盘、连接状态查询、失效时作废关联 proposal
- **范围**：复用 `vault.ts` 信封；连接记录（scopes、绑定 repo 列表、过期时间）；实现 ActionService 所需的 `connected()`/`connection` 语义（对齐 `actions.ts:136-138`）；token 校验（`gh api user` 或 REST `/user`，启动与 approve 前各验一次）
- **非目标**：OAuth 流程（GitHub PAT 无 OAuth）；多账号；token 自动轮换
- **依赖**：#1（与 #2 可并行）
- **回滚**：配置项 `GITHUB_ENABLED=false` 关闭；连接表为 additive migration，回滚即停用不删表
- **验收标准**：
  1. token 落盘必为 `v1.` 前缀密文；DB 中无明文
  2. 错误/篡改密文解密抛错且不泄露明文片段
  3. token 失效（401）→ 该连接所有 `awaiting_review` proposal 作废为 `expired`，任务转 `waiting_input`
  4. 负向：错误 `TOKEN_ENCRYPTION_KEY` 重启后不解密、不崩溃，进入可诊断错误态
  5. `tests/vault.test.ts` 模式的新测试通过

### Issue #4 [Agent Tools] 只读 GitHub 工具注册

- **目标**：在 `engine/model.ts` 注册只读工具（list_prs / read_pr_diff / list_issues / get_ci_status），带幂等缓存、事件流、证据卡片
- **范围**：工具走既有 `defineTool` + 串行队列 + `operations` sha256 缓存；`Evidence.kind` additive 增加 `"github"`（domain + 移动端卡片映射）；系统提示词补充 GitHub 场景指引
- **非目标**：写工具；新的任务 kind（复用 `agent` kind）
- **依赖**：#2
- **回滚**：`GITHUB_ENABLED=false` 时工具不注册；Evidence kind 为 additive union，回滚仅不再产生
- **验收标准**：
  1. **幂等不变量**：同一任务内同参工具调用命中 `operations` 缓存，不产生第二次子进程（测试断言进程调用计数）
  2. **状态机不变量**：任务被 pause/cancel 后（`ctx.guard()` 失败）工具不再执行，返回 `{paused:true}`；lease 丢失（LostLeaseError）后无后续工具调用
  3. **崩溃恢复**：工具完成后、checkpoint 前进程崩溃 → 重放时凭缓存得到同值，不产生重复外部请求
  4. 证据卡片含 repo/编号/URL；移动端不崩溃（unknown kind 有兜底渲染）
  5. `tests/engine.test.ts` 同模式新测试通过

### Issue #5 [Workflow] 每日开发摘要（standup digest）

- **目标**：scheduled 任务每日汇总：待 review PR、CI 失败、新增 issue，生成摘要与建议动作
- **范围**：复用 `monitor`/`scheduled` 任务机制（`worker.ts` nextRunAt 调度）；摘要写入任务 result + evidence；失败退避复用现有 monitor 语义
- **非目标**：推送通知到设备外（仅应用内通知）；自动发起修复任务
- **依赖**：#4
- **回滚**：删除 scheduled 任务记录即停止；代码由 `GITHUB_ENABLED` 控制
- **验收标准**：
  1. **调度不变量**：任务完成后 `nextRunAt` 单调前进；进程停机跨过调度点后恢复只补跑一次（去重）
  2. **负向**：GitHub 不可达 → 失败计数 + 退避，不产生摘要垃圾；连续失败阈值后转 `waiting_input`
  3. **无副作用**：摘要流程只读，断言零写 API 调用（fake gh 记录 argv）
  4. 摘要内容与 fake 数据快照一致

### Issue #6 [Agent Tools] 写工具 + 人工审批闭环

- **目标**：create_branch / commit_files / open_pull_request / comment，全部经 ActionService 审批后才执行
- **范围**：每种写操作 → proposal（kind + hash 绑定 diff/正文）；approve 后执行并回写 receipt（PR URL、commit SHA）；**幂等设计**：open_pull_request 先按 head branch 查重；comment 带 `<!-- openmuse:idem:<sha256> -->` 标记查重
- **非目标**：merge、close、release、force-push、删分支；绕过审批的任何快捷路径
- **依赖**：#3、#4
- **回滚**：`GITHUB_WRITE_ENABLED=false`（独立于只读开关）；已创建的 GitHub 侧对象不删除（用户自行处理）
- **验收标准**：
  1. **审批不变量**：未 approve 的 proposal 不产生任何 GitHub 写请求（fake gh 断言零写 argv）
  2. **hash 不变量**：proposal 生成后 diff/正文任一变化 → approve 返回 409，不执行
  3. **过期不变量**：proposal 过期后 approve 返回 409；token 失效后 approve 被拒绝
  4. **崩溃恢复**：approve 后执行中崩溃 → 任务恢复时先查重（head branch / idem 标记），已存在则回写已有对象 receipt，**不重复创建、不隐式重试不确定的写**
  5. **并发**：两个任务同时对同 repo 开 PR → 串行队列 + 查重保证至多一个创建成功，另一个得到已有对象引用
  6. **负向**：分支保护拒绝 push（403）→ 任务转 failed，错误可读；PR 已存在 → 幂等返回
  7. 外部副作用审计：每个被执行的写操作都有 RunEvent（kind=result）+ receipt 持久化

### Issue #7 [Infra] 本地 LLM 通路验证与文档

- **目标**：验证 `OPENAI_BASE_URL` 指向本地 OpenAI 兼容服务（Ollama/vLLM）时 agent 工具循环可用，并给出模型准入门槛
- **范围**：测试/脚本：本地端点健康检查、tool-calling 冒烟（固定 fixture，不依赖真实模型权重）；文档写明已验证模型清单、显存要求、失败回退（sample 模式）
- **非目标**：引入新 provider SDK；模型微调；性能调优
- **依赖**：无（可与一切并行）
- **回滚**：纯测试+文档，回滚即删除
- **验收标准**：
  1. `AGENT_BACKEND=model` + 本地端点下，#4 的只读工具冒烟流程端到端通过
  2. 端点不可达时任务转 `waiting_input`（复用 model.ts 现有语义）且错误可读
  3. 文档记录最低可用模型与已知翻车模式

### Issue #8 [Infra] 本地线程存储（去 CPK 云依赖）

- **目标**：使 `CPK_INTELLIGENCE_API_KEY` 可选，提供 PGlite 本地线程持久化，实现"对话不出本机"
- **范围**：抽象 `CopilotKitIntelligence` 注入点（`apps/server/src/agent.ts:32`）为接口 + PGlite 实现；对齐上游 #73（Intelligence 可选化）与 #179（keyless local thread store）——**优先跟踪/复用上游方案，不重复造轮子**；`config.ts` 改为按模式要求 key
- **非目标**：自建 `useThreads` 协议全量兼容层（仅覆盖本 fork 用到的能力）；迁移已有云端线程
- **依赖**：无代码依赖；建议等 #1 评审确认隐私目标后启动
- **回滚**：`THREADS_BACKEND=intelligence|local` 配置切换
- **验收标准**：
  1. `THREADS_BACKEND=local` 且无 CPK key 时服务正常启动（当前 `config.ts:169` 会拒绝）
  2. 线程创建/重命名/归档/回放全流程本地持久化，重启不丢
  3. 出网审计：local 模式下无 intelligence 域名请求
  4. 与上游 #73/#179 的关系在文档中写明（复用/分叉/临时方案）

---

## 3. 核心验收逻辑（跨 Issue 共用）

### 3.1 状态机不变量
- `waiting_approval` 任务不被 worker claim 执行（`worker.ts:91-110` 现有语义，新增 GitHub 测试锁定）
- 写操作 proposal：`awaiting_review → executing → succeeded|failed`，禁止 `executing → awaiting_review` 回退（对齐上游已修复的 #36 回归语义）
- 任何终态（succeeded/failed/cancelled）任务不再产生外部请求

### 3.2 负向场景清单
- gh 未安装 / 未认证 / 版本过低
- 401 token 失效、403 rate-limit（带 Retry-After）、403 分支保护、404 无权限 repo、422 校验失败
- 网络中断（ECONNRESET/ETIMEDOUT）在不同阶段：读时、写前、写中
- 本地 LLM 端点不可达、返回非工具调用响应、上下文超长

### 3.3 并发 / 崩溃 / 恢复
- 双任务同 repo 写：串行工具队列 + 幂等查重 → 至多一次外部创建
- approve 后崩溃：恢复时查重优先，不确定则不重试，转人工
- lease 丢失：LostLeaseError 后工具 guard 全部拒绝，无"僵尸写"
- worker 停机跨过 scheduled 点：恢复补跑一次且仅一次

### 3.4 外部副作用检查
- 测试一律使用 fake `gh`/fake HTTP，断言 argv/请求体快照
- 每个被执行的写操作必须有持久化 receipt（RunEvent + result）
- DB 全表扫描断言无明文 token（正则扫描 GitHub PAT 前缀 `github_pat_`/`ghp_`）
- local 模式下出网域名白名单审计（仅 api.github.com 或 GHE 主机）

---

## 4. 重复 Issue 检查结果（提交前）

- **fork（Colin4k1024/openmuse）**：`gh issue list --state all` → **0 个 Issue**，无重复
- **上游（CopilotKit/OpenMuse）**：检索 `github`/`git` 集成 → **无相关 Issue**
- **需关联而非重复**：上游 #73（Intelligence 可选化）、#179（keyless local thread store）→ 本 Epic 的 Issue #8 引用并跟踪；上游 #36（审批回归）、#32（中断后 artifact 重复）→ 验收标准 3.1/3.3 的既有语义来源
