import type { AgentTemplateId } from '../canvas/agentTemplates';
import type { UiLocale } from '../locale';

/** Curated examples for the workspace home. Choosing one only fills the prompt box: the operator
 * reads and adapts it before anything is planned. Every prompt asks for unknown facts to be
 * listed for confirmation rather than invented. */
export type CaseCategory = 'software' | 'data' | 'content' | 'growth' | 'research';
type Localized = Readonly<Record<UiLocale, string>>;

export const CASE_CATEGORIES: ReadonlyArray<{ id: CaseCategory; label: Localized }> = [
  { id: 'software', label: { zh: '软件产品', en: 'Software products' } },
  { id: 'data', label: { zh: '数据分析', en: 'Data analysis' } },
  { id: 'content', label: { zh: '内容营销', en: 'Content marketing' } },
  { id: 'growth', label: { zh: '运营增长', en: 'Growth & operations' } },
  { id: 'research', label: { zh: '研究报告', en: 'Research reports' } },
];

type SketchNode = { id: string; templateId: AgentTemplateId; x: number; y: number; w: number; h: number };
/** Geometry only, in the shape CanvasThumbnail reads: the likely shape of the plan, not a plan. */
export type CaseSketch = { nodes: SketchNode[]; edges: Array<{ fromNode: string; toNode: string }> };

const COLUMN_SPACING = 420;
const ROW_SPACING = 300;
const NODE_WIDTH = 300;
const NODE_HEIGHT = 190;

/** Lays roles out left to right, one column per step, rows centred on the same line. Node ids are
 * `column.row`. Without explicit links every node feeds every node of the next column. */
export function caseSketch(columns: ReadonlyArray<ReadonlyArray<AgentTemplateId>>, links?: ReadonlyArray<readonly [string, string]>): CaseSketch {
  const nodes = columns.flatMap((column, x) => column.map((templateId, y) => ({
    id: `${x}.${y}`, templateId, x: x * COLUMN_SPACING,
    y: (y - (column.length - 1) / 2) * ROW_SPACING - NODE_HEIGHT / 2, w: NODE_WIDTH, h: NODE_HEIGHT,
  })));
  const edges = links
    ? links.map(([fromNode, toNode]) => ({ fromNode, toNode }))
    : columns.slice(0, -1).flatMap((column, x) => column.flatMap((_, from) =>
      columns[x + 1].map((__, to) => ({ fromNode: `${x}.${from}`, toNode: `${x + 1}.${to}` }))));
  return { nodes, edges };
}

export interface StarterCase {
  id: string;
  category: CaseCategory;
  title: Localized;
  summary: Localized;
  prompt: Localized;
  sketch: CaseSketch;
}

