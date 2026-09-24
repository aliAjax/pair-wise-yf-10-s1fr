"use strict";

// 接片放行端到端测试：node --test
// 每个用例独立临时存档与端口，互不干扰，不污染 data/db.json。

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("fs/promises");
const os = require("os");
const path = require("path");

const SERVER_JS = path.join(__dirname, "..", "server.js");

async function startServerOnDb(dbFile) {
  const port = 3000 + Math.floor(Math.random() * 800);
  const child = spawn(process.execPath, [SERVER_JS], {
    env: { ...process.env, PORT: String(port), ORGAN_DB_FILE: dbFile },
    stdio: ["ignore", "pipe", "inherit"]
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server start timeout")), 5000);
    child.stdout.on("data", function wait(chunk) {
      if (String(chunk).includes("running")) {
        clearTimeout(timer);
        resolve();
      } else {
        child.stdout.once("data", wait);
      }
    });
  });
  return { child, baseUrl };
}

// 返回独立服务句柄；restart() 用同一份存档重新拉起，模拟重启
async function newHarness() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "organ-splice-"));
  const dbFile = path.join(dir, "db.json");
  let { child, baseUrl } = await startServerOnDb(dbFile);
  return {
    get baseUrl() {
      return baseUrl;
    },
    async restart() {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.on("exit", resolve));
      ({ child, baseUrl } = await startServerOnDb(dbFile));
    },
    async close() {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.on("exit", resolve));
      await rm(dir, { recursive: true, force: true });
    }
  };
}

