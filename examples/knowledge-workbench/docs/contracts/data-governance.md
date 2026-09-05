# 知识库文档数据治理契约 v1

- 事项：AWW-4；producer_node：G；contract_version：1.0；日期：2026-09-04。
- source_revision：AWW-2《团队知识库 SaaS：产品边界与架构需求 v1.1》及 AWW-4 当前任务说明；evidence_level：design。
- 上游文件：architecture.md。
- artifact_ref：data-governance.md。
- 本文完成 G 的定义交付，经既有 G→B、G→F 连接传递。未读取 U 的私有上下文，未新增节点或连接。B 负责将本文的权限动作映射到 U 契约。

## 1. 范围与默认边界

首版采用手动文本/Markdown 创建与编辑、分类标签、版本、质检、发布、归档、软删除和工作区内检索。Markdown 文件导入按用户提交文本处理，必须经过相同校验；不假定已有导入程序。

富文本导入及任意文件上传仅预留来源/文件元数据契约，不扩大 P 的首版文本范围。没有抽取出的合格正文时，不可凭附件元数据发布知识文档。云文档同步、采集、OCR、API 批量导入、AI 摘要/标签/Embedding 都是扩展，不声称接入或执行。

工作区是隔离边界。首版无单文档 ACL、跨工作区共享或外部公开访问；visibility 固定为 workspace，表示继承工作区角色策略。collection 只用于组织，不隐含权限。

## 2. 类型与共同约束

ID 均为服务端生成的不透明 UUID；版本序号与 revision 为正整数；时间为服务端 UTC RFC3339；hash 使用 SHA-256 十六进制字符串。下表“必填”指持久化要求；“发布必填”允许草稿为空，但发布必须通过。

所有租户实体携带 workspace_id，与 Workspace 外键关联；所有跨实体外键按 (workspace_id, resource_id) 校验，禁止仅凭客户端 ID 建立跨租户关系。创建/修改身份从可信会话取得，不接受客户端伪造。

### 2.1 Document：身份、状态及当前指针

| 字段 | 类型 / 必填 | 定义与约束 |
| --- | --- | --- |
| id, workspace_id | UUID / 是 | 不可变身份；文档不可直接移动到其他工作区 |
| collection_id | UUID? / 否 | 可为空；引用同工作区 Collection；空值不是孤立文档 |
| title | string / 是 | 最新编辑投影，可暂为空；发布时去首尾空白后非空，长度上限交 B 定义 |
| category_id | UUID? / 发布必填 | 同工作区有效 Category；对应 P 的 category 概念 |
| owner_id | UUID? / 发布必填 | 责任人 User；发布时必须是本工作区活跃成员；不是授权角色 |
| source_ref | UUID? / 发布必填 | 同工作区 Source.id；对应 P 的来源引用 |
| language | string / 是 | 语言标签；未知用 und，不以未执行的检测冒充识别结果 |
| visibility | enum(workspace) / 是 | 不支持 private/public 值 |
| state | enum(draft,published,archived,deleted) / 是 | 归档和软删除是文档层状态，不抹掉版本历史 |
| latest_draft_version_id | UUID? / 否 | 最新未发布快照；必须引用本工作区、本 Document 的版本 |
| current_published_version_id | UUID? / 否 | 当前发布快照；首次发布前为空；新草稿不改变此指针 |
| revision | integer / 是 | 从 1 起，任何业务变更单调递增，用于 expected_revision 乐观锁 |
| created_by, updated_by | UUID / 是 | 可信主体的审计引用；成员离开后保留历史归属 |
| created_at, updated_at | timestamp / 是 | created_at 不变；updated_at 记录本次文档业务变更 |
| published_at | timestamp? / 否 | 当前版本正式发布时刻；仅发布成功更新，不以草稿创建/修改时间代替 |
| archived_at, deleted_at | timestamp? / 否 | 进入对应状态时填写；没有物理清除或恢复默认值 |

Document.title/category_id/owner_id/source_ref/language 及 DocumentTag 是最新编辑投影，仅用于有管理权限的视图。普通检索、Viewer 详情和统计始终读取 current_published_version_id 的元数据与正文快照，禁止暴露未发布标题、分类、标签或摘要。普通返回的更新时间使用 published_at，不泄露草稿编辑活动。

### 2.2 DocumentVersion：不可覆盖的编辑快照