export const STARTER_CASES: ReadonlyArray<StarterCase> = [
  {
    id: 'team-collaboration-saas', category: 'software',
    title: { zh: '团队协作 SaaS', en: 'Team collaboration SaaS' },
    summary: { zh: '邮箱注册、团队角色、任务看板与团队数据看板。', en: 'Email sign-up, team roles, a task board and a team dashboard.' },
    prompt: {
      zh: '做一个面向中小团队的任务协作 SaaS：成员用邮箱注册登录，可以创建或加入团队，角色分为所有者、成员、只读三种；核心功能是任务看板（创建、指派、状态流转）和团队数据看板（任务完成情况、成员负载）。请安排数据字典、后端接口、用户与权限、前端页面和交付验收，交付接口契约、页面说明和验收报告。',
      en: 'Build a task collaboration SaaS for small and mid-sized teams: members sign up and sign in with email, can create or join a team, and hold one of three roles: owner, member or read-only. The core features are a task board (create, assign, move through statuses) and a team dashboard (task completion, member workload). Plan the data dictionary, backend API, users and permissions, frontend pages and delivery review, and deliver the API contract, page notes and a review report.',
    },
    sketch: caseSketch([['data', 'users'], ['backend'], ['frontend'], ['review']]),
  },
  {
    id: 'purchase-approval', category: 'software',
    title: { zh: '采购审批工具', en: 'Purchase approval tool' },
    summary: { zh: '把表格和群聊里的采购审批变成分级、留痕的线上流程。', en: 'Turn spreadsheet-and-chat purchase approvals into a tiered, traceable online flow.' },
    prompt: {
      zh: '把公司现在用表格和群聊处理的采购审批改成内部线上工具：员工提交申请并上传报价附件，部门负责人和财务按金额分级审批，可以驳回并留言，每一步都留痕、可查询。请梳理审批单的数据结构、状态流转和分级规则、角色权限、提交与审批页面，最后按验收清单逐项核对。金额分级阈值和组织架构列为待确认。',
      en: 'Replace the purchase approvals our company now handles in spreadsheets and group chats with an internal online tool: employees submit requests and upload quotation attachments, department heads and finance approve in tiers by amount, approvers can reject with a comment, and every step is recorded and searchable. Work out the approval form’s data structure, status flow and tier rules, role permissions, and the submission and approval pages, then check each item against an acceptance checklist. List the amount thresholds and the organization structure as to be confirmed.',
    },
    sketch: caseSketch([['data'], ['backend', 'users'], ['frontend'], ['review']]),
  },
  {
    id: 'product-site-trial', category: 'software',
    title: { zh: '产品官网与试用申请', en: 'Product website and trial sign-up' },
    summary: { zh: '官网页面、试用申请与名单导出，上线前交付验收。', en: 'Website pages, trial requests with list export, and a review before launch.' },
    prompt: {
      zh: '为一款新上线的 AI 笔记应用做官网和试用申请：官网包含首页、功能介绍、价格说明和常见问题；访客填写邮箱和使用场景即可申请试用，后台记录申请并能导出名单。请安排官网文案与配图要求、试用申请的数据字段与接口、前端页面实现，以及上线前的交付验收。价格方案和品牌规范列为待确认，不要编造产品功能。',
      en: 'Build a website and trial sign-up for a newly launched AI note-taking app: the site has a home page, feature overview, pricing and FAQ; visitors request a trial by entering their email and use case, and the back end records requests and can export the list. Plan the website copy and image requirements, the trial request’s data fields and API, the frontend implementation, and a delivery review before launch. List the pricing plans and brand guidelines as to be confirmed, and do not invent product features.',
    },
    // The product-development template's shape: data and content both feed the pages under review.
    sketch: caseSketch([['data'], ['backend', 'materials'], ['frontend'], ['review']],
      [['0.0', '1.0'], ['1.0', '2.0'], ['1.1', '2.0'], ['2.0', '3.0']]),
  },
  {
    id: 'weekly-sales-report', category: 'data',
    title: { zh: '销售数据周报', en: 'Weekly sales report' },
    summary: { zh: '统一多个来源的口径，检查质量，输出给管理层的周报。', en: 'Align definitions across sources, check quality, and write a weekly report for management.' },
    prompt: {
      zh: '我们的销售数据分散在 CRM 导出表、线上商城订单和线下门店的 Excel 里，口径不统一。请搭建一套周报流程：先统一客户、订单、门店等实体和字段口径，制定质量检查规则；再按区域和品类汇总关键指标，说明明显波动的可能原因；最后输出一份给管理层的 Markdown 周报，并核对每个结论的数据来源。样本数据由我提供，缺失的口径列为待确认。',
      en: 'Our sales data is spread across CRM exports, online store orders and in-store Excel files, with inconsistent definitions. Build a weekly reporting workflow: first align the entities and field definitions for customers, orders and stores, and set data quality check rules; then summarize the key metrics by region and category and explain the likely causes of notable swings; finally write a Markdown weekly report for management and verify the data source behind every conclusion. I will provide the sample data; list any missing definitions as to be confirmed.',
    },
    sketch: caseSketch([['data'], ['general'], ['review']]),
  },
  {
    id: 'subscription-churn', category: 'data',
    title: { zh: '订阅用户流失分析', en: 'Subscription churn analysis' },
    summary: { zh: '确认流失口径，拆解流失特征，给出有依据的挽回建议。', en: 'Define churn, break down who churns, and recommend evidence-backed win-back actions.' },
    prompt: {
      zh: '分析一款订阅制 App 的用户流失：先确认流失的定义和可用的数据来源（注册、活跃、付费、客服记录），整理数据字典和数据质量问题；再按获客渠道、套餐和使用行为拆解流失用户的特征，列出有数据支持的原因假设；最后给出分优先级的挽回建议，以及还需要补充采集的数据。所有结论都要注明依据的数据范围。',
      en: 'Analyze user churn for a subscription app: first confirm the definition of churn and the available data sources (sign-ups, activity, payments, support records), and compile a data dictionary and the data quality issues; then break down churned users’ characteristics by acquisition channel, plan and usage behavior, and list data-backed hypotheses for the causes; finally give prioritized win-back recommendations and the additional data that still needs to be collected. Every conclusion must state the data scope it rests on.',
    },
    sketch: caseSketch([['data'], ['general', 'general'], ['review']]),
  },
  {
    id: 'launch-content-kit', category: 'content',
    title: { zh: '新品上市内容包', en: 'Product launch content kit' },
    summary: { zh: '提炼卖点和品牌语气，产出小红书、公众号和电商详情页内容。', en: 'Distill selling points and tone, then write Xiaohongshu, WeChat and product-page content.' },
    prompt: {
      zh: '为一款即将上市的便携咖啡机准备上市内容包，目标受众是城市通勤的上班族，渠道包括小红书图文、微信公众号长文和电商详情页。请先提炼产品卖点和品牌语气，再分别产出各渠道的文案和配图要求（尺寸、数量、画面描述），最后检查信息是否一致、是否符合渠道规格、有没有夸大宣传。产品参数请标为待确认，不要编造。',
      en: 'Prepare a launch content kit for an upcoming portable coffee maker aimed at urban commuters who work in offices, across Xiaohongshu image posts, a long-form WeChat Official Account article and an e-commerce product page. First distill the product’s selling points and brand tone, then write the copy and image requirements (sizes, quantities, scene descriptions) for each channel, and finally check that the information is consistent, fits each channel’s specifications and makes no exaggerated claims. Mark the product specifications as to be confirmed; do not invent them.',
    },
    sketch: caseSketch([['general'], ['materials', 'materials', 'materials'], ['review']]),
  },
  {
    id: 'monthly-content-calendar', category: 'content',
    title: { zh: '月度内容排期', en: 'Monthly content calendar' },
    summary: { zh: '拟定内容主题和发布日历，写出每周可直接发布的文案。', en: 'Set content themes and a publishing calendar, with ready-to-post copy for each week.' },
    prompt: {
      zh: '为一家本地烘焙品牌规划下个月的社交媒体内容：先根据品牌定位和目标受众拟定 3 个内容主题和发布日历（平台、日期、形式），再为每周挑选一篇写出可以直接发布的文案和配图说明，最后检查语气是否统一、是否符合各平台规范。门店活动和优惠信息列为待我确认。',
      en: 'Plan next month’s social media content for a local bakery brand: first draft 3 content themes and a publishing calendar (platform, date, format) based on the brand positioning and target audience, then pick one post per week and write ready-to-publish copy and image notes for it, and finally check that the tone is consistent and meets each platform’s guidelines. List store events and promotions as waiting for my confirmation.',
    },
    sketch: caseSketch([['general'], ['materials'], ['review']]),
  },
  {
    id: 'user-activation-journey', category: 'growth',
    title: { zh: '新用户激活旅程', en: 'New user activation journey' },
    summary: { zh: '定义激活口径，按角色设计邮件和站内提示的触达。', en: 'Define activation and design email and in-app prompts for each role.' },
    prompt: {
      zh: '为一款 B2B 协作软件设计新用户注册后 14 天的激活旅程：先定义“已激活”的行为口径和需要的数据埋点；再按用户角色分群，设计邮件和站内提示的触达节奏，写出每封邮件的主题和正文；最后说明如何评估效果，以及还需要确认哪些数据来源。不要预设具体的提升幅度。',
      en: 'Design a 14-day activation journey for new users after they sign up for a B2B collaboration tool: first define the behaviors that count as “activated” and the tracking events needed; then segment users by role, design the cadence of emails and in-app prompts, and write the subject line and body of every email; finally explain how to evaluate the results and which data sources still need to be confirmed. Do not assume a specific amount of improvement.',
    },
    sketch: caseSketch([['data'], ['general'], ['materials'], ['review']]),
  },
  {
    id: 'developer-meetup', category: 'growth',
    title: { zh: '开发者线下沙龙', en: 'Developer meetup' },
    summary: { zh: '议程与嘉宾邀请、报名页和海报、报名字段与当天执行清单。', en: 'Agenda and speaker invitations, sign-up page and poster, registration fields and a day-of checklist.' },
    prompt: {
      zh: '策划一场主题为“AI Agent 在企业中的落地实践”的开发者线下沙龙：安排议程和嘉宾邀请方案，写报名页文案和海报要求，设计报名信息的收集字段和筛选规则，整理活动当天的执行清单；最后整体检查一遍，列出风险和待确认事项（场地、预算、日期）。',
      en: 'Plan an in-person developer meetup on the theme “Putting AI Agents to work in the enterprise”: arrange the agenda and a speaker invitation plan, write the sign-up page copy and poster requirements, design the registration fields and screening rules, and put together a checklist for the day of the event; finally review everything and list the risks and open items to confirm (venue, budget, date).',
    },
    sketch: caseSketch([['general'], ['materials', 'data'], ['general'], ['review']]),
  },
  {
    id: 'competitor-research', category: 'research',
    title: { zh: '竞品调研报告', en: 'Competitor research report' },
    summary: { zh: '确定对比维度，逐款整理资料并注明来源，再做横向对比。', en: 'Set comparison dimensions, research each product with sources, then compare them side by side.' },
    prompt: {
      zh: '基于我提供的资料链接和文件，调研 5 款主流在线白板协作产品，输出一份竞品分析报告：先确定对比维度（目标用户、核心功能、协作方式、定价模式、集成生态），逐款整理资料并注明来源；再做横向对比和差异化机会分析；最后核对每条结论能否追溯到来源，无法确认的信息单独列出。',
      en: 'Using the links and files I provide, research 5 mainstream online whiteboard collaboration products and produce a competitive analysis report: first set the comparison dimensions (target users, core features, collaboration model, pricing model, integration ecosystem), and compile material on each product with its sources; then compare them side by side and analyze differentiation opportunities; finally check that every conclusion traces back to a source, and list anything that cannot be confirmed separately.',
    },
    sketch: caseSketch([['general'], ['data'], ['general'], ['review']]),
  },
  {
    id: 'policy-briefing', category: 'research',
    title: { zh: '行业政策解读', en: 'Regulatory policy briefing' },
    summary: { zh: '按主题梳理政策要点和生效时间，分析影响并注明出处。', en: 'Summarize policy points and effective dates by topic, analyze the impact and cite sources.' },
    prompt: {
      zh: '根据我提供的政策原文和官方解读，为跨境电商业务团队写一份监管政策解读报告：按主题（税务、数据合规、支付、物流）梳理政策要点和生效时间，分析对我们业务的可能影响，给出分阶段的应对建议。每条政策都要注明出处，时间或条款不确定的地方标注待核实，最后核对引用和结论是否一致。',
      en: 'Based on the policy texts and official interpretations I provide, write a regulatory policy briefing for our cross-border e-commerce team: organize the key policy points and effective dates by topic (tax, data compliance, payments, logistics), analyze the likely impact on our business, and give phased recommendations for responding. Cite the source of every policy, mark uncertain dates or clauses as to be verified, and finally check that the citations and conclusions agree.',
    },
    sketch: caseSketch([['general'], ['general', 'general'], ['general'], ['review']]),
  },
];