async function api(baseUrl, method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function makeTuneWithSections(baseUrl) {
  const { json: tuneRes } = await api(baseUrl, "POST", "/tunes", {
    title: "续接测试曲",
    composer: "测试",
    stripSpec: { widthMm: 70, scale: "20音", tempoBpm: 90, paperType: "半透明纸带" }
  });
  const tuneId = tuneRes.data.id;

  async function addSection(startBeat, endBeat, checked) {
    const { json } = await api(baseUrl, "POST", `/tunes/${tuneId}/sections`, {
      startBeat, endBeat, laneRange: "1-20", checked
    });
    return json.data.id;
  }
  // 已校对 [1-16]；左段 [17-24]；右段 [25-40]；再右 [41-56]
  const sChecked = await addSection(1, 16, true);
  const sLeft = await addSection(17, 24, false);
  const sRight = await addSection(25, 40, false);
  const sFar = await addSection(41, 56, false);
  return { tuneId, sChecked, sLeft, sRight, sFar };
}

test("旧曲目无接片资料按未放行处理，且重启后仍可查询", async () => {
  const h = await newHarness();
  try {
    let { json } = await api(h.baseUrl, "GET", "/tunes/tune_demo/splice-gate");
    assert.equal(json.data.released, false);
    assert.equal(json.data.code, "NO_SPLICE_DATA");

    ({ json } = await api(h.baseUrl, "GET", "/tunes/tune_demo/splices"));
    assert.deepEqual(json.data, []);

    ({ json } = await api(h.baseUrl, "GET", "/tunes/tune_demo/progress"));
    assert.equal(json.data.spliceGate.released, false);
  } finally {
    await h.close();
  }
});

test("接缝跨过已校对区间或拍号不首尾相接时拒绝登记", async () => {
  const h = await newHarness();
  try {
    const { tuneId, sChecked, sLeft, sRight } = await makeTuneWithSections(h.baseUrl);

    // 接口拍号落在已校对区间 [1-16]
    let r = await api(h.baseUrl, "POST", `/tunes/${tuneId}/splices`, {
      leftSectionId: sChecked, rightSectionId: sLeft,
      junctionBeat: 16, tapeLotNo: "T-001", inspector: "甲"
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "SEAM_CROSSES_CHECKED");

    // 拍号首尾不相接：左段尾拍 16 与接口拍号 24 不符
    r = await api(h.baseUrl, "POST", `/tunes/${tuneId}/splices`, {
      leftSectionId: sChecked, rightSectionId: sRight,
      junctionBeat: 24, tapeLotNo: "T-001", inspector: "甲"
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "BEATS_NOT_CONTIGUOUS");

    // 缺字段
    r = await api(h.baseUrl, "POST", `/tunes/${tuneId}/splices`, {
      leftSectionId: sLeft, rightSectionId: sRight, junctionBeat: 24
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /tapeLotNo|inspector/);
  } finally {
    await h.close();
  }
});

test("两次破孔进待返工：不能直接再试拉，返工后试拉通过才放行，旧失败原因保留，进度不动", async () => {
  const h = await newHarness();
  try {
    const { tuneId, sLeft, sRight } = await makeTuneWithSections(h.baseUrl);
    const before = (await api(h.baseUrl, "GET", `/tunes/${tuneId}/sections`)).json.data;

    let r = await api(h.baseUrl, "POST", `/tunes/${tuneId}/splices`, {
      leftSectionId: sLeft, rightSectionId: sRight,
      junctionBeat: 24, tapeLotNo: "TAPE-A1", inspector: "检验员甲"
    });
    assert.equal(r.status, 201);
    const spliceId = r.json.data.id;
    assert.equal(r.json.data.status, "pending_pull");
    assert.equal(r.json.data.tensionLimitN, 24);

    // 第一次破孔：试拉失败但未进返工
    r = await api(h.baseUrl, "POST", `/splices/${spliceId}/pulls`, { tensionN: 20, toreHole: true });
    assert.equal(r.status, 201);
    assert.equal(r.json.result.status, "pull_failed");
    assert.equal(r.json.data.consecutiveTorn, 1);

    // 第二次连续破孔：留在待返工
    r = await api(h.baseUrl, "POST", `/splices/${spliceId}/pulls`, { tensionN: 20, toreHole: true });
    assert.equal(r.json.result.status, "rework_pending");
    assert.equal(r.json.result.reason, "CONSECUTIVE_TORN");
    assert.equal(r.json.data.consecutiveTorn, 2);

    // 闸门阻断
    let gate = (await api(h.baseUrl, "GET", `/tunes/${tuneId}/splice-gate`)).json.data;
    assert.equal(gate.released, false);
    assert.equal(gate.code, "UNFINISHED_SPLICE");
    assert.equal(gate.spliceId, spliceId);

    // 待返工状态直接试拉被拒绝
    r = await api(h.baseUrl, "POST", `/splices/${spliceId}/pulls`, { tensionN: 20 });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "REWORK_REQUIRED");

    // 返工登记（换胶带批号）
    r = await api(h.baseUrl, "POST", `/splices/${spliceId}/reworks`, {
      tapeLotNo: "TAPE-A2", inspector: "检验员乙", note: "打磨接口后重接"
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.data.status, "pending_pull");
    assert.equal(r.json.data.consecutiveTorn, 0);
    assert.equal(r.json.data.reworkCount, 1);
    assert.equal(r.json.data.tapeLotNo, "TAPE-A2");

    // 原段与打孔进度不动
    const after = (await api(h.baseUrl, "GET", `/tunes/${tuneId}/sections`)).json.data;
    assert.deepEqual(
      after.map((s) => ({ id: s.id, checked: s.checked, startBeat: s.startBeat, endBeat: s.endBeat })),
      before.map((s) => ({ id: s.id, checked: s.checked, startBeat: s.startBeat, endBeat: s.endBeat }))
    );

    // 返工后试拉通过才放行
    r = await api(h.baseUrl, "POST", `/splices/${spliceId}/pulls`, { tensionN: 20, toreHole: false });
    assert.equal(r.json.result.status, "released");
    assert.equal(r.json.result.passed, true);
    assert.ok(r.json.data.releasedAt);

    // 旧失败原因保留在 history
    const detail = (await api(h.baseUrl, "GET", `/splices/${spliceId}`)).json.data;
    const pullReasons = detail.history.filter((ev) => ev.type === "pull").map((ev) => ev.reason);
    assert.ok(pullReasons.includes("HOLE_TORN"));
    assert.ok(pullReasons.includes("CONSECUTIVE_TORN"));
    assert.ok(pullReasons.includes(null));
    const reworkEntry = detail.history.find((ev) => ev.type === "rework");
    assert.deepEqual(
      reworkEntry.retainedFailureReasons.slice().sort(),
      ["CONSECUTIVE_TORN", "HOLE_TORN"]
    );

    // 已放行后再试拉/返工均拒绝
    r = await api(h.baseUrl, "POST", `/splices/${spliceId}/pulls`, { tensionN: 20 });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "SPLICE_ALREADY_RELEASED");
    r = await api(h.baseUrl, "POST", `/splices/${spliceId}/reworks`, {});
    assert.equal(r.status, 409);
  } finally {
    await h.close();
  }
});

test("试拉张力超过纸型上限直接留待返工，等于上限不算超", async () => {
  const h = await newHarness();
  try {
    const { tuneId, sLeft, sRight } = await makeTuneWithSections(h.baseUrl);
    const reg = (await api(h.baseUrl, "POST", `/tunes/${tuneId}/splices`, {
      leftSectionId: sLeft, rightSectionId: sRight,
      junctionBeat: 24, tapeLotNo: "T-9", inspector: "丙"
    })).json.data;

    let r = await api(h.baseUrl, "POST", `/splices/${reg.id}/pulls`, { tensionN: 24.5, toreHole: false });
    assert.equal(r.json.result.status, "rework_pending");
    assert.equal(r.json.result.reason, "TENSION_OVER_LIMIT");

    await api(h.baseUrl, "POST", `/splices/${reg.id}/reworks`, {});
    r = await api(h.baseUrl, "POST", `/splices/${reg.id}/pulls`, { tensionN: 24, toreHole: false });
    assert.equal(r.json.result.status, "released");
  } finally {
    await h.close();
  }
});

test("同接口拍号不能重复登记；所有接口放行后闸门才放行", async () => {
  const h = await newHarness();
  try {
    const { tuneId, sLeft, sRight, sFar } = await makeTuneWithSections(h.baseUrl);

    await api(h.baseUrl, "POST", `/tunes/${tuneId}/splices`, {
      leftSectionId: sLeft, rightSectionId: sRight,
      junctionBeat: 24, tapeLotNo: "T-1", inspector: "甲"
    });
    let r = await api(h.baseUrl, "POST", `/tunes/${tuneId}/splices`, {
      leftSectionId: sLeft, rightSectionId: sRight,
      junctionBeat: 24, tapeLotNo: "T-2", inspector: "乙"
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "SEAM_ALREADY_EXISTS");

    // 第二个接口 [40|41]：sRight 尾拍 40，sFar 首拍 41，接缝不跨已校对区间
    const second = (await api(h.baseUrl, "POST", `/tunes/${tuneId}/splices`, {
      leftSectionId: sRight, rightSectionId: sFar,
      junctionBeat: 40, tapeLotNo: "T-3", inspector: "甲"
    })).json.data;

    // 第一个接口先放行，第二个未放行，闸门仍阻断
    const first = (await api(h.baseUrl, "GET", `/tunes/${tuneId}/splices`))
      .json.data.find((s) => s.junctionBeat === 24);
    await api(h.baseUrl, "POST", `/splices/${first.id}/pulls`, { tensionN: 18 });
    let gate = (await api(h.baseUrl, "GET", `/tunes/${tuneId}/splice-gate`)).json.data;
    assert.equal(gate.released, false);
    assert.equal(gate.spliceId, second.id);

    await api(h.baseUrl, "POST", `/splices/${second.id}/pulls`, { tensionN: 18 });
    gate = (await api(h.baseUrl, "GET", `/tunes/${tuneId}/splice-gate`)).json.data;
    assert.equal(gate.released, true);
  } finally {
    await h.close();
  }
});

test("纸型张力上限可维护；未知纸型在配置上限前不能登记", async () => {
  const h = await newHarness();
  try {
    let r = await api(h.baseUrl, "GET", "/paper-types");
    assert.ok(r.json.data.find((p) => p.paperType === "半透明纸带" && p.tensionLimitN === 24));

    r = await api(h.baseUrl, "PATCH", "/paper-types/加厚牛皮纸带", { tensionLimitN: 40 });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.tensionLimitN, 40);

    // 新建未配置上限的纸型曲目，登记接片时给出明确错误
    const tune = (await api(h.baseUrl, "POST", "/tunes", {
      title: "神秘纸带曲",
      stripSpec: { paperType: "未知进口纸带" }
    })).json.data;
    const a = (await api(h.baseUrl, "POST", `/tunes/${tune.id}/sections`, {
      startBeat: 1, endBeat: 8, laneRange: "1-5", checked: false
    })).json.data.id;
    const b = (await api(h.baseUrl, "POST", `/tunes/${tune.id}/sections`, {
      startBeat: 9, endBeat: 16, laneRange: "1-5", checked: false
    })).json.data.id;
    r = await api(h.baseUrl, "POST", `/tunes/${tune.id}/splices`, {
      leftSectionId: a, rightSectionId: b,
      junctionBeat: 8, tapeLotNo: "X", inspector: "丁"
    });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "TENSION_LIMIT_UNKNOWN");

    // 配置上限后可登记
    await api(h.baseUrl, "PATCH", "/paper-types/未知进口纸带", { tensionLimitN: 30 });
    r = await api(h.baseUrl, "POST", `/tunes/${tune.id}/splices`, {
      leftSectionId: a, rightSectionId: b,
      junctionBeat: 8, tapeLotNo: "X", inspector: "丁"
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.data.tensionLimitN, 30);
  } finally {
    await h.close();
  }
});

test("重启后接片资料、状态与旧失败原因仍可查询", async () => {
  const h = await newHarness();
  try {
    const { tuneId, sLeft, sRight } = await makeTuneWithSections(h.baseUrl);
    const reg = (await api(h.baseUrl, "POST", `/tunes/${tuneId}/splices`, {
      leftSectionId: sLeft, rightSectionId: sRight,
      junctionBeat: 24, tapeLotNo: "TAPE-PERSIST", inspector: "持久化"
    })).json.data;
    await api(h.baseUrl, "POST", `/splices/${reg.id}/pulls`, {
      tensionN: 30, toreHole: false
    }); // 超限进返工

    await h.restart();

    const list = (await api(h.baseUrl, "GET", `/tunes/${tuneId}/splices`)).json.data;
    assert.equal(list.length, 1);
    assert.equal(list[0].status, "rework_pending");
    assert.equal(list[0].tapeLotNo, "TAPE-PERSIST");
    const detail = (await api(h.baseUrl, "GET", `/splices/${reg.id}`)).json.data;
    assert.equal(detail.history.find((ev) => ev.type === "pull").reason, "TENSION_OVER_LIMIT");

    // 旧存档迁移：重启后纸型表与 splices 集合齐备
    const paperTypes = (await api(h.baseUrl, "GET", "/paper-types")).json.data;
    assert.ok(paperTypes.find((p) => p.paperType === "半透明纸带"));
  } finally {
    await h.close();
  }
});
