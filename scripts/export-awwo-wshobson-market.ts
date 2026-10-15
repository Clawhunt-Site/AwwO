import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TeamMarketAgent, TeamMarketCatalog } from '../apps/web/src/canvas/teamMarketAgents.ts';

/*
 * Selected wshobson/agents roles (MIT, Copyright (c) 2024 Seth Hobson) for AwwO's team market.
 *
 * The only inputs are the files the hard-coded ROLES and SKILLS allowlists name, read from the vendored LF
 * snapshot of upstream commit 7257c27 in third_party/wshobson-agents. No directory scan, environment setting or
 * manifest-selected path is read. PROVENANCE.json must list exactly those files, every byte count, sha256 and
 * git blob id must match, and every text must pass the content checks below; any failure stops the export.
 * Roles become apps/web/src/canvas/team-market-agents.wshobson.json. The built-in skills in
 * backend/internal/app/skills/ are derived from the same snapshot (see deriveWshobsonSkills); this script
 * verifies their sources and derivation but writes only the role catalogue.
 */

const ROOT = 'third_party/wshobson-agents';
export const WSHOBSON_ARTIFACT_PATH = 'apps/web/src/canvas/team-market-agents.wshobson.json';
export const WSHOBSON_PROVENANCE_PATH = `${ROOT}/PROVENANCE.json`;
const LICENSE_PATH = `${ROOT}/LICENSE`;
const UPSTREAM_COMMIT_PATH = `${ROOT}/UPSTREAM_COMMIT`;
export const WSHOBSON_UPSTREAM = {
  repository: 'https://github.com/wshobson/agents',
  commit: '7257c27db333ed9784900d32f6a3779468d95c53',
  tree: '93ab548e86ff9166afe2460b4aba25aa9b6fac36',
  marketplaceVersion: '1.7.1',
  license: 'MIT',
  copyright: 'Copyright (c) 2024 Seth Hobson',
} as const;
export const WSHOBSON_ATTRIBUTION = 'MIT · © 2024 Seth Hobson · wshobson/agents@7257c27';
const MAX_FILE_BYTES = 64_000, MAX_PROVENANCE_BYTES = 128_000, MAX_ROLE_BYTES = 24_000, MAX_SKILL_BYTES = 8_192;

export const WSHOBSON_GROUPS = [
  { id: 'business', name: 'Business', nameZh: '商业' },
  { id: 'design', name: 'Design', nameZh: '设计' },
  { id: 'growth', name: 'Growth & SEO', nameZh: '增长与 SEO' },
  { id: 'data', name: 'Data & AI', nameZh: '数据与 AI' },
  { id: 'engineering', name: 'Engineering', nameZh: '工程' },
  { id: 'security', name: 'Security', nameZh: '安全' },
  { id: 'docs', name: 'Docs & Learning', nameZh: '文档与教学' },
] as const;
type GroupId = typeof WSHOBSON_GROUPS[number]['id'];
const ROLE_VOCABULARY = ['analyst', 'designer', 'content-strategist', 'engineer', 'architect', 'qa', 'security', 'legal', 'hr', 'data-scientist', 'technical-writer'] as const;

interface RoleSpec {
  plugin: string; agent: string;
  /** The upstream frontmatter `name`; copies of a role differ upstream only by this plugin-scoped slug. */
  upstreamName: string;
  group: GroupId; name: string; role: typeof ROLE_VOCABULARY[number];
  /** Curated: the upstream description carries "Use PROACTIVELY" triggers, and Jev-style planners read descriptions. */
  description: string; descriptionZh: string;
  /** Only skills the source itself names, each checked against its text. */
  requiredSkills?: readonly string[];
}

