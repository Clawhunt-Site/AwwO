# AwwO 图像与视频节点（RunningHub）

状态：实现与本地验收完成（2026-10-03），尚未部署，尚未用真实密钥调用过 RunningHub。代码推送、生产密钥配置与服务部署分别授权、分别验收，不能由本文件推定。

画布里的图像节点和视频节点由 RunningHub 的标准模型 API（Standard Model API）执行：节点照常对话、排队、计入并发与取消，但不经过任何模型 worker——API 把提示词和节点参数提交给 RunningHub 一次，记录任务号，轮询到结束，再把结果文件下载到服务器磁盘并记为产物。运行的输出是一条指向这些产物的小记录，画布在对话里直接显示图片或视频。

## 用户看到什么

- 节点配置里的「Agent 类型」多了 **图像 Agent** 和 **视频 Agent**（只在 SaaS 且服务端开放了媒体生成时可选）。右键「添加节点」菜单也会出现「图像生成」「视频生成」。
- 选中后，执行框架、人设、团队、任务要求都不再显示，换成 **模型** 下拉（按厂商分组）和该模型的参数：画面比例、分辨率、时长、生成音频、反向提示词等。每个参数的选项、范围和默认值都来自服务端目录；没改动的参数显示为「默认」，不写进节点，服务端运行时套用模型默认值。
- 在节点对话里写描述并发送即生成一次。生成中显示 RunningHub 自己报告的状态（排队等待生成… / 正在生成… / 正在保存结果…），不编造百分比；完成后对话里显示图片（可点开原图）或可播放、可拖动进度的视频，并提供下载。
- 切换模型会清空参数（参数属于某个模型）；更换模型或类型后需要重新保存（初始化）节点，否则运行会被拒绝并提示重新初始化——生成要花钱，绝不会悄悄用旧模型代跑。

## 目录

目录是 `backend/internal/app/media_models.json`，嵌入 API 二进制，启动时严格解析（未知字段、重复 id/endpoint、保留参数名、默认值不在选项内等都会让进程拒绝启动）。当前 18 个模型，全部是「纯文本生成」（需要上传参考图的图生图/图生视频要等上传流程，暂不收录）：

| 类型 | 模型 |
| --- | --- |
| 图像 | Seedream 5.0 Pro、Nano Banana Pro、Nano Banana 2、GPT Image 2、Qwen-Image 3.0 Pro、Midjourney V7、Grok Imagine、Wan 2.7 Pro、即梦 4.6 |
| 视频 | Kling 3.0 Pro、Seedance 2.0、Veo 3.1 Fast、Sora 2、海螺 2.3 Pro、Vidu Q3 Pro、Wan 2.7、Grok Imagine Video、PixVerse V6 |

每个模型的参数取自其 OpenAPI 请求定义（`.local/research` 下的生成脚本，提示词示例和 URL 不复制）。`verified` 字段记录用本部署的密钥真实调用成功的日期，目前全部为空。`GET /api/v1/tenants/{tenantId}/media` 返回已配置状态、本工作区可用的模型（受工作区模型白名单约束）和每日上限，不暴露密钥或接口地址。

## 配置（只在 API 上）

| 变量 | 说明 |
| --- | --- |
| `AWWO_RUNNINGHUB_API_KEY` | **企业共享（Enterprise-Shared）** API Key。标准模型 API 不接受个人 Key（错误码 1014）。与 `AWWO_MEDIA_DIR` 必须同时设置或同时不设；都不设时功能关闭，一切照旧。 |
| `AWWO_MEDIA_DIR` | 生成文件的保存目录，绝对路径；容器内须可写（见下方部署）。 |
| `AWWO_RUNNINGHUB_BASE_URL` | 只能是 `https://www.runninghub.ai`（默认）或 `https://www.runninghub.cn`；开发环境可指向 `http://127.0.0.1:端口` 的假服务。密钥只发往这个地址。 |
| `AWWO_MEDIA_TIMEOUT` | 单次生成的总时限，默认 `20m`（1m–2h）。 |
| `AWWO_MEDIA_POLL_INTERVAL` | 轮询间隔，默认 `5s`。 |
| `AWWO_MEDIA_RUNS_PER_DAY` | 每个工作区每天（UTC）可受理的生成次数，默认 30；按已受理的生成计数，失败的也算（它们可能已经计费）。 |
| `AWWO_MEDIA_TOTAL_RUNS_PER_DAY` | 全部署（所有工作区合计）每天（UTC）可受理的生成次数，默认 500，作为运营方支出的兜底；超过返回 429 `media_capacity_exceeded`。 |
| `AWWO_MEDIA_MAX_FILE_MB` | 单个结果文件上限，默认 300（1–2047）。 |
| `AWWO_MEDIA_MIN_FREE_MB` | 媒体所在文件系统至少保留的空闲空间，默认 2048；低于它时拒绝受理新生成（503 `media_storage_full`），也不再写入结果。 |
| `AWWO_MEDIA_UNRESTRICTED_WORKSPACES` | 默认 `false`：没有模型白名单的工作区不能使用媒体模型。设为 `true` 才向这类工作区开放全部媒体模型。 |
| `AWWO_MEDIA_RESULT_HOSTS` | 结果文件允许的下载地址：以 `.` 开头表示该域名的子域名，否则为精确主机名。默认 `.runninghub.ai,.runninghub.cn,rh-images-1252422369.cos.ap-beijing.myqcloud.com`（RunningHub 文档中的结果存储桶），不再放行整个 `.myqcloud.com`。真实调用若出现其他结果主机，确认归属后再加入。 |
| `AWWO_MEDIA_DEV_PROXY` | 仅开发环境：显式的本地代理 `http://127.0.0.1:端口`（例如 Clash）。下载只额外允许拨这一个回环地址；不读取任何代理环境变量。 |

