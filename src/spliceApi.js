"use strict";

// 接片接口入口：只做 HTTP <-> 用例服务的转换，不与曲目/区间/问题接口混写。
// 所有命中分支返回 true（含已发送响应的情形），未命中返回 false。
// 路由：
//   GET    /tunes/:id/splices             查某曲目的接片资料（重启后仍可查）
//   POST   /tunes/:id/splices             登记接片（左右段、接口拍号、胶带批号、检验人）
//   GET    /tunes/:id/splice-gate         曲目放行闸门（无资料=未放行）
//   GET    /splices/:spliceId             单条接片（含 history，旧失败原因保留可查）
//   POST   /splices/:spliceId/pulls       记录一次试拉
//   POST   /splices/:spliceId/reworks     登记返工
//   GET    /paper-types                   纸型张力上限表
//   PATCH  /paper-types/:paperType        维护某纸型张力上限

const spliceService = require("./spliceService");

async function route(req, res, ctx) {
  const { pathname, send, parseBody, db, saveDb } = ctx;

  const tuneSplicesMatch = pathname.match(/^\/tunes\/([^/]+)\/splices$/);
  if (tuneSplicesMatch && req.method === "GET") {
    send(res, 200, { data: spliceService.listSplices(db, tuneSplicesMatch[1]) });
    return true;
  }
  if (tuneSplicesMatch && req.method === "POST") {
    const body = await parseBody(req);
    body.tuneId = tuneSplicesMatch[1];
    const data = spliceService.registerSplice(db, body);
    await saveDb(db);
    send(res, 201, { data });
    return true;
  }

  const gateMatch = pathname.match(/^\/tunes\/([^/]+)\/splice-gate$/);
  if (gateMatch && req.method === "GET") {
    send(res, 200, { data: spliceService.releaseGate(db, gateMatch[1]) });
    return true;
  }

  const spliceMatch = pathname.match(/^\/splices\/([^/]+)$/);
  if (spliceMatch && req.method === "GET") {
    send(res, 200, { data: spliceService.getSplice(db, spliceMatch[1]) });
    return true;
  }

  const pullsMatch = pathname.match(/^\/splices\/([^/]+)\/pulls$/);
  if (pullsMatch && req.method === "POST") {
    const body = await parseBody(req);
    const { splice, result } = spliceService.recordPull(db, pullsMatch[1], body);
    await saveDb(db);
    send(res, 201, { data: splice, result });
    return true;
  }

  const reworksMatch = pathname.match(/^\/splices\/([^/]+)\/reworks$/);
  if (reworksMatch && req.method === "POST") {
    const body = await parseBody(req);
    const data = spliceService.registerRework(db, reworksMatch[1], body);
    await saveDb(db);
    send(res, 201, { data });
    return true;
  }

  if (req.method === "GET" && pathname === "/paper-types") {
    send(res, 200, { data: db.paperTypes });
    return true;
  }

  const paperTypeMatch = pathname.match(/^\/paper-types\/([^/]+)$/);
  if (paperTypeMatch && req.method === "PATCH") {
    const paperType = decodeURIComponent(paperTypeMatch[1]);
    const body = await parseBody(req);
    if (body.tensionLimitN === undefined || body.tensionLimitN === "") {
      send(res, 400, { error: "缺少字段：tensionLimitN" });
      return true;
    }
    const tensionLimitN = Number(body.tensionLimitN);
    if (!Number.isFinite(tensionLimitN) || tensionLimitN <= 0) {
      send(res, 400, { error: "tensionLimitN 必须是正数（牛）" });
      return true;
    }
    let entry = db.paperTypes.find((item) => item.paperType === paperType);
    if (!entry) {
      entry = { paperType, tensionLimitN };
      db.paperTypes.push(entry);
    } else {
      entry.tensionLimitN = tensionLimitN;
    }
    await saveDb(db);
    send(res, 200, { data: entry });
    return true;
  }

  return false;
}

module.exports = { route };