const ROLES: readonly RoleSpec[] = [
  { plugin: 'startup-business-analyst', agent: 'startup-analyst', upstreamName: 'startup-analyst', group: 'business', name: 'Startup Analyst', role: 'analyst',
    description: 'Market sizing (TAM/SAM/SOM), unit economics, financial models and competitive strategy for pre-seed to Series A startups.',
    descriptionZh: '为早期创业公司测算市场规模，分析单位经济、财务模型与竞争策略。',
    requiredSkills: ['competitive-landscape', 'market-sizing-analysis', 'startup-financial-modeling', 'startup-metrics-framework', 'team-composition-analysis'] },
  { plugin: 'business-analytics', agent: 'business-analyst', upstreamName: 'business-analyst', group: 'business', name: 'Business Analyst', role: 'analyst',
    description: 'KPI frameworks, cohort and LTV analysis, dashboard specifications and data-backed business recommendations.',
    descriptionZh: '搭建 KPI 体系，做同期群与 LTV 分析、仪表盘方案和有数据支撑的商业建议。' },
  { plugin: 'customer-sales-automation', agent: 'sales-automator', upstreamName: 'sales-automator', group: 'business', name: 'Sales Copywriter', role: 'content-strategist',
    description: 'Cold email sequences, follow-ups, proposal templates, case studies and objection-handling scripts.',
    descriptionZh: '撰写冷启动邮件序列、跟进邮件、提案模板、客户案例和异议处理话术。' },
  { plugin: 'hr-legal-compliance', agent: 'legal-advisor', upstreamName: 'legal-advisor', group: 'business', name: 'Legal Document Drafter', role: 'legal',
    description: 'Drafts privacy policies, terms of service, cookie notices and DPAs as templates for qualified counsel to review.',
    descriptionZh: '起草隐私政策、服务条款、Cookie 声明和数据处理协议模板，须经律师审核。' },
  { plugin: 'hr-legal-compliance', agent: 'hr-pro', upstreamName: 'hr-pro', group: 'business', name: 'HR Partner', role: 'hr',
    description: 'Job descriptions, structured interview kits, onboarding plans, leave and performance policies; asks for the jurisdiction first.',
    descriptionZh: '撰写职位描述、结构化面试方案、入职计划及休假与绩效制度，先确认适用地区。' },
  { plugin: 'multi-platform-apps', agent: 'ui-ux-designer', upstreamName: 'ui-ux-designer', group: 'design', name: 'UI/UX Designer', role: 'designer',
    description: 'User research plans, user flows, information architecture, wireframes and accessible design-system guidance.',
    descriptionZh: '制定用户研究计划、用户流程、信息架构、线框图和无障碍设计规范。' },
  { plugin: 'ui-design', agent: 'ui-designer', upstreamName: 'ui-designer', group: 'design', name: 'UI Designer', role: 'designer',
    description: 'Component and layout specifications with states, responsive grids and implementation-ready CSS.',
    descriptionZh: '输出组件与布局规范，含交互状态、响应式栅格和可直接实现的 CSS。' },
  { plugin: 'ui-design', agent: 'design-system-architect', upstreamName: 'design-system-architect', group: 'design', name: 'Design System Architect', role: 'designer',
    description: 'Design token architecture, theming, multi-brand component libraries and design-system governance.',
    descriptionZh: '设计令牌架构、主题、多品牌组件库及设计系统治理。' },
  { plugin: 'ui-design', agent: 'accessibility-expert', upstreamName: 'accessibility-expert', group: 'design', name: 'Accessibility Expert', role: 'qa',
    description: 'WCAG 2.2 audits and fixes: semantics, keyboard navigation, screen-reader support, contrast and accessible components.',
    descriptionZh: '按 WCAG 2.2 审查并修复语义、键盘导航、读屏支持、对比度与无障碍组件。' },
  { plugin: 'accessibility-compliance', agent: 'ui-visual-validator', upstreamName: 'ui-visual-validator', group: 'design', name: 'Visual QA Reviewer', role: 'qa',
    description: 'Critically reviews supplied screenshots against the intended change; a goal counts as unmet until the visuals prove it.',
    descriptionZh: '对照预期改动严格审查所给截图；画面证明之前一律视为未达成。' },
  { plugin: 'c4-architecture', agent: 'c4-context', upstreamName: 'c4-context', group: 'design', name: 'System Context Mapper (C4)', role: 'architect',
    description: 'C4 system context documentation: system boundary, personas, user journeys, external systems and Mermaid diagrams.',
    descriptionZh: '编写 C4 系统上下文文档：系统边界、用户画像、用户旅程、外部系统和 Mermaid 图。' },
  { plugin: 'documentation-generation', agent: 'mermaid-expert', upstreamName: 'mermaid-expert', group: 'design', name: 'Diagram Author (Mermaid)', role: 'technical-writer',
    description: 'Mermaid flowcharts and sequence, ER, state and Gantt diagrams with clear, consistent styling.',
    descriptionZh: '绘制 Mermaid 流程图、时序图、ER 图、状态图和甘特图，风格清晰统一。' },
  { plugin: 'content-marketing', agent: 'content-marketer', upstreamName: 'content-marketer', group: 'growth', name: 'Content Marketer', role: 'content-strategist',
    description: 'Content strategy, editorial calendars, multichannel campaigns and conversion-focused copy.',
    descriptionZh: '制定内容策略、编辑日历、多渠道营销活动和以转化为目标的文案。' },
  { plugin: 'seo-content-creation', agent: 'seo-content-writer', upstreamName: 'seo-content-writer', group: 'growth', name: 'SEO Content Writer', role: 'content-strategist',
    description: 'Writes search-optimized articles from a keyword and topic brief, with title options, meta description and FAQ.',
    descriptionZh: '根据关键词和选题简报撰写 SEO 文章，附备选标题、元描述和 FAQ。' },
  { plugin: 'seo-content-creation', agent: 'seo-content-planner', upstreamName: 'seo-content-planner', group: 'growth', name: 'SEO Content Planner', role: 'content-strategist',
    description: 'Content outlines, topic clusters, pillar pages and content calendars mapped to search intent.',
    descriptionZh: '按搜索意图规划内容大纲、主题集群、支柱页面和内容日历。' },
  { plugin: 'seo-content-creation', agent: 'seo-content-auditor', upstreamName: 'seo-content-auditor', group: 'growth', name: 'SEO Content Auditor', role: 'content-strategist',
    description: 'Scores supplied content for depth, E-E-A-T signals, readability and keyword use, with prioritized fixes.',
    descriptionZh: '为所给内容的深度、E-E-A-T 信号、可读性和关键词使用打分，并列出优先修改项。' },
  { plugin: 'seo-technical-optimization', agent: 'seo-meta-optimizer', upstreamName: 'seo-meta-optimizer', group: 'growth', name: 'SEO Meta Optimizer', role: 'content-strategist',
    description: 'Meta titles, descriptions and URL slugs within character limits, in several variants to test.',
    descriptionZh: '在字符限制内撰写多版标题标签、元描述和 URL，便于测试。' },
  { plugin: 'seo-technical-optimization', agent: 'seo-structure-architect', upstreamName: 'seo-structure-architect', group: 'growth', name: 'SEO Structure Architect', role: 'content-strategist',
    description: 'Heading hierarchy, schema.org markup suggestions and internal-linking plans for search-friendly pages.',
    descriptionZh: '规划标题层级、schema.org 结构化数据建议和内链方案。' },
  { plugin: 'seo-technical-optimization', agent: 'seo-snippet-hunter', upstreamName: 'seo-snippet-hunter', group: 'growth', name: 'Featured Snippet Writer', role: 'content-strategist',
    description: 'Formats answers as paragraph, list and table blocks eligible for featured snippets and FAQ results.',
    descriptionZh: '把答案整理成适合精选摘要的段落、列表和表格，以及 FAQ。' },
  { plugin: 'seo-analysis-monitoring', agent: 'seo-authority-builder', upstreamName: 'seo-authority-builder', group: 'growth', name: 'E-E-A-T Authority Builder', role: 'content-strategist',
    description: 'Finds missing experience, expertise, authority and trust signals in content and plans how to add them.',
    descriptionZh: '找出内容缺少的经验、专业、权威与可信信号，并规划如何补充。' },
  { plugin: 'machine-learning-ops', agent: 'data-scientist', upstreamName: 'data-scientist', group: 'data', name: 'Data Scientist', role: 'data-scientist',
    description: 'Analysis plans, statistical tests, experiment design and model code for data the user supplies.',
    descriptionZh: '针对用户提供的数据制定分析计划、统计检验、实验设计和建模代码。' },
  { plugin: 'database-design', agent: 'sql-pro', upstreamName: 'sql-pro', group: 'data', name: 'SQL Expert', role: 'engineer',
    description: 'Complex queries, indexing strategies and query tuning for transactional and analytical databases.',
    descriptionZh: '编写复杂 SQL、设计索引策略，并为事务型与分析型数据库调优查询。' },
  { plugin: 'database-design', agent: 'database-architect', upstreamName: 'database-design-database-architect', group: 'data', name: 'Database Architect', role: 'architect',
    description: 'Database technology choice, schema modeling, scaling strategy and migration plans for new or existing systems.',
    descriptionZh: '为新建或现有系统做数据库选型、模式建模、扩展策略和迁移方案。' },
  { plugin: 'llm-application-dev', agent: 'prompt-engineer', upstreamName: 'prompt-engineer', group: 'data', name: 'Prompt Engineer', role: 'engineer',
    description: 'Writes complete production prompts and system prompts, with the techniques chosen and evaluation notes.',
    descriptionZh: '撰写完整的生产级提示词与系统提示词，并说明所用技巧和评估要点。' },
  { plugin: 'llm-application-dev', agent: 'ai-engineer', upstreamName: 'ai-engineer', group: 'data', name: 'AI Application Engineer', role: 'engineer',
    description: 'Designs LLM applications: RAG pipelines, agent architectures, vector search and production safeguards.',
    descriptionZh: '设计大模型应用：RAG 流程、智能体架构、向量检索和生产防护。' },
  { plugin: 'comprehensive-review', agent: 'architect-review', upstreamName: 'comprehensive-review-architect-review', group: 'engineering', name: 'Architecture Reviewer', role: 'architect',
    description: 'Reviews system designs and changes for boundaries, patterns, scalability and maintainability.',
    descriptionZh: '审查系统设计与改动的边界划分、模式运用、可扩展性和可维护性。' },
  { plugin: 'comprehensive-review', agent: 'code-reviewer', upstreamName: 'comprehensive-review-code-reviewer', group: 'engineering', name: 'Code Reviewer', role: 'qa',
    description: 'Reviews supplied code for correctness, security, performance and maintainability, with prioritized findings.',
    descriptionZh: '审查所给代码的正确性、安全性、性能和可维护性，按优先级列出问题。' },
  { plugin: 'api-scaffolding', agent: 'backend-architect', upstreamName: 'api-scaffolding-backend-architect', group: 'engineering', name: 'Backend Architect', role: 'architect',
    description: 'API and service design: REST, GraphQL and gRPC contracts, service boundaries, events, resilience and observability.',
    descriptionZh: '设计 API 与服务：REST/GraphQL/gRPC 契约、服务边界、事件、韧性与可观测性。' },
  { plugin: 'application-performance', agent: 'frontend-developer', upstreamName: 'application-performance-frontend-developer', group: 'engineering', name: 'Frontend Developer', role: 'engineer',
    description: 'React and Next.js components, responsive layouts and client state, with performance and accessibility fixes.',
    descriptionZh: '开发 React 与 Next.js 组件、响应式布局和客户端状态，并优化性能与无障碍。' },
  { plugin: 'backend-development', agent: 'test-automator', upstreamName: 'backend-development-test-automator', group: 'engineering', name: 'Test Designer', role: 'qa',
    description: "Designs unit, integration and end-to-end test suites that follow the project's existing patterns.",
    descriptionZh: '按项目现有约定设计单元测试、集成测试和端到端测试。' },
  { plugin: 'backend-development', agent: 'performance-engineer', upstreamName: 'backend-development-performance-engineer', group: 'engineering', name: 'Performance Reviewer', role: 'engineer',
    description: 'Finds likely bottlenecks in supplied code, queries and architecture and recommends measurable optimizations.',
    descriptionZh: '从所给代码、查询和架构中找出可能的性能瓶颈，给出可度量的优化建议。' },
  { plugin: 'cloud-infrastructure', agent: 'cloud-architect', upstreamName: 'cloud-infrastructure-cloud-architect', group: 'engineering', name: 'Cloud Architect', role: 'architect',
    description: 'Multi-cloud architecture, infrastructure as code, cost optimization, security and disaster-recovery design.',
    descriptionZh: '设计多云架构、基础设施即代码、成本优化、安全与容灾方案。' },
  { plugin: 'backend-development', agent: 'security-auditor', upstreamName: 'backend-development-security-auditor', group: 'security', name: 'Security Reviewer', role: 'security',
    description: 'Reviews supplied code and architecture for OWASP Top 10 and auth flaws, reporting severity, location and fix.',
    descriptionZh: '按 OWASP Top 10 与认证缺陷审查所给代码和架构，报告严重度、位置与修复。' },
  { plugin: 'security-scanning', agent: 'threat-modeling-expert', upstreamName: 'threat-modeling-expert', group: 'security', name: 'Threat Modeler', role: 'security',
    description: 'STRIDE threat models, attack trees, risk ranking and mitigations for a described system.',
    descriptionZh: '为所描述的系统做 STRIDE 威胁建模、攻击树、风险排序和缓解措施。' },
  { plugin: 'backend-api-security', agent: 'backend-security-coder', upstreamName: 'backend-api-security-backend-security-coder', group: 'security', name: 'Backend Security Coder', role: 'security',
    description: 'Secure backend code: input validation, authentication and authorization, injection prevention and API hardening.',
    descriptionZh: '编写安全的后端代码：输入校验、认证与授权、注入防护和 API 加固。' },
  { plugin: 'frontend-mobile-security', agent: 'frontend-security-coder', upstreamName: 'frontend-security-coder', group: 'security', name: 'Frontend Security Coder', role: 'security',
    description: 'Secure frontend code: XSS prevention, output sanitization, Content Security Policy and safe client-side patterns.',
    descriptionZh: '编写安全的前端代码：XSS 防护、输出清洗、内容安全策略和安全的客户端模式。' },
  { plugin: 'documentation-generation', agent: 'docs-architect', upstreamName: 'documentation-generation-docs-architect', group: 'docs', name: 'Technical Docs Architect', role: 'technical-writer',
    description: 'Long-form system documentation from supplied code and notes: architecture, design decisions and component guides.',
    descriptionZh: '根据所给代码与资料编写长篇系统文档：架构、设计决策和组件说明。' },
  { plugin: 'documentation-generation', agent: 'api-documenter', upstreamName: 'documentation-generation-api-documenter', group: 'docs', name: 'API Documenter', role: 'technical-writer',
    description: 'OpenAPI 3.1 specifications, endpoint references, authentication guides and example requests.',
    descriptionZh: '编写 OpenAPI 3.1 规范、接口参考、认证指南和请求示例。' },
  { plugin: 'documentation-generation', agent: 'tutorial-engineer', upstreamName: 'documentation-generation-tutorial-engineer', group: 'docs', name: 'Tutorial Author', role: 'technical-writer',
    description: 'Step-by-step tutorials with learning objectives, progressive examples, exercises and common pitfalls.',
    descriptionZh: '编写分步教程：学习目标、循序渐进的示例、练习和常见错误。' },
];

