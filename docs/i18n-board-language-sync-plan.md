# 规划:嵌入式 Paperclip 看板的 en/zh 语言同步(轻量方案)

> 状态:**规划,未实现**。业主 2026-06-28 决策:**不采用**重的 `integration/i18n-into-server-coexist`
> 分支(含 803 行 `paperclipTextBridge.ts` + `paperclipLocale.ts`)。改用下面这套轻量同步:
> **super 自己的 Web/桌面端设置语言时,把语言同步给嵌入的 Paperclip 看板。只做 en + zh。**

## 背景事实(已本地核实,2026-06-28)

- **Paperclip 看板(`server/ui`)自带 40 种语言的完整翻译**(`server/ui/src/i18n/locales/*.json`,
  zh-CN 为地道中文),随 vendored Paperclip 一起进来,**不是垃圾,保留**。
- **但看板默认锁死英文**:`server/ui/src/i18n/index.ts` 初始化 `lng: "en"`(`DEFAULT_LOCALE="en"`);
  **无** `LanguageDetector`、**无**任何 UI 语言开关(全仓 `changeLanguage` 调用 = 0)。
  → 嵌入后默认全英文,40 语言数据"带着没接通"。
- **关键钩子**:`server/ui/src/i18n/index.ts` **导出了 `i18n` 实例**(`export { i18n }`)。
  → 嵌入方(`apps/web/src/CompanyBoard.tsx`)可 `import { i18n } from "@/i18n"` 直接驱动它,
  **无需改 vendored 板子源码**。
- **super(`apps/web`)目前没有中央 i18n 框架**,只有零散 en/zh:
  `OnboardingTour.tsx`(`TourLocale: 'zh'|'en'` + 中英文案)、`ErrorBoundary.tsx`
  (`navigator.language.startsWith('zh')` 判中文)。偏好存储用 `localStorage`(zoom、选中公司等)。
- **桌面端(Tauri)用的就是 `apps/web` 构建产物** → 一处实现,Web + 桌面同时生效。

## 设计(轻量、零改 vendored 源)

1. **super 侧建一个中央语言偏好** `superLang: 'en' | 'zh'`:
   - 默认值:`navigator.language` 以 `zh` 开头 → `'zh'`,否则 `'en'`(复用 ErrorBoundary 已有判定逻辑)。
   - 持久化:`localStorage`(如 key `superclaw.lang`),与现有 zoom/company 偏好同套路。
   - 暴露:一个小 hook/context(`useSuperLang()`)+ 设置处一个 en/zh 开关(挂在现有设置入口即可)。
2. **CompanyBoard 跟随**:`apps/web/src/CompanyBoard.tsx` 里
   `import { i18n } from "@/i18n"`,在**挂载时**和**偏好变化时**调用
   `i18n.changeLanguage(superLang === 'zh' ? 'zh-CN' : 'en')`。
   - 映射:super `'zh'` → 板子 `'zh-CN'`;`'en'` → `'en'`。
   - react-i18next 的 `useTranslation` 会订阅 `languageChanged` 自动重渲染,无需额外刷新。
   - 时序:在 board `<App/>` 首次渲染**之前**设好语言,避免英文闪一下(在 CompanyBoard 顶部同步设置)。
3. **只暴露 en + zh**:板子虽有 40 语言,本期只给这两个选项(其余数据保留备用)。

## 为什么够用 / 优势

- 板子翻译数据已完整,只差"调用 `changeLanguage`",所以**这是几十行的活,不是 803 行的桥**。
- **零改 vendored 板子源码**(从 apps/web 驱动导出的实例),不增加 re-vendor 合并摩擦。
- Web + 桌面一处生效。
- 取代并淘汰 `integration/i18n-into-server-coexist` 重分支(**不要合那条**)。

## 风险 / 已知边界

- **super 自身的外壳(apps/web 非看板部分)目前基本只有英文**(仅 OnboardingTour/ErrorBoundary 有零散中文)。
  本方案**只同步看板**;super 外壳的完整 i18n 是另一件更大的事,不在本期。
- 若将来要 super 外壳也完整多语言 → 需引入中央 i18n(更大工程),届时本方案的"语言偏好源"可直接复用。
- 切换语言后,板子内**已 portal 到 body 的浮层**(dialog/popover 等)也会跟随重渲染(同一 i18n 实例),
  无需特殊处理;但若发现个别静态字符串未走 i18n(硬编码),按需补。

## 落地清单(将来实现时)

- [ ] `apps/web` 加 `useSuperLang()`(localStorage + navigator.language 默认)。
- [ ] 设置入口加 en/zh 开关。
- [ ] `CompanyBoard.tsx` import 板子 `i18n` 实例,挂载/变更时 `changeLanguage`(en↔zh-CN)。
- [ ] 验证:切换后看板 UI 实时变中文/英文;首屏无语言闪烁;桌面端同样生效。
- [ ] 文档:在 README/设置说明里写明"语言开关同时作用于聊天壳 + 嵌入看板(en/zh)"。
