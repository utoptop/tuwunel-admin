# Tuwunel Admin

中文 Tuwunel / Matrix 管理中心。**Rust + Tokio + Axum 后端，React / TypeScript 前端**。生产镜像不再需要 Node.js，所有运行设置通过 `config.toml` 管理，不读取 `.env`。

当前版本 **1.1.0**；双架构镜像 `utoptop/tuwunel-admin:1.1`，同时更新原约定的 `:1.0` 标签。支持 `linux/amd64` / `linux/arm64`。MIT License。

## 本次改进

- 后端迁移到 Rust，异步 HTTP、连接池复用、限量读取上游响应；磁盘持久化放入阻塞任务池，避免阻塞异步工作线程。
- TOML 配置文件管理监听地址、公开 URL、Cookie、Matrix 地址规则、数据目录、会话和清理计划参数。未知配置字段或无效配置会阻止启动。
- 登录页支持部署级锁定地址、自定义输入，以及当前浏览器记住并锁定地址；浏览器只保存服务器地址，不保存账号密码或令牌。
- 自定义服务器的会话、审计和媒体策略按服务器 origin 隔离。不同服务器即使返回相同 Matrix ID，也不能读取对方的审计或使用对方的清理凭据。
- 旧 Node 版数据卷自动迁移，保留原 AES-256-GCM 密钥与凭据格式，首次迁移备份为 `state.v1.backup.json`。

![部署锁定登录页](docs/login-locked.jpg)

## 部署

```bash
git clone https://github.com/utoptop/tuwunel-admin.git
cd tuwunel-admin
cp config.example.toml config.toml
# 按下方示例编辑 config.toml
docker compose up -d
```

Compose 只读挂载 `config.toml`，持久化 `/app/data`，默认绑定宿主机 `127.0.0.1:8080`。更改端口映射请编辑 `compose.yaml`，不使用 `.env`。服务器启动时读取配置，更改后运行 `docker compose restart`。

### 固定并锁定 Matrix 服务器

```toml
[server]
listen = "0.0.0.0:8080"
public_url = "http://localhost:8080"
cookie_secure = false
static_dir = "./dist"

[matrix]
homeserver = "https://matrix.example.com"
locked = true
allowed_homeservers = []

[storage]
data_dir = "./data"
```

登录页展示只读地址及「部署配置已锁定」标识。后端也拒绝传入其他地址，修改浏览器 HTML 或直接调用登录 API 无法绕过。

上游是 Docker 内网服务时，可以直接配置 `homeserver = "http://tuwunel:8008"`，并将两个容器加入同一网络。Matrix 地址应是实际客户端 API 的 origin，不一定等于 Matrix ID 中的域名。

### 允许自定义输入服务器

```toml
[matrix]
locked = false
homeserver = "https://matrix.example.com" # 可留空；非空时作为默认地址
allowed_homeservers = []
```

用户可在登录页输入完整地址。勾选「记住并锁定此地址（当前浏览器）」会将地址保存到浏览器并锁定输入框，取消勾选即可编辑。这是方便使用的本地偏好，不能替代部署级锁定。

未在配置中指定的自定义地址仅允许公网 HTTPS：连接时 DNS 解析结果必须全部是公网 IP；拒绝回环、私网、链路本地、保留地址及 IP 映射绕过，不跟随重定向，不继承系统代理。这样自定义输入不会成为任意内网代理。

如需限定可选服务器或使用内网 HTTP，明确列入配置：

```toml
[matrix]
locked = false
homeserver = "https://matrix.example.com"
allowed_homeservers = [
  "https://matrix.example.com",
  "https://chat.example.org",
  "http://tuwunel:8008"
]
```

非空列表将限制登录目标为这些地址以及默认 `homeserver`。显式配置的目标受到部署者信任，可以使用内网地址和 HTTP；不要将不受信任的域名加入此列表。每个地址独立绑定会话和策略，登录后不能通过管理请求更换上游。

### HTTPS 反向代理

```toml
[server]
listen = "0.0.0.0:8080"
public_url = "https://admin.example.com"
cookie_secure = true
static_dir = "./dist"
```

Caddy 在同一宿主机运行时：

