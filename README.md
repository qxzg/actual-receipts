# 小票账本

手机友好的中文私有记账工具：Passkey 登录 → 上传小票 → 选择付款账户 → 识别商品 → 核对分类与分摊 → 写入 Actual 拆分交易。

## 运行

- Node **24.20.0**、Actual API **26.9.0**、Codex App Server **0.153.4**。
- 所有依赖锁在 `package-lock.json`，服务器使用构建好的镜像。
- 服务地址默认 `https://receipts.hx-sun.com`；数据默认位于 `/opt/receipts`。

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:e2e
node scripts/actual-local-check.mjs
```

浏览器测试使用 `/usr/bin/chromium`，可在 `playwright.config.ts` 中调整路径。测试服务器、虚拟 Passkey 和模型/账本样例均位于 `tests/`，生产构建只包含 `src/`。

本地运行需要准备两个 Secret 文件：

```sh
mkdir -p secrets
openssl rand -hex 32 > secrets/master-key
openssl rand -hex 32 > secrets/provider-token
chmod 600 secrets/*
APP_ORIGIN=https://receipts.example.com npm start
```

本地真实 Passkey 使用 HTTPS 反向代理；端到端测试使用浏览器认可的 localhost 安全上下文。

## 部署

`deploy/compose.yml` 复用现有 Caddy/Actual 网络，两个新服务各限 512 MiB。应用与识别服务均以非 root 用户、只读根文件系统运行；数据、Secret 和临时目录分别挂载。容器未暴露宿主机端口。

本机有 Docker 时：

```sh
docker build --target app -f deploy/Dockerfile -t receipt-app:0.1.0 .
docker build --target provider -f deploy/Dockerfile -t codex-provider:0.1.0 .
docker save receipt-app:0.1.0 | gzip > receipt-app-0.1.0.tar.gz
docker save codex-provider:0.1.0 | gzip > codex-provider-0.1.0.tar.gz
```

当前工作环境采用 `scripts/build-images.py` 在本机组装 Docker load 归档：官方 Node 镜像的 manifest、blob、diff ID 均经过 SHA-256 校验，生产依赖先在 Node 24 环境安装。归档摘要记录在 `artifacts/images/manifest.json`。

将镜像、manifest 及 `deploy/` 中的配置复制到服务器 `/opt/receipts`，运行 `deploy/install.sh`。脚本校验归档、创建 Secret、启动容器、备份 Caddy 配置、校验新路由后热加载；错误时恢复原 Caddy 配置。

Codex 容器通过只读挂载 `/etc/ssl/certs/ca-certificates.crt` 使用宿主机公共 CA 证书。部署主机需安装并更新 `ca-certificates`；Compose 会在证书文件缺失时阻止启动。证书校验始终开启。

`TRUSTED_PROXY` 必须为现有 Caddy 在共享 Docker 网络中的实际 IP。Caddy 设置 `X-Forwarded-For` 为对端地址，应用仅信任该 Caddy 地址。通过 Cloudflare 代理访问时，认证限流按 Cloudflare 边缘对端聚合；单用户首版使用保守限制。Caddy 容器重新创建后请重新检查地址。

## 首次使用

1. 在服务器生成有效期 15 分钟的初始化令牌：
   ```sh
   cd /opt/receipts
   docker compose exec receipt-app node dist/server/admin.js bootstrap
   ```
2. 打开工具网址，输入令牌并用自己的设备注册 Passkey。保存一次性展示的恢复码，然后在设置中添加备用 Passkey。
3. 在设置中输入 Actual 服务器密码和独立测试账本的 Sync ID，测试并保存连接。
4. 选择 ChatGPT 订阅时，通过设备码完成授权后，在下拉列表选择账号可用的图片模型，并阅读简短说明；API 模式填写 Base URL、Key 和协议，再获取模型列表并选择。保存后运行图片能力测试。
5. 用测试小票核验商品、数量、分类、优惠、税费范围和实付总额。完成同步、断网恢复、资源测量和备份恢复验收后，再切换正式账本。

图片可直接拍照或从相册选择。输入金额时以元/美元等主要单位填写，系统统一以整数百分之一单位计算。长小票按顺序上传，范围含糊的税费需要人工确认。

## 账号恢复

网页输入一个恢复码，绑定新 Passkey。恢复成功会撤销旧 Passkey、旧会话和旧恢复码。所有凭据遗失时：

```sh
cd /opt/receipts
docker compose exec receipt-app node dist/server/admin.js recover
```

管理员命令输出的一次性令牌进入相同受限恢复流程。

## 备份、恢复和回滚

```sh
cd /opt/receipts
./backup.sh
./restore-check.sh backups/receipts-TIMESTAMP.tar.gz
```

备份包含 SQLite、图片、Actual 缓存及未发送消息、主密钥、内部认证密钥、Codex 凭据和 Compose 配置。备份目录权限为私有；再通过 SSH 下载到受控离线存储。恢复时停止两个新容器，保留当前目录副本，再解包备份、恢复 1000:1000 数据所有权、启动并执行 `admin check`。主密钥应与数据库一起保留。

回滚新增服务：停止 `receipts` Compose 项目，将 `backups/Caddyfile.before-receipts` 内容恢复到 `/opt/actual/Caddyfile` 后校验并 reload Caddy。保留业务数据与 Secret，以便后续恢复。

## 文档

- [架构、安全与提交协议](docs/ARCHITECTURE.md)
- [验收记录](docs/ACCEPTANCE.md)
- [部署清单](deploy/compose.yml)