interface SkillSpec {
  plugin: string; skill: string;
  /** Exact upstream spans removed from the body, each one pointing at a file the model cannot open. */
  drop?: readonly string[];
  /** Vendored files (relative to the skill folder) appended verbatim after one blank line. */
  append?: readonly string[];
  /** Reviewed framework syntax that would otherwise trip the markup check; each occurrence must sit inside a code fence. */
  fencedMarkup?: readonly string[];
}

const DETAILS_POINTER = '## Detailed patterns and worked examples\n\nDetailed pattern documentation lives in `references/details.md`. '
  + 'Read that file when the navigation tier above is insufficient.\n\n';
const SKILLS: readonly SkillSpec[] = [
  { plugin: 'before-you-build', skill: 'before-you-build', append: ['references/risk-checklist.md'],
    drop: ['If the verdict is not obvious, use `references/risk-checklist.md` for deeper questions.\n\n'] },
  { plugin: 'skill-forge-essentials', skill: 'ai-debt-detector' },
  { plugin: 'ui-design', skill: 'visual-design-foundations' },
  { plugin: 'ui-design', skill: 'interaction-design' },
  { plugin: 'ui-design', skill: 'web-component-design', fencedMarkup: ['<script setup lang="ts">', '<script lang="ts">'] },
  { plugin: 'database-design', skill: 'postgresql-table-design', drop: [
    ' The full data-type catalog, workload\npatterns (update-heavy, insert-heavy, upsert, schema evolution), extensions, JSONB indexing,\n'
      + 'and worked DDL examples are in `references/details.md`; open it when a section below points there.',
    '- Arrays, ranges, network, geometric, full-text, domain, composite, and vector types, plus TOAST storage and collation control: '
      + 'see `references/details.md`.\n',
    '\n## Going deeper\n\n`references/details.md` holds the material this file only names:\n\n'
      + '- The full data-type catalog: TOAST storage, collations, arrays, ranges, network, geometric, text search, domains, composites, vectors.\n'
      + '- Table types (`TEMPORARY`, `UNLOGGED`) and row-level security.\n'
      + '- Constraint and index notes, and partitioning DDL for RANGE, LIST, and HASH.\n'
      + '- Workload patterns: update-heavy, insert-heavy, upsert design, safe schema evolution.\n'
      + '- Generated columns and extensions (`pg_trgm`, `citext`, `timescaledb`, `postgis`, `pgvector`, and more).\n'
      + '- JSONB indexing strategies, including `jsonb_path_ops` and extracted B-tree columns.\n'] },
  { plugin: 'developer-essentials', skill: 'sql-optimization-patterns', drop: [DETAILS_POINTER] },
  { plugin: 'backend-development', skill: 'api-design-principles', drop: [DETAILS_POINTER], append: ['assets/api-design-checklist.md'] },
  { plugin: 'backend-development', skill: 'architecture-patterns', drop: [DETAILS_POINTER,
    '## Advanced Patterns\n\nFor detailed DDD bounded context mapping, full multi-service project trees, Anti-Corruption Layer implementations, '
      + 'and Onion Architecture comparisons, see:\n\n- [`references/advanced-patterns.md`](references/advanced-patterns.md)\n\n'] },
  { plugin: 'developer-essentials', skill: 'debugging-strategies',
    drop: ['Before selecting debugging tools or performing bisect, differential, trace, or memory analysis, read `references/tools-and-techniques.md`.\n\n'] },
  { plugin: 'startup-business-analyst', skill: 'competitive-landscape',
    drop: ['Before evaluating market forces or creating a blue-ocean strategy, read [the five-forces and blue-ocean frameworks](references/market-forces-and-blue-ocean.md).\n\n'] },
  { plugin: 'startup-business-analyst', skill: 'startup-financial-modeling',
    drop: ["## Detailed section: Step-by-Step Process\n\nOriginally a 2763-byte section in this SKILL.md. Moved to `references/details.md` to fit Codex's 8 KB skill body cap.\n\n"] },
  { plugin: 'business-analytics', skill: 'kpi-dashboard-design', drop: ['## Detailed worked examples and patterns\n\nDetailed sections (starting with `## Common KPIs by Department`) '
    + 'live in `references/details.md`. Read that file when the navigation summary above is insufficient.\n\n'] },
  { plugin: 'incident-response', skill: 'postmortem-writing',
    drop: ['Full template library and detailed worked examples live in `references/details.md`. Read that file when you need the concrete templates.\n\n'] },
];

