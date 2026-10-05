// The canvas the knowledge-base case ran on 2026-09-04, recovered from the run itself on 2026-10-06.
// Every persona is the instructions file its agent loaded. Every title, input label, type, help text and
// filled-in value, every output field and every wire is in the message its node received (the node's
// canvas issue): tests/saas-knowledge-base-canvas.test.ts composes each message again and checks it against
// the run's evidence (docs/superpowers/evidence/2026-09-04-awwo/codex-live-inputs.json): the SHA-256 of the
// six messages with wired inputs, and the length of the first node's, which had no wired input and so no
// hash. Messages carry no input IDs, required flags or placeholders; those come from the 2026-09-04 agent
// templates the nodes were made from. The canvas planner added three inputs and chose their IDs, but its
// plan was not kept: backend.identityContract, frontend.accessContract and frontend.documentSchema are
// assigned, optional (as that day's UI snapshots show for the front end's two) and without placeholder.
// Change nothing.
import type { RecordedCanvas } from '../examples/officialWorkflows';

const canvas: RecordedCanvas = {
  "locale": "zh",
  "nodes": [
    {
      "id": "product",
      "title": "产品边界与架构需求",
      "persona": "负责沉淀团队知识库 SaaS 的最小可扩展产品边界、模块拆分、验收口径与待定技术选型，不执行实现。",
      "inputs": [
        {
          "id": "brief",
          "label": "任务要求",
          "type": "markdown",
          "required": true,
          "value": "搭建团队知识库 SaaS 的 Agent 画布，覆盖用户登录、工作区角色权限、文档数据治理、后端接口、前端检索与数据看板、交付验收。\n\n目标：\n- 每个模块独立 Session。\n- 明确输入输出契约。\n- 按真实依赖连接模块。\n- 生成最小可扩展架构。\n- 本轮已授权绑定真实 Codex 并运行七个节点，替代最初仅规划、不执行的限制。\n\n核心能力：\n- 用户登录与账号生命周期。\n- 工作区、成员、角色、权限控制。\n- 文档采集、分类、元数据、版本、质量规则与治理边界。\n- 后端数据模型、业务规则、权限校验、检索与看板接口。\n- 前端检索体验、文档浏览、工作区管理与数据看板。\n- 交付验收标准与问题回流。\n\n本轮验证范围（请在交付结果中传递给下游）：产出精简、可评审的架构和输入输出契约。各节点最终只返回声明字段的 JSON，字段值控制在 1200 字以内。前端可在自己的工作目录创建一个无需依赖的 index.html 本地静态原型，并返回真实路径；明确原型中的模拟数据，不冒充已实现的后端或真实登录。其他节点以契约和文案为主。验收明确已验证和未实现项目。不要安装依赖、访问外部业务系统、发送消息、发布或部署。\n\n现有画布是本轮唯一协作结构，请对齐已有文档，不自行拆分或重新设计节点：\n1. 产品边界与架构需求；2. 用户登录与工作区权限（身份与权限为同一个节点）；3. 文档数据治理；4. 后端接口与业务规则；5. 知识库 Web 工作台；6. 交付验收；7. 知识库上线物料。\n固定的 12 条连接：产品交付结果→用户系统需求、数据治理需求、后端业务规则、物料需求（4条）；用户系统契约→后端、前端（2条）；数据字典→后端、前端（2条）；后端接口契约→前端、验收（2条）；物料清单→前端（1条）；前端交付说明→验收（1条）。\n保留最小架构原则，直接复用已完成的工作，仅修正与这七个节点、十二条连接不一致的说明。无需再制作本节点原型，前端原型留给前端节点。最终在 result 中简洁传递这个固定结构与本轮本地验证边界，followups 只列待定事项。",
          "help": "说明要解决的问题，以及最后需要拿到什么。",
          "placeholder": "目标：\n交付对象：\n完成标准："
        },
        {
          "id": "constraints",
          "label": "限制与偏好",
          "type": "markdown",
          "required": false,
          "value": "技术选型待定：\n- 身份提供方：待定，可选邮箱密码、企业 SSO、OAuth/OIDC、飞书/钉钉/企业微信等。\n- 数据库：待定，可选 PostgreSQL/MySQL 等关系型数据库。\n- 文档存储：待定，可选对象存储、本地存储或云盘集成。\n- 搜索引擎：待定，可选数据库全文检索、Elasticsearch/OpenSearch、向量检索方案。\n- 后端框架：待定。\n- 前端框架：待定。\n- 部署环境：待定，可选公有云、私有化、混合部署。\n- 观测与审计：待定。\n\n架构原则：\n- 最小可运行边界优先，保留扩展点。\n- 用户权限、数据治理、接口契约与验收标准分离。\n- 下游模块依赖上游输出，不虚构执行成果。",
          "help": "补充范围、格式或协作限制。",
          "placeholder": "必须遵守：\n不包含：\n表达风格："
        },
        {
          "id": "references",
          "label": "参考资料",
          "type": "file",
          "required": false,
          "value": "",
          "help": "引用已有资料；没有提供的内容不能视为已读取。",
          "placeholder": "资料链接或文件路径"
        }
      ],
      "outputs": [
        {
          "id": "result",
          "label": "交付结果",
          "type": "markdown",
          "required": true,
          "value": "",
          "help": "汇总实际完成的结果及可检查的证据。",
          "placeholder": "完成内容：\n交付位置：\n验证结果："
        },
        {
          "id": "followups",
          "label": "后续事项",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "记录需要用户决策或另一个 Agent 继续的工作。",
          "placeholder": "待确认问题：\n建议下一步："
        }
      ]
    },
    {
      "id": "users",
      "title": "用户登录与工作区权限",
      "persona": "负责设计团队知识库 SaaS 的账号、登录、工作区成员、角色、资源权限、审计边界与身份验证验收点。",
      "inputs": [
        {
          "id": "brief",
          "label": "用户与权限需求",
          "type": "markdown",
          "required": true,
          "value": "",
          "help": "说明哪些人以什么身份访问哪些资源。",
          "placeholder": "用户类型：\n注册 / 登录方式：\n组织或工作区：\n主要权限场景："
        },
        {
          "id": "roles",
          "label": "角色与资源",
          "type": "markdown",
          "required": false,
          "value": "最小角色建议：\n- Owner：工作区所有者，管理计费/成员/角色/全局设置。\n- Admin：管理成员、文档空间、治理规则和看板配置。\n- Editor：创建、编辑、归档文档，维护标签与元数据。\n- Viewer：查看有权限的文档、搜索与看板。\n\n资源范围：\n- 工作区 workspace。\n- 文档 document。\n- 文档集合/知识空间 collection。\n- 标签 tag。\n- 数据看板 dashboard。\n- 审计日志 audit log。\n\n权限模型待定：RBAC 为最小方案，是否扩展 ABAC/资源级 ACL 待确认。",
          "help": "按角色、资源、动作定义权限，不只列出角色名称。",
          "placeholder": "角色：\n资源：\n可执行动作：\n资源归属："
        },
        {
          "id": "policies",
          "label": "账号策略",
          "type": "markdown",
          "required": false,
          "value": "账号策略待定：\n- 登录方式待定：邮箱密码、SSO、OAuth/OIDC 或企业身份源。\n- 多工作区成员关系需要独立建模。\n- 邀请、禁用、移除、角色变更需要审计。\n- 密码策略、MFA、会话有效期、Token 策略待确认。\n- 数据隔离以 workspace_id 为核心边界。",
          "help": "补充账号和授权随生命周期变化的处理要求。",
          "placeholder": "邀请与加入：\n禁用与删除：\n会话失效：\n权限撤销："
        },
        {
          "id": "identityProviders",
          "label": "身份提供方",
          "type": "markdown",
          "required": false,
          "value": "身份提供方待定：\n- 暂不假设已有企业 IdP。\n- 需确认是否对接飞书、钉钉、企业微信、Google Workspace、Microsoft Entra ID 或自建账号系统。",
          "help": "描述现有身份服务与对接条件，密钥另行配置。",
          "placeholder": "已有账号系统：\n认证协议：\n回调与环境约束："
        }
      ],
      "outputs": [
        {
          "id": "identity",
          "label": "用户系统契约",
          "type": "markdown",
          "required": true,
          "value": "",
          "help": "供前后端与业务服务对接的认证和用户生命周期约定。",
          "placeholder": "账号与身份模型：\n认证流程：\n会话与令牌约定：\n服务接入方式："
        },
        {
          "id": "permissions",
          "label": "权限矩阵",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "给出可用于实现及测试的授权矩阵。",
          "placeholder": "角色 × 资源 × 动作：\n作用域：\n拒绝规则："
        },
        {
          "id": "checks",
          "label": "身份与权限验证",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "记录身份流程、跨作用域隔离和权限失效的检查。",
          "placeholder": "登录 / 退出：\n越权与隔离：\n撤销与失效：\n实际结果："
        }
      ]
    },
    {
      "id": "data",
      "title": "文档数据治理",
      "persona": "负责定义知识库文档、元数据、版本、标签、来源、质量规则、权限关联字段与治理边界。",
      "inputs": [
        {
          "id": "brief",
          "label": "业务需求",
          "type": "markdown",
          "required": true,
          "value": "",
          "help": "说明数据服务的业务目的及需要统一的概念。",
          "placeholder": "业务场景：\n核心实体：\n要回答的问题："
        },
        {
          "id": "sources",
          "label": "数据来源",
          "type": "markdown",
          "required": false,
          "value": "数据来源待定，最小支持范围建议：\n- 用户手动创建/编辑文档。\n- Markdown/富文本导入。\n- 文件上传后的结构化元数据登记。\n\n后续可扩展来源：\n- 第三方云文档同步。\n- 网页/知识源采集。\n- API 批量导入。\n- AI 摘要、标签、Embedding 等派生数据。",
          "help": "列明已有来源与访问条件，不在表单中填写密码。",
          "placeholder": "来源系统：\n表 / 文件：\n更新方式：\n负责人："
        },
        {
          "id": "samples",
          "label": "样本与现有字典",
          "type": "file",
          "required": false,
          "value": "",
          "help": "引用经过适当处理、允许用于当前任务的样本。",
          "placeholder": "样本文件或现有数据字典的路径 / 链接"
        },
        {
          "id": "governance",
          "label": "治理边界",
          "type": "markdown",
          "required": false,
          "value": "治理边界：\n- 文档必须归属 workspace。\n- 文档可归属 collection。\n- 文档需记录创建者、更新者、可见范围、状态、版本。\n- 标签、分类、来源、语言、更新时间可用于检索与看板。\n- 权限过滤必须在检索与详情读取中生效。\n- 数据质量规则包括必填元数据、重复标题/相似内容、孤立文档、过期文档、缺失所有者等。\n- 审计记录保留 90 天。\n\n待确认：是否需要文档级审批、保留策略、敏感信息识别、数据脱敏、跨工作区共享。",
          "help": "明确访问、质量和生命周期限制。",
          "placeholder": "访问角色：\n保留规则：\n敏感字段：\n口径约定："
        }
      ],
      "outputs": [
        {
          "id": "schema",
          "label": "数据字典",
          "type": "markdown",
          "required": true,
          "value": "",
          "help": "向后端交付一致、可实现的字段与关系定义。",
          "placeholder": "实体：\n字段 / 类型 / 必填：\n业务定义：\n关系与约束："
        },
        {
          "id": "quality",
          "label": "质量规则与问题",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "分清拟定规则与实际检查发现的问题。",
          "placeholder": "检查规则：\n观察结果：\n异常样本引用：\n修复建议："
        },
        {
          "id": "lineage",
          "label": "来源与治理说明",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "记录字段来源、处理过程和治理责任。",
          "placeholder": "来源到字段的映射：\n访问边界：\n更新 / 保留规则："
        }
      ]
    },
    {
      "id": "materials",
      "title": "知识库上线物料",
      "persona": "负责团队知识库 SaaS 上线相关物料规划与制作，包括首页文案、产品使用指南、空状态与引导文案、品牌素材清单和前端可消费的文案素材交付。不执行设计生成、文件写入或真实发布。",
      "inputs": [
        {
          "id": "brief",
          "label": "产品与品牌要求",
          "type": "markdown",
          "required": true,
          "value": "",
          "help": "明确物料表达什么，以及希望受众采取什么行动。",
          "placeholder": "产品定位：\n核心信息：\n品牌语气：\n期望行动："
        },
        {
          "id": "audience",
          "label": "目标受众",
          "type": "markdown",
          "required": false,
          "value": "目标受众：\n- 团队知识库 SaaS 的管理员、内容编辑者、普通查看成员。\n- 前端开发 Agent，用于消费页面文案、引导说明和素材清单。\n\n待确认：产品正式名称、品牌语气、Logo/图标来源、是否需要多语言。",
          "help": "说明受众的语境与理解门槛。",
          "placeholder": "受众特征：\n使用场景：\n关注点：\n语言："
        },
        {
          "id": "channels",
          "label": "渠道与规格",
          "type": "markdown",
          "required": false,
          "value": "渠道与规格：\n- Web 首页/登录入口文案。\n- Web 工作台内的空状态、引导、按钮和提示文案。\n- 使用指南：登录、选择工作区、检索文档、浏览/编辑文档、查看数据看板、成员与权限管理。\n- 品牌素材清单：Logo、图标、主色、字体、插图或截图占位需求。\n\n限制：仅定义物料需求与可交付清单，不生成真实图片文件或发布内容。",
          "help": "让物料对应具体渠道与可检查的交付规格。",
          "placeholder": "发布渠道：\n尺寸 / 格式：\n字数：\n数量："
        },
        {
          "id": "references",
          "label": "品牌与素材参考",
          "type": "file",
          "required": false,
          "value": "",
          "help": "说明哪些参考允许使用，哪些只用于风格理解。",
          "placeholder": "品牌规范、已有素材或参考案例的路径 / 链接"
        }
      ],
      "outputs": [
        {
          "id": "assets",
          "label": "文案与素材清单",
          "type": "markdown",
          "required": true,
          "value": "",
          "help": "给前端或发布方列出可用内容及所在位置。",
          "placeholder": "物料名称：\n用途与渠道：\n实际文件 / 文案位置：\n完成状态："
        },
        {
          "id": "copy",
          "label": "可用文案",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "提供可以直接使用、与受众和渠道匹配的文本。",
          "placeholder": "主标题：\n正文：\n行动按钮：\n替代版本："
        },
        {
          "id": "specifications",
          "label": "制作与使用说明",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "区分已制作文件、待制作要求和使用边界。",
          "placeholder": "格式与尺寸：\n视觉要求：\n素材来源：\n使用限制："
        }
      ]
    },
    {
      "id": "backend",
      "title": "后端接口与业务规则",
      "persona": "负责基于数据字典和用户权限契约设计后端业务模型、接口契约、权限校验、检索接口、看板接口与服务验证点。",
      "inputs": [
        {
          "id": "schema",
          "label": "数据字典",
          "type": "markdown",
          "required": true,
          "value": "",
          "help": "通常来自数据治理节点，是接口与存储设计的依据。",
          "placeholder": "实体与字段：\n字段类型与约束：\n实体关系："
        },
        {
          "id": "rules",
          "label": "业务规则",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "说明流程、校验、幂等和一致性要求。",
          "placeholder": "业务动作：\n前置条件：\n状态变化：\n失败处理："
        },
        {
          "id": "systems",
          "label": "外部依赖",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "包括用户系统的身份与授权契约，不重复设计账号体系。",
          "placeholder": "依赖服务：\n接口 / 事件契约：\n测试方式："
        },
        {
          "id": "limits",
          "label": "运行约束",
          "type": "markdown",
          "required": false,
          "value": "运行约束待定：\n- 后端语言与框架待定。\n- 数据库待定。\n- 搜索方案待定。\n- 缓存、队列、对象存储待定。\n- 部署形态待定。\n- 观测、审计、限流、备份策略待定。\n\n最小接口范围建议：\n- 登录/登出/当前用户。\n- 工作区、成员、角色管理。\n- 文档 CRUD、版本、标签、集合。\n- 权限过滤后的全文检索。\n- 数据看板指标接口。\n- 审计日志查询。",
          "help": "记录明确的运行边界；未知指标保持待确认。",
          "placeholder": "性能目标：\n存储约束：\n兼容要求：\n部署环境："
        },
        {
          "id": "identityContract",
          "label": "用户系统契约",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "来自用户系统节点的登录、工作区、角色与权限契约，用于后端权限校验和审计设计。"
        }
      ],
      "outputs": [
        {
          "id": "api",
          "label": "接口契约",
          "type": "markdown",
          "required": true,
          "value": "",
          "help": "交付前端可直接消费的字段、调用方式与错误约定。",
          "placeholder": "接口与方法：\n请求 / 响应：\n校验和错误码：\n身份与权限要求："
        },
        {
          "id": "implementation",
          "label": "服务实现说明",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "说明实际实现和必要配置，不把设计当作已部署服务。",
          "placeholder": "代码位置：\n数据变更：\n启动与配置：\n兼容说明："
        },
        {
          "id": "checks",
          "label": "服务验证",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "记录业务规则、错误路径和数据一致性的证据。",
          "placeholder": "测试场景：\n实际结果：\n并发 / 重试验证：\n未验证项："
        }
      ]
    },
    {
      "id": "frontend",
      "title": "知识库 Web 工作台",
      "persona": "负责设计并实现团队知识库 SaaS 的工作区入口、登录态、文档检索、文档管理、权限可见性和数据看板前端体验。",
      "inputs": [
        {
          "id": "api",
          "label": "接口契约",
          "type": "markdown",
          "required": true,
          "value": "",
          "help": "通常连接后端服务的接口契约；标明尚未确定的接口。",
          "placeholder": "接口：\n请求与响应字段：\n鉴权方式：\n错误约定："
        },
        {
          "id": "screens",
          "label": "页面与交互",
          "type": "markdown",
          "required": false,
          "value": "最小页面与交互范围：\n- 登录页/身份回调页。\n- 工作区选择与工作区设置。\n- 成员与角色管理。\n- 文档列表、详情、创建/编辑、标签与集合管理。\n- 全文检索结果页，需展示权限过滤后的结果。\n- 数据看板：文档总量、活跃贡献者、过期文档、缺失元数据、搜索趋势等。\n- 基础错误、空状态、加载状态、权限不足状态。\n\n设计系统、组件库、图表库待定。\n人工补充：工作区切换后保留当前检索条件。",
          "help": "描述用户如何完成任务，以及异常状态如何反馈。",
          "placeholder": "页面清单：\n关键操作：\n加载、空白与错误状态："
        },
        {
          "id": "design",
          "label": "设计参考",
          "type": "file",
          "required": false,
          "value": "",
          "help": "提供视觉与组件规范；缺少设计时说明采用的界面约定。",
          "placeholder": "设计稿、组件库或截图的链接 / 路径"
        },
        {
          "id": "assets",
          "label": "文案与素材清单",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "可连接物料制作节点，引用真实文案与素材。",
          "placeholder": "页面文案：\n素材路径：\n使用位置："
        },
        {
          "id": "accessContract",
          "label": "用户与权限契约",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "来自用户系统节点的登录态、角色与权限说明，用于前端路由守卫、菜单可见性和权限提示。"
        },
        {
          "id": "documentSchema",
          "label": "文档数据字典",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "来自数据治理节点的文档、元数据、标签、版本和质量规则，用于前端字段、筛选项和看板解释。"
        }
      ],
      "outputs": [
        {
          "id": "delivery",
          "label": "界面与交付说明",
          "type": "markdown",
          "required": true,
          "value": "",
          "help": "向验收节点交代实现范围、使用方法与实际文件。",
          "placeholder": "实现页面：\n代码位置：\n启动方式：\n已知限制："
        },
        {
          "id": "preview",
          "label": "预览入口",
          "type": "file",
          "required": false,
          "value": "",
          "help": "只填写真实存在的入口，并注明访问条件。",
          "placeholder": "可访问的预览链接或本地入口路径"
        },
        {
          "id": "checks",
          "label": "交互验证",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "记录表单、键盘、响应式和错误状态的实际验证。",
          "placeholder": "验证步骤：\n实际结果：\n设备与尺寸：\n未验证项："
        }
      ]
    },
    {
      "id": "review",
      "title": "交付验收",
      "persona": "负责根据产品目标、接口契约与前端交付物建立验收标准，核对权限、数据治理、检索、看板和端到端流程。",
      "inputs": [
        {
          "id": "delivery",
          "label": "待验收交付物",
          "type": "markdown",
          "required": true,
          "value": "",
          "help": "通常来自前端或其他生产节点，必须能定位实际交付。",
          "placeholder": "交付范围：\n文件或预览入口：\n实现说明：\n已知限制："
        },
        {
          "id": "api",
          "label": "接口契约",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "可连接后端服务，核对实现与接口约定的一致性。",
          "placeholder": "接口字段：\n状态与错误约定：\n身份和权限要求："
        },
        {
          "id": "criteria",
          "label": "验收标准",
          "type": "markdown",
          "required": false,
          "value": "最小验收范围：\n- 用户可登录、退出并获取当前身份。\n- 工作区成员与角色权限生效，越权访问被拒绝。\n- 文档数据模型覆盖工作区、集合、标签、版本、来源、状态、所有者等关键字段。\n- 后端接口契约覆盖登录、权限、文档、检索、看板、审计。\n- 前端可完成登录、工作区切换、文档检索、文档浏览/管理、数据看板查看。\n- 检索结果和看板数据遵守工作区与权限边界。\n- 待定技术选型、部署前提和风险被明确记录。\n\n不验收真实部署、真实账号、真实外部集成，除非后续节点明确执行。",
          "help": "标准缺失时先提出可检查的标准并标明待确认。",
          "placeholder": "验收场景：\n预期行为：\n通过条件：\n范围外事项："
        },
        {
          "id": "evidence",
          "label": "验证证据",
          "type": "file",
          "required": false,
          "value": "",
          "help": "引用真实证据，记录来源、时间和适用范围。",
          "placeholder": "测试报告、截图或操作记录的路径 / 链接"
        }
      ],
      "outputs": [
        {
          "id": "report",
          "label": "验收报告",
          "type": "markdown",
          "required": true,
          "value": "",
          "help": "区分通过、需修复及证据不足，不把缺少错误日志当作通过。",
          "placeholder": "结论：\n验收范围：\n已验证事实：\n未验证与受阻事项："
        },
        {
          "id": "issues",
          "label": "问题与返工清单",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "让负责实现的 Agent 能直接定位和处理问题。",
          "placeholder": "问题：\n复现步骤：\n预期 / 实际：\n影响：\n修复建议："
        },
        {
          "id": "verification",
          "label": "检查记录",
          "type": "markdown",
          "required": false,
          "value": "",
          "help": "记录结论如何得出，保留未执行检查的原因。",
          "placeholder": "检查项：\n使用证据：\n实际观察：\n覆盖限制："
        }
      ]
    }
  ],
  "wires": [
    {
      "from": "product",
      "output": "result",
      "to": "users",
      "input": "brief"
    },
    {
      "from": "product",
      "output": "result",
      "to": "data",
      "input": "brief"
    },
    {
      "from": "product",
      "output": "result",
      "to": "materials",
      "input": "brief"
    },
    {
      "from": "product",
      "output": "result",
      "to": "backend",
      "input": "rules"
    },
    {
      "from": "users",
      "output": "identity",
      "to": "backend",
      "input": "identityContract"
    },
    {
      "from": "data",
      "output": "schema",
      "to": "backend",
      "input": "schema"
    },
    {
      "from": "users",
      "output": "identity",
      "to": "frontend",
      "input": "accessContract"
    },
    {
      "from": "data",
      "output": "schema",
      "to": "frontend",
      "input": "documentSchema"
    },
    {
      "from": "backend",
      "output": "api",
      "to": "frontend",
      "input": "api"
    },
    {
      "from": "materials",
      "output": "assets",
      "to": "frontend",
      "input": "assets"
    },
    {
      "from": "backend",
      "output": "api",
      "to": "review",
      "input": "api"
    },
    {
      "from": "frontend",
      "output": "delivery",
      "to": "review",
      "input": "delivery"
    }
  ]
};
export default canvas;
