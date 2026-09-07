# 当前状态与运维交接

更新于 2026-09-07。首版实施、真实小票验收及收尾完成，服务保持运行。用户明确接受当前一把 YubiKey Passkey，备用密钥作为后续可选事项。

## 已确认的线上状态

- 网站：https://receipts.hx-sun.com ，HTTPS 正常；现有 Actual：https://budget.hx-sun.com 。
- 部署：`bwh-us:/opt/receipts`，两个新容器 healthy，各限 512 MiB，Codex 授权在重启后有效。
- 模型采用下拉选择与简短中文说明，当前用户保存的是 ChatGPT / `gpt-5.6-luna`。
- 用户已确认两张真实小票测试完成。服务端：Trader Joe's 17 件、7407 分，Target 2 件、631 分，均 posted / synced / cleanup done。
- 保留一份 Target 草稿（3 行、631 分、1 张图片），作为用户数据保留。
- 无待清理队列；人工验收目录与临时 Actual 测试容器已经移除。
- 用户现有 Actual 连接及设置保持原值。测试账本勾选是用户维护的说明性设置。

## 最新备份

- 服务器：`/opt/receipts/backups/receipts-20260907T174152Z.tar.gz`。
- 本地：`backups/receipts-20260907T174152Z.tar.gz`，权限 600。
- SHA-256 校验通过；独立无网络容器恢复检查 `integrity_check=ok`，两项加密设置可解密，所有者与一把 Passkey 可读。
- 已核对备份包含持久化 ChatGPT 恢复凭据。备份也包含生成时仍保留的草稿图片；备份保管与清理需按其保留周期管理。
- 数据库和主密钥配套保留。备份文件、Secret、原始真实小票均被排除出 Git 与构建上下文。

## 验收依据

- TypeScript 与生产构建通过，57 项自动测试通过。
- Chromium 虚拟 Passkey 完整流程、恢复、错误来源、挑战重放、逐张上传、模型下拉保存、重复确认、图片清理通过。
- 真实模型 Astra 的标准字体图片测试和两图 40 商品人工小票提取通过；所有行金额、数量、分类与已知答案相符。
- 实际识别输出已写入独立 Actual 测试账本，40 子项、余额变化 -9623、重复提交仅一笔、图片清理验证通过。
- 真实长小票阶段应用与 Codex 的已记录峰值合计约 482.43 MiB。
- 最终发布文件摘要见 `docs/RELEASE-MANIFEST.json`，与运行容器一致。详细验收见 `docs/ACCEPTANCE.md`。

## 清理与代码保存

- 已移除 `receipts-actual-test`，及本任务创建的 `/opt/receipts/data/acceptance`、`/opt/receipts/validation`、`/opt/receipts/validation-actual`。
- `test1.jpg` 和 `test2.jpg` 保留在本地，已加入 `.gitignore` 和 `.dockerignore`。
- 源码、测试、部署脚本和文档由本目录 Git 仓库管理；使用 `git log -1` 查看最新提交。
- 本地人工验收材料与镜像保留在忽略目录 `artifacts/`。源代码发布归档位于 `artifacts/release/receipt-ledger-0.1.0-source.tar.gz`。

## 日常管理

```sh
cd /opt/receipts
docker compose ps
docker compose exec receipt-app node dist/server/admin.js check
./backup.sh
./restore-check.sh backups/receipts-TIMESTAMP.tar.gz
```

备份脚本会短暂停止两个新增容器，应选择无上传、识别、提交和设备码登录的时段执行。主密钥、授权文件和备份都应保持私有权限。

只有一把 Passkey 时，账号恢复可使用已生成的恢复码；持有服务器权限的用户也可执行：

```sh
docker compose exec receipt-app node dist/server/admin.js recover
```

## 后续开发

本机项目路径：`/home/Azusa/Documents/ChatGPT/Actual 记账`。

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Node 24.20.0 测试运行时曾安装在 `/tmp/receipts-runtime/node_modules/node/bin/node`；临时目录可能被系统清理，使用前检查。浏览器测试使用 `/usr/bin/chromium`。

本机没有 Docker。`scripts/build-images.py` 在本机组装校验过的官方 Node 镜像层与生产依赖；`--app-only` 可只打包应用。依赖暂存目录为 `/tmp/receipts-release` 和 `/tmp/receipts-provider-release`，重建方式及标准 Dockerfile 见 README。上传成品镜像并校验后使用 `docker load` 与 `docker compose up -d --wait` 发布。

Codex 容器必须只读挂载宿主机公共证书 `/etc/ssl/certs/ca-certificates.crt`。原先缺失此文件导致设备码接口源站 502，已经修复；网页也会将 HTML 网关错误页转换为可读提示。

## SSH

本机系统 SSH drop-in 曾有权限问题，使用明确的用户配置。在需要 YubiKey 触摸前，按用户要求发送猫娘语气提醒：

```sh
notify-send '小票工具维护喵' '准备连接 bwh-us，请触摸 YubiKey 完成 SSH 验证喵～'
ssh -F /home/Azusa/.ssh/config \
  -o ControlMaster=auto -o ControlPath=/tmp/receipts-ssh-%C \
  -o ControlPersist=3600 bwh-us
```

后续执行任何新的业务改动或真实交易操作时，依照用户当时的任务范围进行。