type Kind = 'agent' | 'skill' | 'skill-reference' | 'plugin-manifest';
const rolePath = (spec: RoleSpec) => `plugins/${spec.plugin}/agents/${spec.agent}.md`;
const skillFolder = (spec: SkillSpec) => `plugins/${spec.plugin}/skills/${spec.skill}`;
const manifestPath = (plugin: string) => `plugins/${plugin}/.claude-plugin/plugin.json`;
/** Snapshot-relative path -> kind: exactly the files PROVENANCE.json must declare. */
const SNAPSHOT = new Map<string, Kind>([
  ...ROLES.map(spec => [rolePath(spec), 'agent'] as const),
  ...SKILLS.map(spec => [`${skillFolder(spec)}/SKILL.md`, 'skill'] as const),
  ...SKILLS.flatMap(spec => (spec.append ?? []).map(file => [`${skillFolder(spec)}/${file}`, 'skill-reference'] as const)),
  ...[...new Set([...ROLES, ...SKILLS].map(spec => spec.plugin))].sort().map(plugin => [manifestPath(plugin), 'plugin-manifest'] as const),
]);
export const WSHOBSON_SOURCE_PATHS: readonly string[] = [WSHOBSON_PROVENANCE_PATH, LICENSE_PATH, UPSTREAM_COMMIT_PATH, ...[...SNAPSHOT.keys()].map(path => `${ROOT}/${path}`)];
const allowed = new Set(WSHOBSON_SOURCE_PATHS);

