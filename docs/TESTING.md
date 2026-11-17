# 验证记录与复现

## 自动化测试

`npm test` 使用隔离的本地 HTTP Matrix 模拟服务验证：管理员校验、非管理员拒绝、密码和令牌不泄露、Cookie、Origin/CSRF、白名单与路径编码、写操作确认、上游不支持错误、计划凭据加密与重载、时间/大小清理参数、部分失败、权限撤销、退出及登录限速。

`npm run build` 执行 TypeScript 检查和 Vite 生产构建。Docker 镜像有独立的生产构建与健康检查。

## 真实 Tuwunel 冒烟测试

2026-11-17 在官方 `jevolk/tuwunel:main` 验证，服务器返回 `2.0.0`。当次镜像摘要：

```text
sha256:953890fd1273e005b1523c6f2fd7086a04133582aaa29c51d58e89e8338967e0
```

此脚本创建和删除测试账号、房间与媒体。仅用于下列专用临时容器，固定地址 `127.0.0.1:18008`、服务器名 `matrix.test`；**不要映射生产数据目录，不要针对生产服务器运行**。

```bash
docker run -d --rm --name tuwunel-admin-integration \
  -p 127.0.0.1:18008:8008 \
  -e TUWUNEL_SERVER_NAME=matrix.test \
  -e TUWUNEL_ALLOW_REGISTRATION=true \
  -e TUWUNEL_REGISTRATION_TOKEN=local-integration-only \
  -e TUWUNEL_ALLOW_FEDERATION=false \
  -e TUWUNEL_ADDRESS=0.0.0.0 \
  jevolk/tuwunel:main

# 待 /_matrix/client/versions 返回成功后执行
node tests/real-smoke.mjs
docker stop tuwunel-admin-integration
```

真实验证覆盖：

- 管理员密码登录与退出，服务器版本查询。
- 用户创建、搜索、详情、密码重置后真实登录、锁定/解锁、暂停/恢复及原生 Matrix 管理端点。
- 设备创建、列表、改名、删除。
- 房间创建、管理员加入成员、用户加入房间列表、成员、状态与事件查询。
- 文件真实上传、媒体元数据、用户媒体列表、统计与单项删除。
- 注册令牌创建、修改、列表与删除。
- 持久化生命周期策略，真实调用本地清理与远程缓存清理。
- 联邦目标列表、服务器通知。
- 房间封禁、异步删除及轮询任务直到完成。
- 用户停用并擦除后的状态验证、操作审计。

浏览器验证：真实管理员登录、用户列表和房间详情入口、生命周期表单、高级 API 请求与结果；桌面 1366px、移动 390px 布局，浏览器无控制台错误。截图展示的是独立测试服务器真实数据。

未进行生产负载测试、外部 SSO/MAS 实机测试、跨服务器联邦故障恢复、远程媒体实际重新下载或所有高级 API 的逐个破坏性测试。高级操作基于官方路由/类型定义映射，最终行为由目标服务器决定。
