# SuperClaw 遥测收集服务器（telemetry collection server）

运营自用的**独立**接收 + 查询 + 监控服务。装机端把脱敏诊断/审计数据上报到这里，
你在网页后台集中排查错误、优化数据。它**不属于** SuperClaw 产品的 CLI/Web/Desktop/API
表层，是单独部署的收集端。

> 设计依据：`docs/remote-telemetry-upload-architecture.md`。

## 一句话：本地↔生产无缝切换 = 改一个环境变量

| | 本地模拟 | 生产 |
|---|---|---|
| 服务器库 | `TELEMETRY_DATABASE_URL=sqlite:///./telemetry.db` | `...=postgresql://user:pass@db:5432/telemetry` |
| 装机端指向 | `SUPERCLAW_TELEMETRY_ENDPOINT=http://127.0.0.1:8900` | `...=https://你的域名` |

**同一份代码**，不改一行，只换环境变量。

## 本地起模拟服务器（零依赖，SQLite）

```bash
pip install -r apps/telemetry_server/requirements.txt   # 仅 fastapi/uvicorn/pydantic

TELEMETRY_DATABASE_URL=sqlite:///./telemetry.db \
uvicorn --factory apps.telemetry_server.main:create_app --port 8900
```

打开监控页面：<http://127.0.0.1:8900/>

## 让装机端上报到它（默认关闭，需显式开启）

```bash
export SUPERCLAW_TELEMETRY_ENDPOINT=http://127.0.0.1:8900
export SUPERCLAW_TELEMETRY_TOKEN=<与服务器 TELEMETRY_INGEST_TOKEN 相同>

superclaw telemetry status     # 看门控状态 / 为什么不上报
superclaw telemetry enable --agreement-version 2026-06-23   # 记录同意，打开
superclaw telemetry spool      # 立即上报一次
superclaw telemetry disable    # 关闭并清空待上传游标
```

后台定时上报：用 cron / launchd 周期跑 `superclaw telemetry spool`（尚未接入心跳
daemon，是有意的后续步骤）。例如 crontab 每 5 分钟：

```cron
*/5 * * * * SUPERCLAW_TELEMETRY_ENDPOINT=... SUPERCLAW_TELEMETRY_TOKEN=... superclaw telemetry spool
```

关键安全行为：
- **默认关闭**，没 enable / 没 endpoint / 设了 `SUPERCLAW_TELEMETRY_KILL=1` → 零出网。
- **绝不阻塞 run**：上报失败只是下次重试。
- **effectively-once**：确定性 `upload_id` + 游标，服务器去重，绝不重复入库。

## 生产部署（Docker，PostgreSQL）

```bash
cd apps/telemetry_server
cp .env.example .env      # 填 POSTGRES_PASSWORD、TELEMETRY_INGEST_TOKEN、TELEMETRY_QUERY_TOKEN（均必填）
docker compose up -d      # 起 postgres + 接收/查询/WebUI
```

- **两个 token 必须不同**：装机端只持有 `TELEMETRY_INGEST_TOKEN`（仅能上报）；运营查询/删除
  用 `TELEMETRY_QUERY_TOKEN`（在 WebUI 右上角填）。这样任何装机端都无法读取或删除全站数据。
- postgres **不对外暴露**，只有 app 容器能连；对外只开 app 的 8900 端口（前面再加 TLS 反代）。
- Tier C 过期清理：服务器内置后台周期线程（`TELEMETRY_RETENTION_INTERVAL_SECONDS`，默认每小时）。
- Tier C（原始载荷）入库即密文，服务器零知识；私钥绝不放这台机器。
- `TELEMETRY_TIER_C_RETENTION_DAYS`（默认 7）到期自动清 Tier C，A/B 不动。

## 接口一览

| 端点 | 用途 |
|---|---|
| `POST /v1/telemetry/ingest` | 装机端上报（Bearer 鉴权、幂等去重、拒未知字段） |
| `GET /v1/telemetry/health` | 健康探针 |
| `GET /v1/telemetry/keys` | Tier C 公钥分发（私钥永不在此；待接线） |
| `GET /api/stats` | 统计卡片数据 |
| `GET /api/query?tier=A&trace_id=&device_id=&limit=` | 按层/运行/设备查询（Tier C 只返回元数据） |
| `POST /api/retention` | 手动触发 Tier C 过期清理 |
| `GET /` | 监控 + 查询网页后台 |

## 测试

```bash
python -m pytest tests/test_telemetry_server.py tests/test_telemetry_upload.py tests/test_telemetry_e2e.py -q
```