// Control characters other than tab and newline, invisible formatting, bidirectional controls and the tag block.
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/u;
const MARKUP = /<!--|<script|data:text\/html|base64,/i;
const INJECTION = new RegExp(['ignore (?:all |any )?(?:previous|prior|above) instructions', 'disregard (?:the |your )?(?:system|previous)', 'new system prompt',
  'exfiltrat', 'send (?:your|the) (?:api[_ ]?key|token|credentials)', 'curl [^\\n|]*\\|\\s*(?:ba)?sh\\b', 'AI READING INSTRUCTION', 'ANTHROPIC_BASE_URL',
  'enableAllProjectMcpServers'].join('|'), 'i');
const EMOJI = /[\p{Emoji_Presentation}\p{Emoji_Modifier}\u{FE0F}\u{20E3}\u{1F000}-\u{1FAFF}]/u;
const FILE_POINTER = /\b(?:references|assets|scripts|examples)\/[\w.-]+/;

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const gitBlob = (bytes: Uint8Array) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provenance structure');
  return value as RecordValue;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing provenance metadata');
  return value;
}
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/** Fenced code ranges ([start, end) offsets). An unclosed fence is refused: it would hide the rest of the file. */
function fences(path: string, source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let open: { start: number; marker: string } | null = null, offset = 0;
  for (const line of source.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence && !open) open = { start: offset, marker: fence[1] };
    else if (fence && open && fence[1][0] === open.marker[0] && fence[1].length >= open.marker.length && line.trim() === fence[1]) {
      ranges.push([open.start, offset + line.length]); open = null;
    }
    offset += line.length + 1;
  }
  if (open) throw new Error(`${path}: unclosed code fence`);
  return ranges;
}

