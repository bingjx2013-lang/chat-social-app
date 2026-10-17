# 微聊第二阶段候选改动说明

本包基于第一阶段候选代码制作；没有推送到 GitHub，也没有部署到 Render。

## 本阶段包含
1. 登录失败记录：SQLite 记录账号哈希与 IP 哈希，15 分钟内账号失败达到 8 次或 IP 达到 20 次时临时拒绝登录；数据最多保留 7 天。仍保留 IP rate limiter。
2. 会话设备管理：新增列出会话、撤销单个其他会话、退出所有其他设备的 API，并添加简单前端入口。
3. 文件安全：拒绝危险扩展名，基于文件头识别 PNG/JPEG/GIF/MP4/PDF/ZIP 等常见格式；未知类型降为 application/octet-stream 或拒绝可疑声明；下载统一使用 attachment 与 nosniff。不是完整的反病毒扫描。
4. 邮箱验证：新增邮箱列、一次性 30 分钟验证令牌与 Nodemailer SMTP 发送；需配置 SMTP_*、EMAIL_FROM、PUBLIC_BASE_URL 和 REQUIRE_EMAIL_VERIFICATION=true。若启用，注册需要邮箱。已有账号需自行完成邮箱绑定/验证迁移流程，目前没有管理后台。
5. 数据备份：`npm run backup` 会对 SQLite 做一致性备份并复制 uploads 目录。备份目录默认在 DATA_DIR/backups，生产环境应另行复制到独立存储；不能只把备份留在同一磁盘。

## 需要的环境变量
- `REQUIRE_EMAIL_VERIFICATION=false` 默认关闭，SMTP 未配置时不要打开。
- `PUBLIC_BASE_URL=https://你的正式测试域名`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`
- `DATA_DIR` 指向持久化数据目录。
- 可选 `BACKUP_DIR` 设置备份输出目录。

## 测试/限制
- 邮箱验证需配置真实 SMTP 才能端到端测试。
- 备份脚本需要运行时 Node.js 依赖安装完成。
- 文件签名检测只覆盖常见类型，不等于恶意软件扫描；大型视频可能会因文件头不在所检查的 16 字节范围而被当作未知类型，默认按附件下载。
- 登录限制按哈希后的账号与 IP 统计，适合单实例 SQLite 部署；多实例环境应迁移到共享 Redis 等存储。
- 这是候选代码，部署前需要在独立测试服务验证所有旧功能与新功能，特别是注册、登录、Cookie、Socket.IO、附件、邮件、会话撤销和备份恢复。
