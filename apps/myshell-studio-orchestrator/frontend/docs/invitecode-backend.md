Dreamy Bot 邀请机制 — API 接口文档

本次修改涵盖：1 个修改接口 (Init) + 2 个新增接口 (Earn / ApplyInviteCode) Base URL: /v1/telegram/miniapp/dreamy Auth: Telegram MiniApp WebAppData (JWT)


1. 【修改】Init — 小程序初始化

Path: POST /v1/telegram/miniapp/dreamy/init

Request

无请求参数（Auth header 自动识别用户）

Response — DreamyInitResponse

字段
	类型
	说明

user_info
	object
	用户基本信息

user_info.username
	string
	用户名

user_info.user_id
	string
	用户 ID

user_info.avatar_url
	string
	头像 URL

energy
	object
	电量信息

energy.balance
	int32
	当前电量余额

energy.free_generations_left
	int32
	剩余免费生成次数

energy.has_purchased
	bool
	是否曾购买过电量

energy_packs
	[]EnergyPack
	可购买电量包列表

energy_packs[].stars
	int32
	TG Stars 价格

energy_packs[].energy
	int32
	对应获得电量

floors
	[]Floor
	Explore 页推荐楼层

invite_info
	object
	新增— 邀请信息

invite_info.popup_invite_code
	bool
	是否弹出邀请码输入弹窗（true = 用户未绑定邀请码且无购买记录）

invite_info.applied_code
	string
	用户已绑定的邀请码（空字符串 = 未绑定）


invite_info 字段逻辑

场景
	popup_invite_code
	applied_code

新用户（无绑定、无购买）
	true
	""

已购买但未绑定邀请码
	false
	""

已绑定邀请码
	false
	"DRM-XXXXXX"



2. 【新增】Earn — 获取邀请/赚取页数据

Path: POST /v1/telegram/miniapp/dreamy/earn

Request

无请求参数（Auth header 自动识别用户）

Response — EarnResponse

字段
	类型
	说明

invite_code
	string
	用户的邀请码（DRM-XXXXXX 格式），首次调用时自动生成

invite_link
	string
	完整邀请链接，格式:https://t.me/DreamyAI_bot?start=invite_DRM-XXXXXX

friends_invited
	int32
	已邀请好友数量（已成功绑定此用户邀请码的人数）

energy_earned_from_invite
	int32
	通过邀请累计获得的电量（作为邀请人获得的奖励总和）


邀请码规则

* 格式：DRM-XXXXXX（6位，大写字母+数字，排除易混淆字符 0/O/I/L/1）
* 每用户每 channel 一个码，首次请求自动生成
* 生成后永久有效，不会变化


3. 【新增】ApplyInviteCode — 使用邀请码

Path: POST /v1/telegram/miniapp/dreamy/invite/apply

Request — ApplyInviteCodeRequest

字段
	类型
	必填
	说明

code
	string
	✅
	要使用的邀请码（如 "DRM-A3B4C5"）


Response — ApplyInviteCodeResponse

成功 (HTTP 200)

字段
	类型
	说明

success
	bool
	true

message
	string
	"Invite code applied successfully!"

energy_rewarded
	int32
	被邀请人获得的电量奖励（当前固定 15）


失败 (HTTP 400，Kratos Error)

字段
	类型
	说明

code
	int
	HTTP 状态码 400

reason
	string
	错误类型标识（见下表）

message
	string
	人类可读的错误描述


	类型
	说明

success
	bool
	false

message
	string
	错误原因（见下表）

energy_rewarded
	int32
	0


错误场景 (HTTP 400)

reason
	触发条件
	示例 message

ERROR_REASON_AFFILIATE_CODE_NOT_FOUND
	邀请码不存在或无效
	invite code not found: DRM-XXXXXX

ERROR_REASON_AFFILIATE_SELF_INVITE
	用户使用了自己的邀请码
	cannot use your own invite code

ERROR_REASON_AFFILIATE_ALREADY_APPLIED
	用户已绑定过邀请码（每人仅限一次）
	already applied an invite code

ERROR_REASON_AFFILIATE_INVITER_DAILY_LIMIT
	邀请人今日邀请奖励已达上限（6次/天，90 energy/天）
	inviter has reached daily invite limit (6/6)


reason
	触发条件
	示例 message

ERROR_REASON_AFFILIATE_CODE_NOT_FOUND
	邀请码不存在或无效
	invite code not found: DRM-XXXXXX

ERROR_REASON_AFFILIATE_SELF_INVITE
	用户使用了自己的邀请码
	cannot use your own invite code

ERROR_REASON_AFFILIATE_ALREADY_APPLIED
	用户已绑定过邀请码（每人仅限一次）
	already applied an invite code


错误消息
	触发条件

invite code not found: XXX
	邀请码不存在

cannot use your own invite code
	用户使用了自己的邀请码

already applied an invite code
	用户已绑定过邀请码（每人仅限一次）



数据库表（参考）

表名
	用途

affiliate_invite_codes
	存储邀请码（user_id + channel → code）

affiliate_referrals
	存储邀请关系（inviter ↔ invitee）

affiliate_reward_records
	存储奖励记录（邀请人/被邀请人电量奖励）



⚠️ TODO / 待完善

* 电量奖励分发: 当前 ApplyInviteCode 返回固定 15 电量，但实际电量写入尚未接入 userEnergyService，需后续 wire 接入
* 邀请链接格式: 当前用 start=（进 Bot 聊天），产品可能要改为 startapp=（直接打开 MiniApp）


📏 邀请限制规则

限制项
	值
	说明

被邀请人奖励
	15 energy/次
	每人终身仅可使用一次邀请码

邀请人奖励
	15 energy/次
	每次有人使用该用户邀请码时获得

邀请人每日上限
	6 次/天
	超过后被邀请人会收到 400 错误，邀请关系不会建立

邀请人每日最大 energy
	90 energy/天
	= 6 次 × 15 energy

日期重置
	UTC 00:00
	按 UTC 日期计算


按 UTC 日期计算
