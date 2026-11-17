# 服务器监测与注册 IP 审计

v1.4 的「服务器监测」显示 Tuwunel 进程 RSS、CPU 使用率、磁盘读写速率、网络收发速率、线程数与已建立 TCP 连接，以及部署配置和注册审计。采集器 `tuwunel-observer` 用 Rust 编写，和面板一起包含在 `utoptop/tuwunel-admin:1.0`、`:1.4` 镜像内。面板无需 Docker socket，也不会执行任意系统命令。

这些数据不在 Tuwunel 现有 HTTP 管理 API 中。只连接远程 Matrix API 时显示「未接入」，不会用面板容器的 CPU、内存冒充 Tuwunel。HTTP 活跃请求并发和内存总线带宽目前不可获取；TCP 连接、线程和网络带宽有明确独立标签。

## Docker 部署

1. 在现有 Tuwunel Compose 目录复制 [observer.example.toml](../deploy/observability/observer.example.toml) 为 `observer.toml`。填写面板登录实际使用的 `homeserver` 和 Matrix ID 的 `server_name`；如登录地址为 `https://matrix.example.com`，用户为 `@admin:example.com`，二者分别填写对应值。
2. 创建 `observability` 目录，使采集器用户可写、面板 UID 1000 可读。参考 [Compose 片段](../deploy/observability/compose.example.yaml)，合并到现有文件，替换服务名、Tuwunel 配置路径、UID/GID。采集器只读挂载配置与日志目录，只写快照目录。不要挂载 Docker socket。
3. 将下面内容加到面板 `config.toml`，重启面板和采集器：

```toml
[[observability.sources]]
homeserver = "https://matrix.example.com"
snapshot_file = "/app/observability/server.json"
```

允许自定义服务器地址的部署可配置多个来源，按精确 homeserver 隔离；快照的 homeserver 与 server_name 均须匹配当前登录。相对路径以配置文件目录为准。部署者只能在配置文件中指定读取路径，网页无法修改。

采集器默认监控共享 PID 命名空间的 PID 1，并检查 `/proc/1/comm` 是否等于 `tuwunel`。如果容器使用 init 包装器，设置实际 PID；二进制名称不同则填写实际名称。默认每 5 秒写入一次原子快照，页面每 5 秒更新，保留最近 120 个样本。超过 30 秒的快照显示过期。首次采样与计数器重置时不显示速率。

如果磁盘 I/O 显示不可读，检查采集器与目标进程 UID、Linux proc/ptrace 访问限制。不要把不可读当作零 I/O。`cap_drop: [ALL]` 是默认最小权限模板。官方 Tuwunel 镜像以 root 运行时，实测需要 [I/O 覆盖片段](../deploy/observability/compose.io.example.yaml) 中的 `user: "0:0"` 和 `cap_add: [SYS_PTRACE]` 才能读取 `/proc/1/io`。这是明确的额外进程权限，不能视作纯文件读取权限；仅共享目标容器的 PID 命名空间，不使用 host PID、不挂 Docker socket，代码只读取统计文件。也可保持默认权限，让界面标注 I/O 不可用。网络指标统计目标网络命名空间，排除 loopback；host 网络模式会包含同一命名空间其他进程的流量。CPU 100% 代表一个核心；RSS 不等于容器 cgroup 总内存。

## Linux / systemd 与远程主机

同样可直接运行镜像中的 Linux 二进制，或 `cargo build --release --bin tuwunel-observer` 编译。设置 Tuwunel 实际 PID、proc_root、文件路径，使用 systemd 管理 `tuwunel-observer --config /path/observer.toml`。`--once` 只生成一次快照，适合检查接入。

面板和 Tuwunel 不在同一主机时，在 Tuwunel 主机运行采集器，通过受控共享目录或原子复制把 `server.json` 交给面板读取。快照包含管理员可见的 IP 信息，不要放到公共静态目录。当前不提供公网采集 HTTP 服务。没有部署权限时，只能使用现有 Matrix API 功能。

## 服务器配置

配置视图只读展示挂载 TOML 文件中的已知非敏感字段，包括服务器、注册、请求大小、线程/数据库池/流并发参数。支持旧版平铺字段和新版 `global` 分组字段。使用字段白名单，令牌、密码、密钥及未知字段不进入快照。

这是一份**文件配置快照**，不是生效配置的完整导出：默认值、环境变量覆盖和运行时改动不会凭空补齐。关闭某项采集只需从 `observer.toml` 删除 `tuwunel_config` 或 `registration_log` 字段。

## 注册来源与重复失败 IP

Tuwunel 的 whois 只给出设备最近连接 IP，不能用来反推账号创建 IP。必须先收集可信注册审计日志：

- 普通 Nginx：参考 [注册日志配置](../deploy/observability/nginx-registration.conf)，仅写注册 POST 的时间、来源 IP、路径、状态码。能够统计请求结果，但没有账号关联。
- OpenResty：参考 [可选增强配置](../deploy/observability/openresty-registration.conf)，从成功注册响应中提取唯一需要的 `user_id`。不记录请求体、查询参数、Authorization、密码或完整响应。不要把用户提交的 username 当成已创建账号。
- 使用其他代理时输出下列 JSONL 格式；一行一事件。成功事件的 user_id 必须来自服务端成功响应。MAS 账号注册不经过 Matrix `/register` 时，需在 MAS 侧输出同等含义的成功/拒绝事件，再规范化到此事件格式；面板不会推测 MAS 内部日志。

```json
{"time":"2026-11-17T12:00:00+08:00","ip":"192.0.2.42","method":"POST","path":"/_matrix/client/v3/register","status":200,"user_id":"@alice:example.com"}
{"time":"2026-11-17T12:01:00+08:00","ip":"192.0.2.43","method":"POST","path":"/_matrix/client/v3/register","status":403}
```

`ip` 使用代理实际确认的客户端 IP。前置 CDN/代理时，只为已知可信代理地址配置 real_ip 模块；不可无条件相信外部传入的 X-Forwarded-For。将日志目录只读挂载到采集器并填写 registration_log。用日志目录挂载以便日志轮转后的新文件仍可见。

分类：200/201 成功，401 认证挑战，429 限流，其余 4xx 拒绝，5xx 服务错误。「多次」筛选是最近 24 小时可见日志中拒绝加限流至少 3 次；这是请求统计，并非证明用户恶意。UIA 正常会经历 401，不能计为失败。

读取当前文件最后 8 MiB；来源聚合最多 2,000 个 IP、账号关联最多 10,000 个。页面表格每次最多显示 200 个搜索结果，用户详情可查对应创建 IP。页面标出最早可见时间、截断与无效行，日志轮转前的旧文件和接入前的注册无法还原。完整长期审计应保留原始日志或接入专门日志平台。

实现参考：[Nginx JSON 日志格式](https://nginx.org/en/docs/http/ngx_http_log_module.html)、[OpenResty body_filter_by_lua](https://github.com/openresty/lua-nginx-module#body_filter_by_lua_block)、[Tuwunel 源码](https://github.com/matrix-construct/tuwunel)。