**计费与授权**：生成用的是运营方的 Key。媒体模型只在明确授权时可用——工作区的模型白名单（`tenants.allowed_models`）列出该 `rh.*` id，或运营方用 `AWWO_MEDIA_UNRESTRICTED_WORKSPACES=true` 向无白名单的工作区开放。生产新工作区默认只有 `qwen3.8-27b-p6`，需要的 `rh.*` id 要加入白名单，或通过 `AWWO_NEW_WORKSPACE_ALLOWED_MODELS` 给新工作区默认开放。每次受理同时写入只关联工作区的 `media_generations` 账本：删除画布（会级联删除运行）不会让每日上限复位；生成也计入工作区自己的每日运行额度（`max_runs_per_day`）。账号可创建的工作区数量由 `AWWO_MAX_OWNED_WORKSPACES` 限制：设置 `AWWO_MEDIA_UNRESTRICTED_WORKSPACES=true`，或在 `AWWO_NEW_WORKSPACE_ALLOWED_MODELS` 中列出 `rh.*` 模型时，必须同时设置它，否则 API 拒绝启动（否则每新建一个工作区就多一份每日额度）。两个计数都在拿到锁之后读取时间，午夜不会多放行。上限按次数计，不区分 1k 图片与 4k 视频的成本（按模型加权是后续改进）。

## 执行与恢复

- 一次受理 = 一次提交。提交请求无论是否到达 RunningHub 都不重试，避免重复计费；也不会因为取消或关机被中途放弃——提交一旦发出就可能计费，API 会等到回答（客户端超时 30 秒）并记下任务号。`deploy/saas/compose.yml` 因此给 API 设置了 45 秒的 `stop_grace_period`。
- 任务号写入 `runs.media_task`。API 正常关闭或丢失数据库租约时，已记录任务号的媒体运行保持 `running`；下次启动不把它们标记为中断，而是在剩余时限内继续轮询并保存结果，不会重新提交。没记录任务号的照常标记中断；重启时已超时的标记为 `media_timeout`。
- 用户取消只停止 AwwO 这边的等待：RunningHub 没有文档化的取消接口，已提交的任务可能仍会完成并计费。
- 轮询中的瞬时错误（限流、5xx、网络）连续超过 12 次才判失败；RunningHub 以错误码回答「仍在排队/运行」（804/813）不算失败。回答里的任务号与所查任务不一致时直接失败（所有工作区共用一个 RunningHub 账号，绝不把别的任务的结果存进这次运行）；包装的 `{code,msg,data}` 只解开一层。
- RunningHub 的错误信息可能回显提示词或账号信息，从不保存或显示，只映射成固定的错误码：`media_provider_unauthorized`、`media_provider_balance`、`media_provider_busy`、`media_content_rejected`、`media_params_invalid`、`media_timeout`、`media_task_missing`、`media_failed`、`media_no_output`、`media_result_invalid`、`media_result_refused`、`media_result_unavailable`、`media_result_too_large`、`media_storage_failed`。
- 画布整体运行（graph run）不执行媒体节点，返回 `media_graph_unsupported`；媒体节点单独运行。媒体节点不接受知识上下文（`media_knowledge_unsupported`）。

## 存储与安全

