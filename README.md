# 小票账本

面向单用户自托管环境的中文小票记账工具：Passkey 登录、上传小票、AI 识别、人工核对分类与分摊，最后写入 [Actual Budget](https://actualbudget.org/) 拆分交易。

## 功能

- 金额以整数百分之一单位计算，支持商品优惠、整单优惠、税费、小费和费用分摊。
- 通过 Passkey、恢复码、CSRF 校验和短期敏感操作验证保护账户。
- 支持 ChatGPT 订阅的 Codex 模式，以及兼容 OpenAI Responses / Chat Completions 的 API。
- Actual 写入使用稳定提交 ID、重复候选检查、串行子进程和写入后回读核验。
- 原图与识别预览在入账后进入清理队列。

## 快速启动

需要 Docker Engine、Docker Compose 插件和 OpenSSL。

```sh
git clone https://github.com/qxzg/actual-receipts.git
cd actual-receipts
cp .env.example .env
mkdir -p secrets
openssl rand -hex 32 > secrets/master-key
openssl rand -hex 32 > secrets/provider-token
chmod 600 secrets/*
docker compose up --build -d
docker compose exec receipt-app node dist/server/admin.js bootstrap
```

打开 <http://localhost:3100>，输入最后一条命令生成的 15 分钟初始化令牌，并注册第一把 Passkey。恢复码只展示一次，适合立即存入密码管理器。

随后在设置页完成：

1. 填写自己的 Actual 服务器地址、密码和账本 Sync ID。
2. 先选择独立测试账本并执行连接测试。
3. 选择 ChatGPT 订阅或兼容 API，获取模型列表并执行图片能力测试。
4. 上传测试小票，核对商品、优惠、税费范围和实付总额。

容器访问宿主机上的 Actual 时，可填写 `http://host.docker.internal:5006`。公网 Actual 实例建议使用有效的 HTTPS 地址。

## 公网部署

Compose 默认将应用绑定在宿主机 `127.0.0.1:3100`。在反向代理中启用 HTTPS，并在 `.env` 中设置浏览器实际访问的来源：

```dotenv
APP_ORIGIN=https://receipts.example.com
PUBLIC_PORT=3100
TRUSTED_PROXY=172.20.0.2
```

`APP_ORIGIN` 必须与浏览器来源完全一致。localhost 支持 HTTP；其他主机名使用 HTTPS。`TRUSTED_PROXY` 填写直接连接应用的反向代理 IP，应用会据此处理代理地址和认证限流。

数据分别保存在 `receipt-data` 与 `codex-data` 命名卷中。迁移或备份时应将两个卷与 `secrets/` 一起保存。

## 常用命令

```sh
docker compose ps
docker compose logs -f
docker compose up --build -d
docker compose down
```

服务器管理员可以生成受限恢复令牌：

```sh
docker compose exec receipt-app node dist/server/admin.js recover
```

## 开发

项目固定使用 Node 24.20.x，版本记录在 `.node-version`。

```sh
npm ci
npm run check
npm run test:e2e
npm run test:actual
```

`npm run test:actual` 会创建临时 Actual 数据目录，验证父交易、拆分行、分类、稳定 ID 和余额，然后清理测试数据。浏览器测试默认使用 `/usr/bin/chromium`，可在 `playwright.config.ts` 中调整。

本地开发服务器：

```sh
npm run dev
npm run dev:web
```

本地服务仍需 `secrets/master-key` 和 `secrets/provider-token`。Docker Compose 提供完整的 Codex 识别服务；前后端开发也可在设置页使用兼容 API。

架构、安全边界和 Actual 提交协议见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## License

[MIT](LICENSE) © 2026 qxzg

## 商品名称与 Actual 备注

识别会整理商品品牌、简短型号和核心性质；遇到缩写或商品代码时，通过 ChatGPT 授权按需联网查询。API 识别也复用设置页的 ChatGPT 授权。查询来源与票面原文在「规格与识别依据」中查看，匹配疑点可编辑后确认。

新商品子交易的备注采用简洁格式，例如 `IGAN-330 Flush Cutters`、`Diet Coke 7.5flozx10x4` 或 `Foster Farms Free Range Chicken Thighs 3.2lb $1.40/lb`。包装内件数与购买包数分别填写；税费、优惠和分摊金额仍在核对页查看。备注预览随编辑即时更新。

升级后保留父交易标识和已入账历史，已有排队或待核验提交继续使用原备注格式。旧草稿在新提交前需要确认数量类型。
