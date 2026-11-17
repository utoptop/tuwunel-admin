# 管理 API 操作目录

基于官方 Tuwunel 管理路由，查询和写入都通过已登录管理员的服务端会话代理。空白字段代表无默认正文。参数详情以官方文档和上游源码为准。

| 分组 | 操作 | 方法 | 路径 | 说明 |
| --- | --- | --- | --- | --- |
| 用户 | 用户列表 | GET | `/_synapse/admin/v2/users` |  |
| 用户 | 用户列表（v3） | GET | `/_synapse/admin/v3/users` |  |
| 用户 | 用户详情 | GET | `/_synapse/admin/v2/users/{user_id}` |  |
| 用户 | 创建 / 修改用户 | PUT | `/_synapse/admin/v2/users/{user_id}` | 不支持的 user_type、external_ids、approved 字段会被上游忽略。 |
| 用户 | 停用 / 擦除用户 | POST | `/_synapse/admin/v1/deactivate/{user_id}` | erase=true 会标记擦除并清理资料；不是物理删除 Matrix ID，也不会撤回远端副本。 |
| 用户 | 重置密码 | POST | `/_synapse/admin/v1/reset_password/{user_id}` | MAS 模式不提供此端点。 |
| 用户 | 查询管理员权限 | GET | `/_synapse/admin/v1/users/{user_id}/admin` | MAS 模式不提供此端点。修改权限请使用创建 / 修改用户。 |
| 用户 | 已加入房间 | GET | `/_synapse/admin/v1/users/{user_id}/joined_rooms` |  |
| 用户 | 房间成员关系 | GET | `/_synapse/admin/v1/users/{user_id}/memberships` |  |
| 用户 | 推送配置 | GET | `/_synapse/admin/v1/users/{user_id}/pushers` |  |
| 用户 | 账户数据 | GET | `/_synapse/admin/v1/users/{user_id}/accountdata` |  |
| 用户 | 登录连接信息 | GET | `/_synapse/admin/v1/whois/{user_id}` |  |
| 用户 | 暂停 / 恢复用户 | PUT | `/_synapse/admin/v1/suspend/{user_id}` |  |
| 用户 | 生成用户访问令牌 | POST | `/_synapse/admin/v1/users/{user_id}/login` | 敏感操作：返回可代用户操作的令牌。MAS 模式不可用。请勿分享结果。 |
| 用户 | 批量撤回用户事件 | POST | `/_synapse/admin/v1/user/{user_id}/redact` | 异步任务；rooms 为空会撤回用户在所有已加入或被封禁房间中的事件，请谨慎指定范围。 |
| 用户 | 撤回任务状态 | GET | `/_synapse/admin/v1/user/redact_status/{redact_id}` |  |
| 用户 | 允许替换交叉签名密钥 | POST | `/_synapse/admin/v1/users/{user_id}/_allow_cross_signing_replacement_without_uia` | 临时放开交互认证限制，请确认用户身份。 |
| 用户 | 通过邮箱查询用户 | GET | `/_synapse/admin/v1/threepid/{medium}/users/{address}` |  |
| 用户 | 用户名可用性 | GET | `/_synapse/admin/v1/username_available` |  |
| 用户 | 获取共享密钥注册 nonce | GET | `/_synapse/admin/v1/register` | 注册表单使用管理员创建用户，无需共享密钥。此端点供已有 HMAC 注册流程使用。MAS 模式不可用。 |
| 用户 | 共享密钥 HMAC 注册 | POST | `/_synapse/admin/v1/register` | 需要在外部安全计算 HMAC；不要将 registration_shared_secret 填入系统。MAS 模式不可用。 |
| 设备 | 用户设备 | GET | `/_synapse/admin/v2/users/{user_id}/devices` |  |
| 设备 | 创建设备 | POST | `/_synapse/admin/v2/users/{user_id}/devices` |  |
| 设备 | 设备详情 | GET | `/_synapse/admin/v2/users/{user_id}/devices/{device_id}` |  |
| 设备 | 重命名设备 | PUT | `/_synapse/admin/v2/users/{user_id}/devices/{device_id}` |  |
| 设备 | 删除设备 | DELETE | `/_synapse/admin/v2/users/{user_id}/devices/{device_id}` |  |
| 设备 | 批量删除设备 | POST | `/_synapse/admin/v2/users/{user_id}/delete_devices` |  |
| 注册令牌 | 注册令牌列表 | GET | `/_synapse/admin/v1/registration_tokens` |  |
| 注册令牌 | 创建注册令牌 | POST | `/_synapse/admin/v1/registration_tokens/new` |  |
| 注册令牌 | 注册令牌详情 | GET | `/_synapse/admin/v1/registration_tokens/{token}` |  |
| 注册令牌 | 修改注册令牌 | PUT | `/_synapse/admin/v1/registration_tokens/{token}` |  |
| 注册令牌 | 删除注册令牌 | DELETE | `/_synapse/admin/v1/registration_tokens/{token}` |  |
| 房间 | 房间列表 | GET | `/_synapse/admin/v1/rooms` |  |
| 房间 | 房间详情 | GET | `/_synapse/admin/v1/rooms/{room_id}` |  |
| 房间 | 删除房间（同步） | DELETE | `/_synapse/admin/v1/rooms/{room_id}` | 移出本地成员并清理本地存储，不会删除其他服务器的副本。 |
| 房间 | 房间成员 | GET | `/_synapse/admin/v1/rooms/{room_id}/members` |  |
| 房间 | 房间状态 | GET | `/_synapse/admin/v1/rooms/{room_id}/state` |  |
| 房间 | 房间事件 | GET | `/_synapse/admin/v1/rooms/{room_id}/messages` | 端到端加密事件仅返回密文，本系统不能解密。 |
| 房间 | 事件上下文 | GET | `/_synapse/admin/v1/rooms/{room_id}/context/{event_id}` |  |
| 房间 | 按时间定位事件 | GET | `/_synapse/admin/v1/rooms/{room_id}/timestamp_to_event` |  |
| 房间 | 空间层级 | GET | `/_synapse/admin/v1/rooms/{room_id}/hierarchy` | 仅本地已知房间。 |
| 房间 | 封禁状态 | GET | `/_synapse/admin/v1/rooms/{room_id}/block` |  |
| 房间 | 设置房间封禁 | PUT | `/_synapse/admin/v1/rooms/{room_id}/block` |  |
| 房间 | 设置房间管理员 | POST | `/_synapse/admin/v1/rooms/{room_id}/make_room_admin` |  |
| 房间 | 房间前向极值 | GET | `/_synapse/admin/v1/rooms/{room_id}/forward_extremities` |  |
| 房间 | 清理前向极值 | DELETE | `/_synapse/admin/v1/rooms/{room_id}/forward_extremities` |  |
| 房间 | 删除房间（异步） | DELETE | `/_synapse/admin/v2/rooms/{room_id}` |  |
| 房间 | 删除任务状态 | GET | `/_synapse/admin/v2/rooms/delete_status/{delete_id}` |  |
| 房间 | 房间删除任务 | GET | `/_synapse/admin/v2/rooms/{room_id}/delete_status` |  |
| 房间 | 将用户加入房间 | POST | `/_synapse/admin/v1/join/{room_id_or_alias}` |  |
| 房间 | 清理房间历史 | POST | `/_synapse/admin/v1/purge_history/{room_id}` |  |
| 房间 | 历史清理状态 | GET | `/_synapse/admin/v1/purge_history_status/{purge_id}` |  |
| 媒体 | 媒体元数据 | GET | `/_synapse/admin/v1/media/{server_name}/{media_id}` |  |
| 媒体 | 删除单个本地媒体 | DELETE | `/_synapse/admin/v1/media/{server_name}/{media_id}` |  |
| 媒体 | 按时间与大小删除媒体 | POST | `/_synapse/admin/v1/media/delete` | 时间按文件修改时间计算。默认保留头像。此 API 没有 dry-run；调用会立即删除。 |
| 媒体 | 清理远程媒体缓存 | POST | `/_synapse/admin/v1/purge_media_cache` | 按文件修改时间，非最后访问时间。删除后可能从远程重新下载。 |
| 媒体 | 用户媒体列表 | GET | `/_synapse/admin/v1/users/{user_id}/media` |  |
| 媒体 | 删除一页用户媒体 | DELETE | `/_synapse/admin/v1/users/{user_id}/media` | 每次仅删除一页。继续删除应保持 from=0，因为剩余数据会重新排序。 |
| 媒体 | 房间引用媒体 | GET | `/_synapse/admin/v1/room/{room_id}/media` | 只包含未加密事件中的媒体引用。 |
| 媒体 | 用户媒体统计 | GET | `/_synapse/admin/v1/statistics/users/media` |  |
| 联邦 | 联邦目标 | GET | `/_synapse/admin/v1/federation/destinations` |  |
| 联邦 | 联邦目标详情 | GET | `/_synapse/admin/v1/federation/destinations/{destination}` |  |
| 联邦 | 共享房间 | GET | `/_synapse/admin/v1/federation/destinations/{destination}/rooms` |  |
| 联邦 | 重试联邦连接 | POST | `/_synapse/admin/v1/federation/destinations/{destination}/reset_connection` |  |
| 服务器 | 服务器版本 | GET | `/_synapse/admin/v1/server_version` |  |
| 服务器 | 发送服务器通知 | POST | `/_synapse/admin/v1/send_server_notice` |  |
| 服务器 | 发送幂等服务器通知 | PUT | `/_synapse/admin/v1/send_server_notice/{txn_id}` |  |
| 服务器 | 后台任务 | GET | `/_synapse/admin/v1/scheduled_tasks` |  |
| 服务器 | 获取原始事件 | GET | `/_synapse/admin/v1/fetch_event/{event_id}` |  |
| 用户 | 原生账号锁定状态 | GET | `/_matrix/client/v1/admin/lock/{user_id}` |  |
| 用户 | 原生锁定 / 解锁账号 | PUT | `/_matrix/client/v1/admin/lock/{user_id}` |  |
| 用户 | 原生账号暂停状态 | GET | `/_matrix/client/v1/admin/suspend/{user_id}` |  |
| 用户 | 原生暂停 / 恢复账号 | PUT | `/_matrix/client/v1/admin/suspend/{user_id}` |  |