| 字段 | 类型 / 必填 | 定义与约束 |
| --- | --- | --- |
| version_id, workspace_id, document_id | UUID / 是 | 复合引用 Document；版本不能改挂其他文档 |
| version_no | integer / 是 | 每文档单调递增；唯一 (workspace_id,document_id,version_no) |
| parent_version_id | UUID? / 否 | 同文档前序快照，首版为空；首版只允许线性编辑 |
| content_ref | opaque string / 是 | 经服务端验证的正文对象引用；空草稿也可引用空对象；不返回存储凭据 |
| content_format | enum(text,markdown) / 是 | 富文本格式不在首版接受集合 |
| checksum | SHA-256 string / 是 | 保存的正文 UTF-8 字节摘要；由服务端计算 |
| metadata_snapshot | object / 是 | title、category_id、tag_ids(UUID[])、owner_id、source_ref、language、collection_id 的快照；发布可见内容不从最新编辑投影补齐 |
| quality_status | enum(unchecked,passed,failed) / 是 | 初始 unchecked；由匹配本版本的最新有效质检计算，不由调用者指定 |
| created_by, created_at | UUID,timestamp / 是 | 快照作者与生成时刻 |

正文、checksum、metadata_snapshot、作者和版本号一旦保存不可原地更改；编辑正文或发布相关元数据都生成新版本。quality_status 是由追加质检记录计算的派生状态，若存为缓存须可重算；它不是对正文快照的覆盖。分类/标签改名影响展示时同样通过新快照发布，发布元数据保留当时的名称投影。

### 2.3 Collection、Category、Tag 与关系

| 实体 | 字段 / 类型 / 必填 | 约束 |
| --- | --- | --- |
| Collection | id,workspace_id:UUID；name:string；state:active/retired，均是 | 首版平级组织容器，无隐式 ACL；被引用时不得物理删除 |
| Category | id,workspace_id:UUID；name,normalized_name:string；state:active/retired，均是 | 单文档单分类；唯一 (workspace_id,normalized_name) |
| Tag | id,workspace_id:UUID；name,normalized_name:string；state:active/retired，均是 | 规范名执行 Unicode NFKC、去首尾空白和大小写折叠；禁止空标签；同工作区规范名唯一 |
| DocumentTag | workspace_id,document_id,tag_id:UUID，均是 | 最新编辑关联；三字段唯一；实际发布标签来自版本快照，禁止借标签授予权限 |

Category 采用与 Tag 相同的规范名算法。字典停用后不可新增引用；历史快照保留既有名称。治理负责人处理重命名/合并，首版不隐式重写既有发布内容。

### 2.4 Source：来源记录

| 字段 | 类型 / 必填 | 定义 |
| --- | --- | --- |
| id,workspace_id | UUID / 是 | 来源记录属于单一工作区；被版本引用后保留其快照 |
| kind | enum(manual,markdown_import,file_registration) / 是 | 首版 manual/markdown_import；file_registration 仅扩展元数据登记 |
| origin_ref | string / 是 | manual 使用 internal:document/{document_id}；导入使用内部收件记录引用，不强制所有来源都有公网 URL |
| supplied_by,registered_at | UUID,timestamp / 是 | 谁登记、何时登记，从服务端取得 |
| source_uri,external_id | string? / 否 | 经允许的原地址/外部标识；不得含令牌、签名链接或密码 |
| source_updated_at | timestamp? / 否 | 来源明确提供才填写；未知为空，不等同于本地导入时间 |
| file_name,mime_type,file_checksum | string? / 文件登记条件必填 | 登记已授权文件的安全文件名、类型、摘要 |
| file_size_bytes | integer? / 文件登记条件必填 | 非负字节数；本文未读取任何实际文件样本 |
| processing_method | enum(manual,markdown_text,metadata_only) / 是 | metadata_only 不能自动生成可发布正文 |

来源更正创建新 Source 记录并经新版本引用，不更改历史发布版本的来源含义。Source 不是下载授权或导入成功凭证。

### 2.5 QualityRun、QualityFinding 与 AuditEvent

| 实体 | 字段 / 类型 / 必填 | 约束 |
| --- | --- | --- |
| QualityRun | id,workspace_id,document_id,version_id,executed_by:UUID；document_revision:int；ruleset_revision:string；checked_at:timestamp；status:completed/error，均是 | 绑定精确快照和规则版；executed_by 为用户或登记的系统主体；依赖上下文变化后需重新检查 |
| QualityFinding | id,workspace_id,run_id:UUID；rule_id,field,message:string；severity:blocker/warning；passed:boolean；evidence_ref:string?；均必填但 evidence_ref 可空 | 每条执行过的规则保存一条结果；message 仅描述问题，不带无权文档名称或敏感原文 |
| AuditEvent | id,workspace_id,actor_id:UUID；action,resource_type,resource_id,request_id,outcome,policy_revision:string；occurred_at:timestamp；version_id:UUID?；before_revision,after_revision:int? | 追加写；记录创建、编辑、发布、质检结论、归档、软删除、权限关联及所有者/标签/分类变更和授权失败；主体为系统时以系统主体标识登记，文档动作携带 version_id（如已有版本） |

