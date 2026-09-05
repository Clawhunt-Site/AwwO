# API 迁移：fantasia → dreamy

路由前缀从 `/v1/telegram/miniapp/fantasia/*` 迁移到 `/v1/telegram/miniapp/dreamy/*`，鉴权方式不变（`x-telegram-init-data` header）。

---

## 当前代码使用的接口 → 新接口映射

### 1. Init（初始化 + 能量 + 分类）

| 当前 | 新接口 |
|------|--------|
| `POST /fantasia/init` | `POST /dreamy/init` |

**响应变化**：新增 `floors[]` 字段（分类列表），其余不变。

```
// 当前响应
{ userInfo, energy: { balance, freeGenerationsLeft, hasPurchased }, energyPacks[] }

// 新响应（新增 floors）
{ userInfo, energy, energyPacks[], floors[{ title, floorUrl }] }
```

**前端改动**：
- `src/services/api.ts` — `fetchInit()` 端点改 URL，`InitResponse` 类型新增 `floors` 字段
- `src/contexts/EnergyContext.tsx` — 在 init 时缓存 floors 列表，供 Explore 页使用
- `src/types/index.ts` — `InitResponse` 新增 `floors?: { title: string; floorUrl: string }[]`

### 2. Explore（首页内容）

| 当前 | 新接口 |
|------|--------|
| `POST /fantasia/characters/list` | `POST /dreamy/explore` |

**完全不同的接口**。当前 `fetchCharacters()` 返回 `Character[]`，新接口返回 `floors[]` + `images[]` 结构。

```
// 新请求
{ floor_url?: string, page?: number, page_size?: number, bot_name?: string }

// 新响应
{
  floors: [{ title, floorUrl, images: [{ imageUrl, gotoLink, title, templateUrl }] }],
  total?, page?, pageSize?, hasMore?
}
```

**前端改动**：
- `src/services/api.ts` — 新增 `fetchExplore(floorUrl?, page?, pageSize?)` 替代 `fetchCharacters()`
- `src/pages/Characters.tsx` — 改用 `fetchExplore()`，按 `floorUrl` 筛选分类；卡片数据从 `Character` 改为 explore 的 `images[]` 结构
- `src/types/index.ts` — 新增 `ExploreResponse`、`Floor`、`FloorImage` 类型

### 3. Footer（底部导航）

| 当前 | 新接口 |
|------|--------|
| 无（前端硬编码 5 个分类） | `POST /dreamy/footer` |

```
// 响应
{ footers: [{ title, imageUrl, gotoLink }] }
```

**前端改动**：
- 当前底部 tab bar 是硬编码的 5 个分类 + 本地图标。可改为从 `footer` 接口或 `init.floors` 动态获取
- 但如果分类固定不变，保持硬编码也可以，仅用 `floorUrl` 来请求 explore

### 4. Bot 详情 / 落地页

| 当前 | 新接口 |
|------|--------|
| 无专用接口（直接跳 Upload 页） | `POST /dreamy/get-by-slug` |

```
// 请求
{ slug_id: string }

// 响应
{ info: { activeId, botName, botId, template, slugId, ... }, recommend[], prev, after }
```

**前端改动**：
- `src/services/api.ts` — 新增 `fetchBotDetail(slugId)`
- 落地页需要用这个接口获取 bot 详情，再传 `botId` 给 generate 接口

### 5. Generate（发起生图）

| 当前 | 新接口 |
|------|--------|
| `POST /shellchannel/telegram/miniapp/generate` | `POST /dreamy/generate` |

```
// 新请求（字段变化）
{ bot_id, input_img[], article_id?, shell_json?, button_id? }

// 新响应
{ outputJobId, leftTry, totalTimes, currentTimes, queuePosition }
```

**前端改动**：
- `src/services/api.ts` — `generateByMiniApp()` 改 URL + 请求参数（`app_id` / `slug_id` → `bot_id`）
- 需要先从 `get-by-slug` 拿到 `botId`，再传给 generate

### 6. Generate Result（轮询生图结果）

| 当前 | 新接口 |
|------|--------|
| 无（当前用其他轮询方式） | `POST /dreamy/generate/result` |

```
// 请求
{ output_job_id: string }

// 响应
{ tasks: [{ status, result, slugId, jobId, queuePosition, ... }] }
```

**前端改动**：
- `src/services/api.ts` — 新增 `fetchGenerateResult(outputJobId)`
- Upload 页的轮询逻辑改用此接口

### 7. Task 系列

| 当前 | 新接口 |
|------|--------|
| 无 | `POST /dreamy/task/running` |
| 无 | `POST /dreamy/task/detail` |
| 无 | `POST /dreamy/task/retry` |
| 无 | `POST /dreamy/task/delete` |
| 无 | `POST /dreamy/task/cancel` |
| 无 | `POST /dreamy/task/like` |

全部是新增接口，当前前端没有对应功能。

### 8. Library（我的作品）

| 当前 | 新接口 |
|------|--------|
| `POST /fantasia/library/list` | `POST /dreamy/library/list` |
| `POST /fantasia/library/feedback` | `POST /dreamy/library/feedback` |
| `POST /fantasia/library/delete` | `POST /dreamy/library/delete` |

**响应结构不变**，仅改 URL 前缀。

**前端改动**：
- `src/services/api.ts` — `fetchLibrary()`、`libraryFeedback()`、`libraryDelete()` 改 URL

### 9. Energy History（电量明细）

| 当前 | 新接口 |
|------|--------|
| `POST /fantasia/energy/history` | `POST /dreamy/energy/history` |

**完全一样**，仅改 URL 前缀。

### 10. 购买能量（TG Stars）

| 当前 | 新接口 |
|------|--------|
| `POST /tg2app/fantasia/miniapp/create_invoice` | ⚠️ **未实现** |

Dreamy 的 Stars 支付流程后端还没加，需要等后端实现。

---

## 不需要改动的部分

| 模块 | 说明 |
|------|------|
| `EnergyContext` | 逻辑不变，只是底层 `fetchInit()` URL 变了 |
| `NavigationBar` / `Sidebar` | 纯 UI，不涉及 API |
| `Settings.tsx` (Profile) | 只用了 `EnergyContext` + `fetchEnergyHistory()`，改 URL 即可 |
| `EnergyHistory.tsx` | 只用了 `fetchEnergyHistory()`，改 URL 即可 |

---

## 改动优先级

1. **P0 — URL 前缀替换**（简单 find & replace）：init, library/list, library/feedback, library/delete, energy/history
2. **P1 — Explore 接口重构**：`fetchCharacters()` → `fetchExplore()`，卡片数据结构变化
3. **P1 — Generate 接口重构**：请求参数变化，新增 `get-by-slug` + `generate/result` 轮询
4. **P2 — Task 系列**：全新功能，Library 页可接入 task/running 显示进行中任务
5. **P3 — Stars 支付**：等后端实现
