# 双人联网五子棋

一个零依赖的 Node.js 五子棋网站。两位玩家打开同一个网址后，输入昵称进入私人对局，系统自动分配黑棋和白棋，并通过 WebSocket 实时同步落子、回合、20 秒计时、超时换手、胜负和对局消息。

## 本地运行

```bash
npm start
```

打开 `http://localhost:4173`，输入昵称进入对局后，把页面链接发给另一位玩家。

## 发布到 Render

这个项目已经包含 `render.yaml`，可以直接部署成 Render Web Service。不要选择 Static Site，因为实时对战需要 WebSocket 后端。

1. 把 `gomoku-online` 这个目录上传到一个 GitHub 仓库。
2. 打开 Render Dashboard，选择 `New > Blueprint`，连接这个 GitHub 仓库。
3. Render 会读取 `render.yaml`，创建 `gomoku-online` Web Service。
4. 发布完成后，打开 Render 给你的 `https://...onrender.com` 地址。
5. 你和朋友打开同一个地址，输入昵称后会自动分配黑棋和白棋。

如果不用 Blueprint，也可以手动选择 `New > Web Service`，设置：

- Build Command: `npm install`
- Start Command: `npm start`
- Environment Variable: `HOST=0.0.0.0`

Render 会自动提供 `PORT`，项目会优先使用这个端口。

## 其他平台

```bash
HOST=0.0.0.0 PORT=4173 npm start
```

本地默认监听 `127.0.0.1`；公网服务器部署时设置 `HOST=0.0.0.0`。部署后直接访问你的域名或服务器地址即可，前端会自动使用同域名下的 `/ws` 建立实时连接。
