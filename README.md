# GG Build Executor — Railway 版

此版本把公益站 WebSocket 执行器和 Gemini 请求搬到了 Railway 后台。网页只负责登录、查看状态和控制执行器；关掉网页或浏览器不会断开后台连接。

## Railway 部署

1. 将此项目目录部署为一个 Railway 服务，使用 Node.js 22.9 或更新版本。Railway 会运行 `npm run build` 和 `npm start`。
2. 在服务的 Variables 中设置：
   - `GEMINI_API_KEY`：Google Gemini API Key。AI Studio Build 运行时自动提供的 Key 不会随导出源码带到 Railway。
   - `DASHBOARD_PASSWORD`：网页登录密码，设置为至少 16 字节的长随机值。
   - `APP_ENCRYPTION_KEY`：至少 32 字节的随机值，用来加密保存的公益站 API Key。保留此值；更换后旧的已保存 Key 将无法解密。
   - `DATA_DIR=/app/data`
3. 为服务添加 Railway Volume，挂载路径设为 `/app/data`。Key、连接设置、统计和最近请求会保存在这个 Volume。
4. 在 Networking 中生成 Railway 域名，并把 Healthcheck Path 设为 `/health`。
5. 保持一个服务副本，避免同一个公益站 Key 同时连接多个执行器。
6. 打开生成的 Railway 域名，用 `DASHBOARD_PASSWORD` 登录，输入“公益站 API Key”，然后选择“启动 / 恢复后台”。

Railway 会将服务监听端口放在 `PORT` 环境变量中。本项目监听 `0.0.0.0:$PORT`。部署时服务必须保持运行；浏览器只需在需要查看或控制时打开 Railway 域名。

## 控制说明

- **暂停后台**：断开公益站连接并保留已保存的 Key。当前活动请求会被取消。
- **启动 / 恢复后台**：使用已保存的 Key 重新连接；也可先输入新 Key 来更换。
- **停止并清除 Key**：停止连接并从 Railway Volume 删除已保存的公益站 Key。
- “记住此浏览器的 Key”只控制本地浏览器是否填回输入框；后台仍会加密保存 Key，以便关网页或 Railway 重启后恢复。
- 统计和最近 30 条请求记录保存在 Railway Volume 中。
- Railway 使用 `GEMINI_API_KEY` 环境变量里的单个 Google API Key；切换 Google API 账号时，在 Railway Variables 更新该值并重新部署。

## 本地运行

需要 Node.js 22.9 或更新版本。复制 `.env.example` 为 `.env`，填入三个 Key/密码变量，然后运行：

```powershell
npm ci
npm run build
npm start
```

浏览器打开 `http://localhost:3000`。

## 安全

不要把 `.env`、Railway Variables、`data/state.json` 或实际 Key 上传到公开仓库。网页登录密码用于保护控制接口；`APP_ENCRYPTION_KEY` 用于加密 Volume 中保存的公益站 Key。