quality_status=passed 要求有效 QualityRun.completed 且全部 blocker passed=true；warning 失败仍可发布。同一 (workspace_id,run_id,rule_id) 只保存一次结果。未执行、执行错误、缺阻断规则结果均不能当作 passed；未启用的警告规则在运行摘要中标 not_run。禁止使用无依据的综合质量分。审计记录不存密码、令牌或完整正文；主体注销后保留最小不可反查凭据的审计标识，不删除审计事件以规避保留期。

## 3. 生命周期、并发与发布原子性

| 当前状态 / 动作 | 后续状态与数据变化 | 条件 |
| --- | --- | --- |
| 新建 | draft，生成 Document、Source、首个版本，发布指针为空 | 活跃成员且获 document.create；创建使用 idempotency_key |
| draft / 编辑 | draft，追加版本，替换最新草稿指针 | expected_revision 匹配；旧版本不覆盖 |
| published / 编辑 | 保持 published，追加草稿；旧发布版继续可读 | Viewer 仍只读取旧发布快照 |
| draft 或 published / 发布最新草稿 | published，原子替换发布指针，清空草稿指针，revision+1 | 当前授权、revision、全部阻断规则和质检上下文有效 |
| published / 归档 | archived，记录 archived_at，保留版本及指针 | document.archive；立即退出普通检索和普通统计 |
| draft/published/archived / 软删除 | deleted，记录 deleted_at，保留受控历史记录 | document.delete；立即退出普通读取、检索和统计 |

归档态与已删除态不直接编辑/发布；恢复、硬删除、跨工作区迁移均未定义，必须经产品决策再设计。原子发布包含授权/并发检查、当前快照规则检查、指针与状态更新及可靠审计落账；不能先返回发布成功再丢失审计记录。正文写入失败或规则依赖异常时不推进指针。

草稿 owner 失活、字典停用等动态约束在发布时复核；必要时重新检查。并发修改返回 409 并保留原发布版；字段或质检失败为 422；规则运行依赖故障为 503，保持未发布。quality_status 缓存不能代替发布时校验。

## 4. 质量规则与实际观察

以下均为拟定规则。没有样本、现有字典或运行数据，实际问题数为未检查，不写为 0。

| rule_id | 级别 | 检查与处置 |
| --- | --- | --- |
| META_REQUIRED | blocker | 发布快照 title、有效 category、活跃 owner、source_ref 非空；缺项交编辑者补齐 |
| CONTENT_REQUIRED | blocker | 正文去空白后非空且格式为 text/markdown；metadata_only 不合格 |
| REF_INTEGRITY | blocker | workspace、collection、category、tags、source、version 的引用存在且同租户；破损引用属于孤立数据，collection=null 合法 |
| CONTENT_INTEGRITY | blocker | content_ref 对象可读取且 checksum 与实际保存字节一致；失败修复存储引用后重检 |
| TITLE_DUPLICATE | warning | 相同工作区未删除文档的规范化标题重复；不加全局唯一约束，不自动合并 |
| CONTENT_DUPLICATE | warning | 相同工作区其他文档的正文摘要相同；仅证明字节重复，不声称语义相似 |
| OWNER_INACTIVE | blocker（发布） | 缺所有者或责任人不再是活跃成员，阻止后续发布；既有发布文档列待治理，不因更换责任人自动扩大访问 |
| STALE_CONTENT | warning | 按当前发布快照时间与工作区配置 stale_after_days 比较；阈值未确定前标 not_run，不擅自采用审计的 90 天 |

语义相似内容检查方法和阈值待产品/G/B 决策，首版不执行。重复检查不得跨租户；给管理者的发现详情仍需授权。发现记录保存检查时间、版本和规则版以供复算；字段修复追加新版本并重新质检，不篡改旧结果。

实际观察：输入“样本与现有字典”为空；未读取业务数据、未检测重复/过期/敏感内容；异常样本引用为无输入。静态一致性与输出格式验证见 validation-report.json，不等同于运行验收。