```caddyfile
admin.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

`public_url` 必须与浏览器实际访问的协议、域名、端口一致；HTTPS 必须配合 `cookie_secure = true`。Matrix 请求从 Rust 后端发出，无需给浏览器配置上游 CORS。后端始终验证 TLS 证书。

## 功能

| 模块 | 功能 |
| --- | --- |
| 用户 | 搜索分页、创建、修改资料/权限/密码、锁定、暂停、停用并擦除、重新启用 |
| 用户详情 | 加入的房间、设备增删与重命名、媒体、连接信息、成员关系、账户数据 |
| 房间 | 成员、状态、事件、媒体；加入成员、设置管理员、封禁、清理历史、异步删除 |
| 媒体 | 存储排行、MXC 查询、单个/按用户/按时间大小删除、远程缓存清理 |
| 生命周期 | 每个服务器独立的保留天数、间隔、头像保护、加密凭据、重启恢复、运行结果 |
| 注册与联邦 | 注册令牌管理、联邦目标/共享房间/重试、服务器通知 |
| 系统 | 后台任务、审计、73 个高级 API 操作、中文响应式 UI |

API 映射保存在 [backend/catalog.json](backend/catalog.json)，完整清单见 [docs/API.md](docs/API.md)。基于 [Tuwunel 官方文档](https://matrix-construct.github.io/tuwunel/development/compliance/synapse-admin.html) 与 [已核对的官方源码](https://github.com/matrix-construct/tuwunel/tree/2a0ae4be1c7f036714cecb91edd9247cf06c09d0)。已完成官方 Tuwunel 2.0.0 真实联调；旧服务器可能缺少部分 API，系统会显示实际错误。

**实际语义：**

- 删除用户采用停用和 `erase=true`，不物理删除 Matrix ID，不删除其他服务器副本；撤回事件需单独执行。
- 加密房间事件仍是密文，管理系统没有解密密钥。
- 媒体清理按存储文件修改时间，不是最后访问时间；没有 dry-run；本地删除会影响消息附件。
- MAS / SSO 使用已有客户端的管理员 Access Token 登录。MAS 不提供的密码重置、注册令牌等操作不能通过本系统绕过。
- 媒体隔离、举报等上游未实现的 API 不提供虚假实现。本系统也不替代 Tuwunel 原生配置、备份或进程管理。

## 配置项

完整注释见 [config.example.toml](config.example.toml)。相对路径以配置文件所在目录为基准。程序支持 `--config /path/config.toml`、`--health-check`、`--version`，运行时不从环境变量读取设置。

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `server.listen` | `0.0.0.0:8080` | HTTP 监听地址 |
| `server.public_url` | `http://localhost:8080` | Origin/CSRF 校验基准 |
| `server.cookie_secure` | `false` | HTTPS 时必须为 true |
| `server.static_dir` | `dist` | 前端构建目录 |
| `matrix.homeserver` | 空 | 默认或锁定的上游地址 |
| `matrix.locked` | `false` | 部署级锁定 |
| `matrix.allowed_homeservers` | `[]` | 允许/信任的精确 origin 列表 |
| `storage.data_dir` | `data` | 策略、审计、密钥目录 |
| `storage.encryption_key_file` | 空 | 可选的外部 32 字节原始密钥文件 |
| `limits.session_hours` | `12` | 会话寿命，1–168 小时 |
| `limits.login_attempts` | `10` | 每个直接连接 IP 的登录尝试上限 |
| `limits.login_window_seconds` | `600` | 登录限速窗口 |
| `limits.max_sessions` | `1024` | 活跃会话上限 |
| `limits.request_timeout_seconds` | `30` | 单次 Matrix 请求超时 |
| `limits.max_response_bytes` | `8388608` | Matrix 响应大小上限 |
| `scheduler.enabled` | `true` | 是否运行已保存的自动清理计划 |
| `scheduler.poll_seconds` | `60` | 到期任务检查间隔 |

请求体上限 128 KiB。写操作需要 Origin、CSRF 和显式确认；只有固定目录中的 API 能被代理。异步 Rust 客户端复用连接池，每次读取上游响应均限制大小和时间。详情见 [测试与性能说明](docs/TESTING.md)。

## 媒体生命周期与持久化

登录目标服务器后，在「媒体与存储 → 生命周期」配置保留规则和一个独立的管理员 Access Token。计划不依赖浏览器会话；首次执行在一个配置间隔后，也可立即执行已保存规则。每次运行前验证凭据仍有管理员权限。