/** Strict text checks; reviewed framework markup is blanked only where it sits inside a code fence. */
export function assertWshobsonText(path: string, source: string, fencedMarkup: readonly string[] = []): void {
  if (source.includes('\r')) throw new Error(`${path}: carriage return (the snapshot is LF only)`);
  if (HIDDEN.test(source)) throw new Error(`${path}: invisible, bidirectional, tag or control character`);
  if (INJECTION.test(source)) throw new Error(`${path}: instruction-injection phrase`);
  let scanned = source;
  const ranges = fencedMarkup.length ? fences(path, source) : [];
  for (const snippet of fencedMarkup) {
    let at = source.indexOf(snippet), seen = 0;
    while (at >= 0) {
      if (!ranges.some(([start, end]) => at >= start && at + snippet.length <= end)) throw new Error(`${path}: reviewed markup outside a code fence`);
      scanned = `${scanned.slice(0, at)}${' '.repeat(snippet.length)}${scanned.slice(at + snippet.length)}`;
      seen += 1; at = source.indexOf(snippet, at + snippet.length);
    }
    if (!seen) throw new Error(`${path}: a reviewed markup allowance no longer matches; review it`);
  }
  if (MARKUP.test(scanned)) throw new Error(`${path}: hidden markup or embedded payload`);
}

/**
 * Role and skill frontmatter is a limited format: `key: value` lines with plain single-line values, from a fixed key
 * set. A skill (never a role) may fold its description with `>-` and two-space continuation lines; AwwO drops
 * skill frontmatter, while a role's frontmatter ships inside its instructions.
 */
export function parseWshobsonFrontmatter(path: string, source: string, keys: readonly string[], folded: readonly string[] = []): { fields: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!match) throw new Error(`${path}: frontmatter is missing`);
  const fields: Record<string, string> = {};
  const lines = match[1].split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^([a-z]+): (.+)$/.exec(lines[index]);
    if (!field || !keys.includes(field[1]) || Object.hasOwn(fields, field[1])) throw new Error(`${path}: unexpected, duplicate or malformed frontmatter`);
    let value = field[2];
    if (value === '>-' && folded.includes(field[1])) {
      const parts: string[] = [];
      while (index + 1 < lines.length && /^ {2}\S/.test(lines[index + 1])) parts.push(lines[(index += 1)].slice(2).trimEnd());
      if (!parts.length) throw new Error(`${path}: empty folded value`);
      value = parts.join(' ');
    } else if (!/^[A-Za-z0-9]/.test(value) || value !== value.trimEnd()) throw new Error(`${path}: frontmatter values must be plain single-line scalars`);
    fields[field[1]] = value;
  }
  return { fields, body: source.slice(match[0].length) };
}

export interface WshobsonSkill { name: string; plugin: string; author: string; upstreamPath: string; body: string; sha256: string }
export interface WshobsonSnapshot { catalog: TeamMarketCatalog; skills: WshobsonSkill[] }

function curatedText(id: string, english: string, chinese: string): void {
  if (!english.trim() || english.includes('\n') || [...english].length > 140) throw new Error(`${id}: the description must be one line of at most 140 characters`);
  if (!/\p{Script=Han}/u.test(chinese) || chinese.includes('\n') || [...chinese].length > 60) throw new Error(`${id}: the Chinese description must be one line of at most 60 characters`);
  if (/proactive/i.test(`${english}${chinese}`)) throw new Error(`${id}: descriptions must not carry upstream trigger phrases`);
}

type SourceFile = { bytes: Buffer; text: string; hash: string };
type VerifiedFile = SourceFile & { blob: string };
type Manifest = { hash: string; author: string; version: string };
type Verify = (path: string) => Promise<VerifiedFile>;

/** The hardened reader: allowlist, lstat, no symlink, realpath === path, size cap, no BOM, fatal UTF-8, sha256. */
function snapshotReader(root: string): (path: string, cap: number) => Promise<SourceFile> {
  return async (path, cap) => {
    if (!allowed.has(path)) throw new Error('Source path is not allowlisted');
    const absolute = resolve(root, path);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(absolute) !== absolute || info.size > cap) throw new Error(`Unsafe catalogue source: ${path}`);
    const bytes = await readFile(absolute);
    if (bytes.length > cap) throw new Error(`Unsafe catalogue source: ${path}`);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error(`${path}: byte-order mark`);
    return { bytes, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), hash: sha256(bytes) };
  };
}