共享密钥注册操作接受已计算的 HMAC，不接收或持久化 registration_shared_secret。日常创建用户使用管理员 PUT users API。

## 1.4 管理台扩展接口

这些是面板自身的认证接口，使用服务器端会话 Cookie；POST 同时要求 Origin 与 X-CSRF-Token。它们组合上游已有 API，不假设 Tuwunel 有原生监测 API。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/rooms` | `{from, search}`，每批 20 个房间，补充头像并保留 `next_batch`、`total_rooms`；详情失败时保留房间 ID |
| GET | `/api/media/jobs` | 当前 homeserver 的媒体任务与逐人进度 |
| POST | `/api/media/jobs` | `{users:["@alice:example.com"], confirmation:"删除 1 位用户的全部媒体"}`，去重后 1–1000 位本地用户 |
| POST | `/api/media/jobs/cancel` | `{id}`，停止后续处理；已经在途的上游请求可能完成 |
| GET | `/api/observability` | 当前 homeserver 的只读采集快照、采集时间与过期状态；未配置返回 `available:false` |

媒体任务每次从 `from=0&limit=100` 删除，持续到读取剩余数量为零，文件总量不设 100 个上限；最多并行 3 位用户。当前服务器只允许一个批量媒体或桥接清理任务运行。失败保留已删除计数，重试只处理仍存在的文件；退出/权限失效或服务重启会中断任务，重启不自动恢复不可逆操作。任务完成、部分失败、取消与中断均有不同状态。

采集器格式与 Docker 部署参见 [服务器监测](observability.md)。注册 IP 来自可信成功注册日志，而非 whois；读取配置再次使用字段白名单过滤，不向浏览器返回秘密配置。