不同服务器独立保存规则和令牌，按当前地址规则重新验证目标；切换到锁定模式后，其他服务器的旧计划将记录失败而不会访问。停用计划需先登录对应服务器。`scheduler.enabled = false` 可全局暂停自动计划，仍允许管理员手动执行。

同一服务器的运行和保存互斥；不同服务器至多 4 个后台任务并行。部分失败保留已完成计数。进程关闭时暂停计划，重启后执行到期任务。

数据目录包含 `state.json`、`encryption.key` 和进程锁 `state.lock`。策略凭据以 AES-256-GCM 加密，密钥默认与数据一起存放；整个卷的读取权限等于解密权限。需要密钥分离时，将 32 字节原始密钥文件只读挂载后设置 `encryption_key_file`。**必须一并备份密文和密钥**，不能直接更换密钥后期待解密旧数据。

会话仅保存在内存，重启需重新登录。密码不持久化。正常退出会异步注销网页登录创建的 Matrix 令牌，导入令牌只退出本地会话；异常退出遗留的设备可在客户端或本系统设备管理中清理。

审计最多保留本实例最近 2,000 条，仅向对应服务器的管理员展示，不包含密码、令牌或请求正文；不是不可篡改审计。一个数据目录只允许一个进程持有，不支持多个副本共享调度。

## 从 Node 1.0 升级

1. 备份原数据卷及密钥，保留旧镜像摘要以便回滚。
2. 复制 `config.example.toml` 为 `config.toml`，将旧 `.env` 的服务器地址、公开 URL、Cookie 设置转入对应 TOML 字段。**环境变量不再生效。**
3. 单服务器部署设置 `matrix.homeserver` 为原地址、`locked = true`。旧审计没有服务器字段，迁移时使用旧策略的地址，或配置的默认地址进行归属；两者都没有而存在旧审计时拒绝启动，防止错误归属。
4. 更新 Compose，挂载配置文件，并继续挂载原数据卷到 `/app/data`。容器 UID 仍为 1000。
5. 若旧部署设置了 `ENCRYPTION_KEY`，先将其 base64 解码为独立的 32 字节密钥文件，设置 `storage.encryption_key_file`；不要在聊天或日志中输出密钥。
6. 启动后自动备份旧 JSON 并迁移到 schema 2，原密钥和加密格式不变。重新登录确认策略与审计。回滚时停止新版本并恢复备份的 `state.json` 与原密钥。

## 开发和测试

需要 Rust 1.93.1+，Node.js 24+ 仅用于前端构建及测试工具。

```bash
npm ci
cp config.example.toml config.toml
# 开发时 server.public_url="http://localhost:5173"
# server.listen="127.0.0.1:8080"；配置 Matrix 地址
npm run server
# 另一个终端
npm run dev
```

```bash
npm run check                # Rust 单元测试、HTTP 集成测试、前端类型检查/构建
cargo build --release        # 优化的单一后端二进制
npm start                    # 读取 config.toml
cargo fmt --all -- --check
```

真实联调使用独立临时 Tuwunel，操作流程见 [docs/TESTING.md](docs/TESTING.md)。生产运行目录只需 Rust 二进制、`dist/`、配置文件和可写数据目录。

CI 验证 Rust、前端与 Docker 构建。发布工作流需要 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` Actions Secrets；发布 `:1.0` 和 `:1.1` 双架构镜像。GitHub 密钥不能替代 Docker Hub 凭据。

## 排错

- 来源不匹配：核对 `server.public_url`，修改后重启。
- 自定义内网地址被拒绝：部署者将其精确 origin 写入 `homeserver` 或 `allowed_homeservers`；无需关闭全局地址防护。
- 已锁定仍想换服务器：浏览器偏好锁可取消；部署锁必须编辑 TOML 后重启。
- API 不支持：检查 Tuwunel 版本和 MAS 模式；不会通过聊天命令模拟未实现接口。
- 容器无法写入：数据目录必须允许 UID 1000 写入。配置挂载为只读，数据卷必须可写。
- 健康检查失败：检查配置监听端口、配置文件路径和数据卷占用。

这是独立管理工具，与 Tuwunel 官方项目无隶属关系。
