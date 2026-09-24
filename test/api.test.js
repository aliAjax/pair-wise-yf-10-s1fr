"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");

const PORT = 39231;
const BASE = `http://127.0.0.1:${PORT}`;
let server;

test.before(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-api-"));
  const dbFile = path.join(dir, "db.json");
  const spliceFile = path.join(dir, "splices.json");
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), DB_FILE: dbFile, SPLICE_DB_FILE: spliceFile },
    stdio: ["ignore", "pipe", "inherit"]
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 5000);
    const wait = () =>
      request("GET", "/health")
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch(() => setTimeout(wait, 100));
    wait();
  });
});

test.after(() => {
  if (server) server.kill();
});

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      `${BASE}${urlPath}`,
      {
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {}
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("全流程：旧曲目未放行 -> 登记被规则拦截 -> 合法登记 -> 连续两次破孔返工 -> 返工后试拉通过 -> 闸门放行；主库原段不动", async () => {
  // 1. 旧曲目无接片资料：未放行
  let gate = await request("GET", "/tunes/tune_demo/punch-gate?nextBeat=33");
  assert.equal(gate.status, 200);
  assert.equal(gate.body.data.allowed, false);
  assert.match(gate.body.data.reason, /无接片资料/);

  // 2. 拍号接错：右段从 40 拍起，与接口 32 不首尾相接
  let res = await request("POST", "/tunes/tune_demo/splices", {
    leftSectionId: "section_demo_1",
    rightSectionId: "section_demo_2",
    seamBeat: 40,
    tapeBatch: "T-01",
    inspector: "老周"
  });
  // 左段末拍 32 与接口 40 不符，规则层拒绝
  assert.equal(res.status, 400);
  assert.match(res.body.error, /首尾相接/);

  // 3. 合法登记（32|33 接缝；左段未校对）
  res = await request("POST", "/tunes/tune_demo/splices", {
    leftSectionId: "section_demo_1",
    rightSectionId: "section_demo_2",
    seamBeat: 32,
    tapeBatch: "T-01",
    inspector: "老周"
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const spliceId = res.body.data.id;
  assert.equal(res.body.data.status, "待试拉");
  assert.equal(res.body.data.paperType, "半透明纸带");
  assert.equal(res.body.data.tensionLimitN, 18);

  // 待试拉：闸门仍关
  gate = await request("GET", "/tunes/tune_demo/punch-gate?nextBeat=33");
  assert.equal(gate.body.data.allowed, false);

  // 4. 第一次破孔：仍待试拉，连续计数 1
  res = await request("POST", `/splices/${spliceId}/pulls`, { tensionN: 15, holesBroken: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, "待试拉");
  assert.equal(res.body.data.consecutiveBroken, 1);
  assert.match(res.body.data.failureReasons[0].reason, /单次破孔/);

  // 5. 第二次连续破孔：转待返工
  res = await request("POST", `/splices/${spliceId}/pulls`, { tensionN: 15, holesBroken: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, "待返工");
  assert.ok(res.body.data.failureReasons.some((f) => f.reason === "连续两次破孔"));

  // 待返工不能直接试拉
  res = await request("POST", `/splices/${spliceId}/pulls`, { tensionN: 15, holesBroken: false });
  assert.equal(res.status, 409);

  // 6. 登记返工（可换胶带批号/检验人）
  res = await request("POST", `/splices/${spliceId}/reworks`, {
    tapeBatch: "T-02",
    inspector: "阿芳",
    note: "重新打磨接口边缘"
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, "待试拉");
  assert.equal(res.body.data.tapeBatch, "T-02");

  // 7. 返工后试拉通过：放行，且旧失败原因保留
  res = await request("POST", `/splices/${spliceId}/pulls`, { tensionN: 15, holesBroken: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, "已放行");
  assert.ok(res.body.data.failureReasons.some((f) => f.reason === "连续两次破孔"), "旧失败原因应保留");
  assert.ok(res.body.data.events.some((e) => e.type === "rework"), "返工事件应保留");

  // 8. 闸门放行
  gate = await request("GET", "/tunes/tune_demo/punch-gate?nextBeat=33");
  assert.equal(gate.body.data.allowed, true);
  const seamGate = await request("GET", "/tunes/tune_demo/splice-gate?seamBeat=32");
  assert.equal(seamGate.body.data.released, true);

  // 9. 主库原段与打孔进度未被接片流程改动
  const sections = await request("GET", "/tunes/tune_demo/sections");
  assert.deepEqual(sections.body.data.map((s) => [s.id, s.startBeat, s.endBeat, s.checked]), [
    ["section_demo_1", 1, 32, true],
    ["section_demo_2", 33, 64, false]
  ]);
});

test("张力超过纸型上限：直接判待返工，原段不动", async () => {
  let res = await request("POST", "/tunes", {
    title: "张力测试曲",
    stripSpec: { paperType: "牛皮纸带" }
  });
  assert.equal(res.status, 201);
  const tuneId = res.body.data.id;

  res = await request("POST", `/tunes/${tuneId}/sections`, { startBeat: 1, endBeat: 16, laneRange: "1-10" });
  const leftId = res.body.data.id;
  res = await request("POST", `/tunes/${tuneId}/sections`, { startBeat: 17, endBeat: 32, laneRange: "1-10" });
  const rightId = res.body.data.id;

  res = await request("POST", `/tunes/${tuneId}/splices`, {
    leftSectionId: leftId,
    rightSectionId: rightId,
    seamBeat: 16,
    tapeBatch: "T-10",
    inspector: "老周"
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const spliceId = res.body.data.id;
  assert.equal(res.body.data.tensionLimitN, 26);

  // 27N 超过牛皮纸带 26N 上限，即使没破孔也判待返工
  res = await request("POST", `/splices/${spliceId}/pulls`, { tensionN: 27, holesBroken: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, "待返工");
  assert.match(res.body.data.failureReasons[0].detail, /上限 26N/);

  // 原段未被改动
  const sections = await request("GET", `/tunes/${tuneId}/sections`);
  assert.deepEqual(sections.body.data.map((s) => [s.startBeat, s.endBeat, s.checked]), [
    [1, 16, false],
    [17, 32, false]
  ]);
});

test("已校对区间覆盖接缝时登记被拒绝", async () => {
  // 左段 60-75（未校对）、右段 76-85（未校对），但另有一个已校对区间 74-77 横跨 75|76 接缝
  let res = await request("POST", "/tunes/tune_demo/sections", {
    startBeat: 60,
    endBeat: 75,
    laneRange: "1-10",
    checked: false,
    note: "未校对左补段"
  });
  assert.equal(res.status, 201);
  const leftId = res.body.data.id;
  res = await request("POST", "/tunes/tune_demo/sections", {
    startBeat: 76,
    endBeat: 85,
    laneRange: "1-10",
    checked: false
  });
  const rightId = res.body.data.id;
  res = await request("POST", "/tunes/tune_demo/sections", {
    startBeat: 74,
    endBeat: 77,
    laneRange: "1-10",
    checked: true,
    note: "横跨接缝的已校对区间"
  });
  assert.equal(res.status, 201);

  res = await request("POST", "/tunes/tune_demo/splices", {
    leftSectionId: leftId,
    rightSectionId: rightId,
    seamBeat: 75,
    tapeBatch: "T-20",
    inspector: "老周"
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /跨过已校对区间/);
});

test("不存在的曲目与接片记录返回 404", async () => {
  assert.equal((await request("GET", "/tunes/nope/splices")).status, 404);
  assert.equal((await request("GET", "/splices/splice_nope")).status, 404);
});