/** PROVENANCE must describe the pinned snapshot and list exactly the allowlisted files; `verify` reads one and checks its digests. */
async function openProvenance(source: (path: string, cap: number) => Promise<SourceFile>): Promise<{ hash: string; licenseText: string; declared: Map<string, RecordValue>; verify: Verify }> {
  const provenanceSource = await source(WSHOBSON_PROVENANCE_PATH, MAX_PROVENANCE_BYTES);
  const provenance = record(JSON.parse(provenanceSource.text));
  if (provenance.schemaVersion !== 1) throw new Error('Unsupported provenance version');
  const upstream = record(provenance.upstream);
  for (const [key, value] of Object.entries(WSHOBSON_UPSTREAM)) if (upstream[key] !== value) throw new Error('Provenance does not describe the pinned upstream snapshot');
  const commitFile = await source(UPSTREAM_COMMIT_PATH, 1_000);
  if (!commitFile.text.startsWith(`repo: ${WSHOBSON_UPSTREAM.repository}\ncommit: ${WSHOBSON_UPSTREAM.commit}\ntree: ${WSHOBSON_UPSTREAM.tree}\n`)) throw new Error('UPSTREAM_COMMIT disagrees with the pinned snapshot');
  const licenseFile = record(upstream.licenseFile);
  const license = await source(LICENSE_PATH, 4_000);
  if (licenseFile.path !== 'LICENSE' || licenseFile.bytes !== license.bytes.length || licenseFile.sha256 !== license.hash || licenseFile.gitBlob !== gitBlob(license.bytes)
    || !license.text.startsWith(`MIT License\n\n${WSHOBSON_UPSTREAM.copyright}\n\nPermission is hereby granted, free of charge,`)) throw new Error('Upstream LICENSE does not match the provenance');
  const declared = new Map<string, RecordValue>();
  for (const entry of (Array.isArray(provenance.files) ? provenance.files : []).map(record)) {
    const path = text(entry.path);
    if (declared.has(path)) throw new Error('Provenance lists a file twice');
    declared.set(path, entry);
  }
  if (declared.size !== SNAPSHOT.size || [...SNAPSHOT.keys()].some(path => !declared.has(path))) throw new Error('Provenance and the source allowlist differ; review both');
  const verify: Verify = async path => {
    const entry = declared.get(path)!;
    const value = await source(`${ROOT}/${path}`, MAX_FILE_BYTES);
    const blob = gitBlob(value.bytes);
    if (entry.kind !== SNAPSHOT.get(path) || entry.bytes !== value.bytes.length || entry.sha256 !== value.hash || entry.gitBlob !== blob || entry.plugin !== path.split('/')[1]) {
      throw new Error(`Source digest mismatch: ${path}; re-vendor and review the snapshot first`);
    }
    return { ...value, blob };
  };
  return { hash: provenanceSource.hash, licenseText: license.text, declared, verify };
}

/** Every plugin a selected file belongs to must declare MIT, and PROVENANCE must agree with its version, licence and author. */
async function readManifests(declared: Map<string, RecordValue>, verify: Verify): Promise<Map<string, Manifest>> {
  const manifests = new Map<string, Manifest>();
  for (const [path, kind] of SNAPSHOT) {
    if (kind !== 'plugin-manifest') continue;
    const file = await verify(path);
    assertWshobsonText(path, file.text);
    const manifest = record(JSON.parse(file.text));
    const author = typeof manifest.author === 'string' ? manifest.author : text(record(manifest.author).name);
    if (manifest.name !== path.split('/')[1] || manifest.license !== 'MIT') throw new Error(`${path}: only MIT plugins may be imported`);
    manifests.set(text(manifest.name), { hash: file.hash, author, version: text(manifest.version) });
  }
  for (const [path, entry] of declared) {
    const manifest = manifests.get(path.split('/')[1]);
    if (!manifest || entry.pluginLicense !== 'MIT' || entry.pluginAuthor !== manifest.author || entry.pluginVersion !== manifest.version) throw new Error(`Provenance plugin metadata is stale: ${path}`);
  }
  return manifests;
}

function roleRecord(spec: RoleSpec, path: string, file: VerifiedFile, manifest: Manifest, requiredSkills: string[]): TeamMarketAgent {
  const group = WSHOBSON_GROUPS.find(item => item.id === spec.group)!;
  return { id: `wshobson:${spec.plugin}:${spec.agent}`, name: spec.name, role: spec.role, description: spec.description, descriptionZh: spec.descriptionZh,
    instructions: file.text,
    source: { path: `${ROOT}/${path}`, sha256: file.hash, teamId: `wshobson:${group.id}`, teamName: group.name, teamNameZh: group.nameZh,
      teamPath: `${ROOT}/${manifestPath(spec.plugin)}`, teamSha256: manifest.hash,
      upstream: { repository: WSHOBSON_UPSTREAM.repository, commit: WSHOBSON_UPSTREAM.commit, path, gitBlob: file.blob },
      license: WSHOBSON_UPSTREAM.license, copyright: WSHOBSON_UPSTREAM.copyright, author: manifest.author, attribution: WSHOBSON_ATTRIBUTION },
    requiredSkills, skillsInstalled: false };
}