## 5. 权限关联与消费约定

G 声明逻辑动作：document.create/read_published/read_draft/update/publish/archive/delete、taxonomy.manage、quality.read、audit.read。B 与 U 的 authorize 结果及 policy_revision 对齐动作名和授权；本节点不发明独立角色系统，也不增加 U→G 接线。

授权资源明确采用 (workspace_id,resource_type=document,resource_id=Document.id)；其版本、来源和正文引用继承此文档访问判断，不凭引用单独放行。关联缺失即拒绝；policy_revision 由 U 裁决返回并用于审计/缓存校验，不在 Document 中复制一套权限策略。

- Owner/Admin 管理文档、字典与治理；Editor 管理文档、版本、发布、归档与软删除并读取治理结果；Viewer 仅看授权范围内已发布内容及相应统计。审计读取按最小权限交 Owner/Admin，B 与 U 确认映射。
- owner_id 是内容责任人，created_by 是审计作者，两者都不能替代 Membership，也不产生绕过角色的权限。
- 服务端先验证会话/账号、活跃成员资格、动作及资源工作区，再访问正文。单文档拒绝或不可见统一 404；已知工作区动作被禁止为 403；无会话为 401。
- 先权限与发布状态过滤，再命中排序、分页、摘要、分面、计数和看板；详情和下载引用再次授权。缓存/索引键包含 workspace_id，并验证当前授权状态；移除成员、停用、删除或归档后，即使索引落后也不能返回旧内容。
- published_count 按当前发布指针每文档计一次；分类分布来自同一授权发布快照；待治理数按可管理最新草稿至少一条 blocker 失败的文档去重。未运行/错误的质检另列状态，不能伪装为质量合格；已发布内容的责任人/过期问题另列治理发现，不改变上述草稿计数口径。Viewer 不返回草稿或治理明细。

## 6. 来源映射、保留与责任

| 来源 → 字段 | 处理 | 责任 |
| --- | --- | --- |
| 人工标题、分类、正文、标签 → Document 最新编辑投影及版本快照 | 校验引用、规范化标签、创建不可变版本 | 编辑者负责内容，G 定义规则，B 实现事务 |
| 登录会话 → created_by/updated_by/supplied_by、审计 actor_id | 服务端可信身份解析，不采信表单身份 | U 定义身份/授权，B 执行 |
| 手动/Markdown 输入 → Source.kind/origin_ref/processing_method | 保留来源与本地登记时刻；来源更新时间未知则空 | 编辑者登记，G 治理 |
| 文件声明 → 文件名/类型/大小/checksum | 仅元数据预留；实际上传、抽取、校验均未执行 | 产品确认范围后由 B 适配 |
| 质检 → QualityRun/Finding、quality_status | 带规则版与精确快照追加记录 | G 维护规则，B 执行，F 展示状态 |
| 文档动作 → AuditEvent | 最少字段、追加保存、受控查询 | B 可靠落账；运维负责保留和删除作业 |

审计按 occurred_at 连续保留 90 天；默认到期才具备清除资格，是否法律保留等例外由产品/组织责任方另行决策。此 90 天只适用于 AuditEvent，不能推导正文、历史版本、来源或质检发现的保留期。尚未批准这些实体的清除策略时不得自动物理删除。软删除不意味着已从备份/存储物理清除。

未决责任：产品负责人确认审批、正文/版本保留、恢复、敏感识别、脱敏及任何共享范围扩展；G/B 在相关实现前确认规则阈值、文件上限和存储引用规范。当前默认无审批步骤、无自动敏感识别或脱敏能力声明、禁止跨工作区共享。这些未决项不阻塞本节点设计交付，不代表实现或部署获授权。

## 7. 验收交接与证据边界

- AC-04：B/V 验证缺必填不能发布、编辑追加版本、409 保留旧内容、删除退出检索。
- AC-05：B/F/V 验证旧发布快照可读且不泄露草稿元数据、跨工作区引用拒绝、成员移除立即拒绝、摘要/分页/计数/分面同范围。
- AC-08：result.json 恰有 schema、quality、lineage 三个字符串，每字符串 ≤1200 字；所有文件引用是本地引用，不表示上传。
- 本轮仅完成契约静态复核、字段/输出格式验证及事项文档读回。没有数据库表、API、导入程序、权限过滤器或 90 天清除作业的实现，也没有联调、安装依赖、访问外部业务系统、发送业务消息、发布或部署。
