"use strict";

// 启动入口：只负责监听端口。路由装配见 app.js。
const { createApp } = require("./app");

const PORT = Number(process.env.PORT || 3019);

const server = createApp();

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
