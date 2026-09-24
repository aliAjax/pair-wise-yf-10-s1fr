"use strict";

// 接片接口入口层：只做 HTTP 编解码与编排。
// 规则判定全部委托 spliceRules，存档读写委托 spliceStore。

const rules = require("./spliceRules");

const spliceRoutes = [
  "POST /tunes/:id/splices",
  "GET /tunes/:id/splices",
  "GET /tunes/:id/splice-gate?seamBeat=",
  "GET /tunes/:id/punch-gate?nextBeat=",
  "POST /splices/:id/pulls",
  "POST /splices/:id/reworks",
  "GET /splices/:id"
];

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw fail(400, "请求体必须是合法JSON");
  }
}

// context: { store, readDb } —— readDb 读取曲目主库（只读，不回写）。
function createSpliceRouter(context) {
  const { store, readDb } = context;

  async function findTuneSections(tuneId) {
    const db = await readDb();
    const tune = db.tunes.find((item) => item.id === tuneId);
    if (!tune) throw fail(404, "曲目不存在");
    return {
      tune,
      sections: db.sections.filter((item) => item.tuneId === tuneId)
    };
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname, searchParams } = url;

    const tuneSplicesMatch = pathname.match(/^\/tunes\/([^/]+)\/splices$/);
    if (tuneSplicesMatch && req.method === "POST") {
      const tuneId = tuneSplicesMatch[1];
      const { tune, sections } = await findTuneSections(tuneId);
      const body = await readBody(req);

      const input = {
        tuneId,
        leftSectionId: body.leftSectionId,
        rightSectionId: body.rightSectionId,
        seamBeat: Number(body.seamBeat),
        tapeBatch: body.tapeBatch,
        inspector: body.inspector
      };
      const check = rules.validateRegistration(
        input,
        {
          leftSection: sections.find((item) => item.id === input.leftSectionId),
          rightSection: sections.find((item) => item.id === input.rightSectionId),
          allSections: sections,
          paperType: tune.stripSpec && tune.stripSpec.paperType
        }
      );
      if (!check.ok) throw fail(400, check.errors.join("；"));

      const existing = await store.findSeam(tuneId, input.seamBeat);
      if (existing) {
        throw fail(409, `该接缝已有接片记录 ${existing.id}（状态：${existing.status}），不能重复登记`);
      }

      const paperType = tune.stripSpec.paperType;
      const splice = await store.insertSplice({
        ...input,
        status: rules.SpliceStatus.TESTING,
        paperType,
        tensionLimitN: rules.tensionLimitFor(paperType)
      });
      return json(res, 201, { data: splice });
    }

    if (tuneSplicesMatch && req.method === "GET") {
      const tuneId = tuneSplicesMatch[1];
      await findTuneSections(tuneId);
      const status = searchParams.get("status");
      const data = await store.listSplices(status ? { tuneId, status } : { tuneId });
      return json(res, 200, { data });
    }

    const spliceGateMatch = pathname.match(/^\/tunes\/([^/]+)\/splice-gate$/);
    if (spliceGateMatch && req.method === "GET") {
      const tuneId = spliceGateMatch[1];
      await findTuneSections(tuneId);
      const seamBeat = Number(searchParams.get("seamBeat"));
      if (!Number.isInteger(seamBeat) || seamBeat <= 0) throw fail(400, "seamBeat 必须为正整数");
      const splices = await store.listSplices({ tuneId });
      return json(res, 200, { data: rules.seamReleased(splices, tuneId, seamBeat) });
    }

    const punchGateMatch = pathname.match(/^\/tunes\/([^/]+)\/punch-gate$/);
    if (punchGateMatch && req.method === "GET") {
      const tuneId = punchGateMatch[1];
      await findTuneSections(tuneId);
      const nextBeat = Number(searchParams.get("nextBeat"));
      if (!Number.isInteger(nextBeat) || nextBeat <= 0) throw fail(400, "nextBeat 必须为正整数");
      const splices = await store.listSplices({ tuneId });
      return json(res, 200, { data: rules.canContinuePunching(splices, tuneId, nextBeat) });
    }

    const spliceItemMatch = pathname.match(/^\/splices\/([^/]+)$/);
    if (spliceItemMatch && req.method === "GET") {
      const splice = await store.getById(spliceItemMatch[1]);
      if (!splice) throw fail(404, "接片记录不存在");
      return json(res, 200, { data: splice });
    }

    const pullMatch = pathname.match(/^\/splices\/([^/]+)\/pulls$/);
    if (pullMatch && req.method === "POST") {
      const body = await readBody(req);
      const updated = await store.updateSplice(pullMatch[1], (splice, now) => {
        const verdict = rules.evaluatePull(
          splice,
          {
            tensionN: body.tensionN,
            holesBroken: Boolean(body.holesBroken),
            note: body.note,
            at: body.at
          },
          now
        );
        if (!verdict.ok) throw fail(verdict.code, verdict.error);

        splice.status = verdict.status;
        splice.consecutiveBroken = verdict.consecutiveBroken;
        // 旧失败原因永久保留；新失败原因追加（去重理由文案）。
        for (const failure of verdict.failures) {
          splice.failureReasons.push({ ...failure, at: now });
        }
        for (const event of verdict.events) splice.events.push(event);
        splice.updatedAt = now;
        return splice;
      });
      return json(res, 200, { data: updated });
    }

    const reworkMatch = pathname.match(/^\/splices\/([^/]+)\/reworks$/);
    if (reworkMatch && req.method === "POST") {
      const body = await readBody(req);
      const updated = await store.updateSplice(reworkMatch[1], (splice, now) => {
        const verdict = rules.registerRework(
          splice,
          { inspector: body.inspector, tapeBatch: body.tapeBatch, note: body.note, at: body.at },
          now
        );
        if (!verdict.ok) throw fail(verdict.code, verdict.error);
        splice.status = verdict.status;
        splice.consecutiveBroken = verdict.consecutiveBroken;
        splice.inspector = verdict.inspector;
        splice.tapeBatch = verdict.tapeBatch;
        for (const event of verdict.events) splice.events.push(event);
        // 不清除 failureReasons：旧失败原因保留。
        splice.updatedAt = now;
        return splice;
      });
      return json(res, 200, { data: updated });
    }

    return null; // 非接片路由，交回主服务。
  }

  return { handle, routes: spliceRoutes };
}

module.exports = { createSpliceRouter, spliceRoutes };