async function exportRoles(verify: Verify, manifests: Map<string, Manifest>): Promise<TeamMarketAgent[]> {
  const bodies = new Set<string>(), labels = new Set<string>();
  const agents: TeamMarketAgent[] = [];
  for (const spec of ROLES) {
    const path = rolePath(spec), id = `wshobson:${spec.plugin}:${spec.agent}`;
    const file = await verify(path);
    assertWshobsonText(path, file.text);
    if (file.bytes.length > MAX_ROLE_BYTES) throw new Error(`${path}: role exceeds ${MAX_ROLE_BYTES} bytes`);
    const { fields, body } = parseWshobsonFrontmatter(path, file.text, ['name', 'description', 'model', 'color']);
    if (fields.name !== spec.upstreamName) throw new Error(`${path}: upstream name does not match the allowlist`);
    if (bodies.has(body)) throw new Error(`${path}: duplicate role body`);
    bodies.add(body);
    const requiredSkills = [...(spec.requiredSkills ?? [])].sort();
    if (requiredSkills.some(skill => !new RegExp(`^- ${skill}$`, 'm').test(body))) throw new Error(`${path}: a required skill is not named by the source`);
    curatedText(id, spec.description, spec.descriptionZh);
    if (!ROLE_VOCABULARY.includes(spec.role) || labels.has(`${spec.name}|${spec.group}`)) throw new Error(`${id}: invalid or duplicate role label`);
    labels.add(`${spec.name}|${spec.group}`);
    agents.push(roleRecord(spec, path, file, manifests.get(spec.plugin)!, requiredSkills));
  }
  if (new Set(agents.map(agent => agent.id)).size !== ROLES.length) throw new Error('Expected distinct wshobson roles');
  return agents;
}

/** Built-in skill bodies: the upstream body without its pointers to unavailable files, plus whole vendored excerpts. */
async function deriveSkills(verify: Verify, manifests: Map<string, Manifest>): Promise<WshobsonSkill[]> {
  const skills: WshobsonSkill[] = [];
  for (const spec of SKILLS) {
    const path = `${skillFolder(spec)}/SKILL.md`;
    const file = await verify(path);
    assertWshobsonText(path, file.text, spec.fencedMarkup);
    const { fields, body } = parseWshobsonFrontmatter(path, file.text, ['name', 'description', 'version'], ['description']);
    if (fields.name !== spec.skill) throw new Error(`${path}: upstream name does not match the allowlist`);
    let derived = body;
    for (const span of spec.drop ?? []) {
      if (count(derived, span) !== 1) throw new Error(`${path}: a dropped span must occur exactly once`);
      derived = derived.replace(span, () => '');
    }
    derived = derived.replace(/^\n+/, '').replace(/\n+$/, '');
    for (const extra of spec.append ?? []) {
      const extraPath = `${skillFolder(spec)}/${extra}`;
      const appended = await verify(extraPath);
      assertWshobsonText(extraPath, appended.text);
      derived = `${derived}\n\n${appended.text.replace(/\n+$/, '')}`;
    }
    derived += '\n';
    if (FILE_POINTER.test(derived)) throw new Error(`${path}: the derived skill still names a file the model cannot open`);
    if (EMOJI.test(derived)) throw new Error(`${path}: emoji in a derived skill`);
    if (Buffer.byteLength(derived) > MAX_SKILL_BYTES) throw new Error(`${path}: the derived skill exceeds ${MAX_SKILL_BYTES} bytes`);
    skills.push({ name: spec.skill, plugin: spec.plugin, author: manifests.get(spec.plugin)!.author, upstreamPath: path, body: derived, sha256: sha256(derived) });
  }
  return skills;
}

export async function readWshobsonSnapshot(repositoryRoot: string): Promise<WshobsonSnapshot> {
  const snapshot = await openProvenance(snapshotReader(await realpath(repositoryRoot)));
  const manifests = await readManifests(snapshot.declared, snapshot.verify);
  const agents = await exportRoles(snapshot.verify, manifests);
  const skills = await deriveSkills(snapshot.verify, manifests);
  return { catalog: { schemaVersion: 1, source: { path: WSHOBSON_PROVENANCE_PATH, sha256: snapshot.hash, packageName: 'wshobson/agents',
    packageVersion: `${WSHOBSON_UPSTREAM.marketplaceVersion}+${WSHOBSON_UPSTREAM.commit.slice(0, 7)}`, repository: WSHOBSON_UPSTREAM.repository,
    commit: WSHOBSON_UPSTREAM.commit, license: WSHOBSON_UPSTREAM.license, copyright: WSHOBSON_UPSTREAM.copyright, licenseText: snapshot.licenseText }, agents }, skills };
}

export async function buildWshobsonMarketCatalog(repositoryRoot: string): Promise<TeamMarketCatalog> { return (await readWshobsonSnapshot(repositoryRoot)).catalog; }
export async function deriveWshobsonSkills(repositoryRoot: string): Promise<WshobsonSkill[]> { return (await readWshobsonSnapshot(repositoryRoot)).skills; }
export function serializeWshobsonMarketCatalog(catalog: TeamMarketCatalog): string { return `${JSON.stringify(catalog, null, 2)}\n`; }

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const generated = serializeWshobsonMarketCatalog(await buildWshobsonMarketCatalog(root));
  const target = resolve(root, WSHOBSON_ARTIFACT_PATH);
  if (process.argv.slice(2).includes('--check')) {
    if (await readFile(target, 'utf8') !== generated) throw new Error('wshobson market artifact is stale; run scripts/export-awwo-wshobson-market.ts');
    process.stdout.write(`wshobson market catalogue verified: ${ROLES.length} roles, ${SKILLS.length} skill sources.\n`);
  } else {
    await writeFile(target, generated);
    process.stdout.write(`wshobson market catalogue generated: ${ROLES.length} roles, ${SKILLS.length} skill sources verified.\n`);
  }
}