- 结果下载走单独的 HTTP 客户端：只接受 https、允许的域名后缀、443 端口、无用户信息；连接时在**实际拨号的地址**上拒绝回环、私网、链路本地、CGNAT、文档网段等非公网地址（DNS 重绑定无法绕过）；重定向同样检查，最多 3 次；超过大小上限立即中止。生产环境不读取代理变量。
- 文件先写入 `AWWO_MEDIA_DIR/.tmp`，按内容嗅探格式（PNG/JPEG/WebP/GIF/MP4/MOV/WebM 闭集，SVG/HTML 一律拒绝），类型必须与节点一致（图像节点收到视频也拒绝），再以 `<租户>/<运行>/<sha256>.<扩展名>` 落盘（0640），产物行只存相对路径和嗅探出的类型。
- `GET /api/v1/tenants/{tenantId}/artifacts/{id}/media` 以嗅探出的类型内联返回（支持 Range 拖动进度），带 `Content-Security-Policy: default-src 'none'; sandbox`、`X-Content-Type-Options: nosniff` 与同源 CORP；只返回服务端自己保存的文件，路径逐段校验，跨租户 404。普通下载路由同样能下载磁盘文件（作为附件）。
- 产物随画布/工作区级联删除；每小时清理一次没有任何产物引用、且已存在超过 1 小时的文件，以及 6 小时以上的残留临时下载；仍在排队或运行的运行目录不清理。被删画布的文件最多约 2 小时后才从磁盘删除，且可能仍留在卷备份中。同一个媒体目录只能由一个部署（一个数据库）使用，否则彼此会把对方的文件当作无引用清掉。
- 只有图像/视频节点的输出会按媒体记录渲染；文本节点即使输出同样形状的 JSON，也只显示为文本，不能把工作区里别的图片冒充成自己的结果。
- 磁盘：建议把 `AWWO_MEDIA_DIR` 放在与 PostgreSQL 不同的文件系统上。空闲空间下限在受理时检查，并为每个进行中的下载预留单文件上限的空间，并发下载不会一起越过下限；但目前没有按工作区的字节配额，一个工作区仍可能把媒体空间用到下限，使所有工作区暂停新生成（后续改进）。
- 携带 Key 的 API 客户端同样不读取代理环境变量，只在开发环境使用 `AWWO_MEDIA_DEV_PROXY`（本机假服务不经代理）。
- 取消或关机发生在提交之前时不会提交；提交之后记录任务号时要求运行仍在进行，避免把任务挂到已被另一个实例结算的运行上。

## 部署清单

1. 准备企业共享 Key，并确认余额与可用模型。**先用一个便宜的图像模型做一次真实调用**，确认结果文件的下载主机在 `AWWO_MEDIA_RESULT_HOSTS` 之内（默认只放行文档中出现的存储桶；若真实结果来自其他主机，每次生成都会计费后被拒绝下载），再把成功日期写进目录的 `verified`。
2. API 容器是只读文件系统：`deploy/saas/compose.yml` 为 API 挂载了命名卷 `media-data` 到 `/var/lib/awwo/media`（镜像里该目录属主为 65532）。只在设置了 `AWWO_RUNNINGHUB_API_KEY` 时才把 `AWWO_MEDIA_DIR` 设为该路径。其他部署方式需自行设置 `AWWO_MEDIA_DIR` 为持久、可写的绝对路径（Key 与目录缺一不可，否则 API 拒绝启动），并纳入备份。
3. 设置 `AWWO_RUNNINGHUB_API_KEY`（不要写进仓库或聊天），按需调整每日上限与时限；`AWWO_MEDIA_TIMEOUT` 不受 nginx 的 `proxy_read_timeout` 约束（生成在后台进行，前端通过事件流跟进）。
4. 为需要的工作区开放 `rh.*` 模型（或明确设置 `AWWO_MEDIA_UNRESTRICTED_WORKSPACES=true`），并设置 `AWWO_MAX_OWNED_WORKSPACES`。
5. 部署后在线核对：`/media` 目录返回 `configured: true`；在测试工作区生成一张图片，确认对话内显示、Range 请求返回 206、下载正常；重启 API 一次确认进行中的生成被恢复而非重复提交。

## 测试

- Go：`media_test.go`（目录解析与参数闭集、RunningHub 响应与错误码、结果地址与非公网拒绝、配置校验、格式嗅探、客户端调用与下载上限）；`media_runs_test.go`（PostgreSQL 集成：生成→保存→内联/Range/下载/跨租户、准入拒绝、各类失败的固定错误码、取消后停止轮询、重启恢复不重复提交、清理只删未引用的旧文件）。
- Web：`apps/web/tests/canvas-media-nodes.test.tsx`（目录解析、参数校验与默认值不落盘、视频节点文档与端口、切换类型、配置面板、结果渲染、生成状态映射）。
