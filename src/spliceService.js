"use strict";

// 接片用例服务：把接片规则（spliceRules）与存档（archive）串起来，
// 不处理 HTTP。状态流转：
//   pending_pull --试拉--> released（通过）
//                        -> pull_failed（单次破孔，可再试）
//                        -> rework_pending（张力超限 / 连续两次破孔）
//   rework_pending --返工登记--> pending_pull（失败原因保留）
//   pull_failed   --返工登记--> pending_pull（重置连续破孔，原因保留）

const rules = require("./spliceRules");
const { STATUS, REASON } = rules;

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function error(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code }, extra);
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) throw error(404, "TUNE_NOT_FOUND", "曲目不存在");
  return tune;
}

function findPaperLimit(db, paperType) {
  return db.paperTypes.find((item) => item.paperType === paperType) || null;
}

function findSplices(db, tuneId) {
  return db.splices.filter((item) => item.tuneId === tuneId);
}

// 曲目级放行视图：无资料即未放行（旧曲目同样适用）
function releaseGate(db, tuneId) {
  findTune(db, tuneId);
  return rules.buildReleaseGate(tuneId, findSplices(db, tuneId));
}

function listSplices(db, tuneId) {
  findTune(db, tuneId);
  return findSplices(db, tuneId);
}

/**
 * 登记接片：记左右段编号、接口拍号、胶带批号和检验人。
 * 校验两段首尾相接、接缝不跨已校对区间，通过后状态为待试拉。
 */
function registerSplice(db, body) {
  const required = ["tuneId", "leftSectionId", "rightSectionId", "junctionBeat", "tapeLotNo", "inspector"];
  const missing = required.filter(
    (field) => body[field] === undefined || body[field] === ""
  );
  if (missing.length) {
    throw error(400, "MISSING_FIELDS", `缺少字段：${missing.join(", ")}`);
  }

  const tuneId = String(body.tuneId);
  const tune = findTune(db, tuneId);

  const junctionBeat = Number(body.junctionBeat);
  if (!Number.isInteger(junctionBeat) || junctionBeat < 1) {
    throw error(400, "BAD_JUNCTION_BEAT", "接口拍号必须是正整数");
  }

  const leftSection = db.sections.find((item) => item.id === String(body.leftSectionId));
  const rightSection = db.sections.find((item) => item.id === String(body.rightSectionId));
  const checkedIntervals = db.sections
    .filter((item) => item.tuneId === tuneId && item.checked);
  const existingJunctionBeats = findSplices(db, tuneId).map((item) => item.junctionBeat);

  const verdict = rules.validateSpliceRegistration({
    tuneId,
    junctionBeat,
    leftSection,
    rightSection,
    checkedIntervals,
    existingJunctionBeats
  });
  if (!verdict.ok) throw error(400, verdict.code, verdict.message);

  const now = new Date().toISOString();
  const splice = {
    id: makeId("splice"),
    tuneId,
    leftSectionId: leftSection.id,
    rightSectionId: rightSection.id,
    junctionBeat,
    tapeLotNo: String(body.tapeLotNo),
    inspector: String(body.inspector),
    status: STATUS.PENDING_PULL,
    consecutiveTorn: 0,
    tensionLimitN: tensionLimitFor(db, tune.stripSpec.paperType),
    createdAt: now,
    updatedAt: now,
    reworkCount: 0,
    releasedAt: null,
    history: [
      {
        type: "register",
        at: now,
        inspector: String(body.inspector),
        tapeLotNo: String(body.tapeLotNo),
        note: body.note ? String(body.note) : ""
      }
    ]
  };
  db.splices.push(splice);
  return splice;
}

function tensionLimitFor(db, paperType) {
  const limit = findPaperLimit(db, paperType);
  if (!limit || limit.tensionLimitN === null || limit.tensionLimitN === undefined) {
    throw error(
      409,
      "TENSION_LIMIT_UNKNOWN",
      `纸型「${paperType}」未配置试拉张力上限，无法判定，请先维护纸型表`
    );
  }
  return Number(limit.tensionLimitN);
}

/**
 * 记录一次试拉。张力超限或连续两次破孔 -> 待返工（原段与打孔进度不动）；
 * 单次破孔 -> 试拉失败，允许再试；通过 -> 放行。
 */
function recordPull(db, spliceId, body) {
  const splice = db.splices.find((item) => item.id === spliceId);
  if (!splice) throw error(404, "SPLICE_NOT_FOUND", "接片记录不存在");

  if (body.tensionN === undefined || body.tensionN === "") {
    throw error(400, "MISSING_FIELDS", "缺少字段：tensionN");
  }
  const tensionN = Number(body.tensionN);
  if (!Number.isFinite(tensionN) || tensionN < 0) {
    throw error(400, "BAD_TENSION", "试拉张力必须是非负数字（牛）");
  }
  const toreHole = Boolean(body.toreHole);

  if (splice.status === STATUS.RELEASED) {
    throw error(409, "SPLICE_ALREADY_RELEASED", "接口已放行，无需再试拉");
  }
  if (splice.status === STATUS.REWORK_PENDING) {
    throw error(
      409,
      "REWORK_REQUIRED",
      "接口留在待返工，须先登记返工，返工后试拉通过才能继续打孔"
    );
  }

  const now = new Date().toISOString();
  const result = rules.evaluatePull(splice, {
    tensionN,
    toreHole,
    tensionLimitN: splice.tensionLimitN
  });

  splice.status = result.status;
  splice.consecutiveTorn = result.consecutiveTorn;
  splice.updatedAt = now;
  if (result.status === STATUS.RELEASED) {
    splice.releasedAt = now;
  }

  splice.history.push({
    type: "pull",
    at: now,
    inspector: body.inspector ? String(body.inspector) : splice.inspector,
    tensionN,
    tensionLimitN: splice.tensionLimitN,
    tensionOverLimit: result.tensionOverLimit,
    toreHole: result.toreHole,
    consecutiveTorn: result.consecutiveTorn,
    passed: result.passed,
    // 失败原因逐次记入，后续返工不清空旧记录
    reason: result.reason,
    reasonMessage: result.reasonMessage,
    note: body.note ? String(body.note) : ""
  });

  return {
    splice,
    result: {
      passed: result.passed,
      status: result.status,
      reason: result.reason,
      reasonMessage: result.reasonMessage
    }
  };
}

/**
 * 返工登记：只登记返工动作，不修改原段与打孔进度。
 * 旧失败原因全部保留（history 不删除），重置连续破孔计数，状态回到待试拉。
 */
function registerRework(db, spliceId, body = {}) {
  const splice = db.splices.find((item) => item.id === spliceId);
  if (!splice) throw error(404, "SPLICE_NOT_FOUND", "接片记录不存在");

  if (splice.status === STATUS.RELEASED) {
    throw error(409, "SPLICE_ALREADY_RELEASED", "接口已放行，无需返工");
  }
  if (splice.status === STATUS.PENDING_PULL) {
    throw error(409, "SPLICE_NOT_FAILED", "接口尚未试拉或失败，无需返工");
  }

  const now = new Date().toISOString();
  splice.reworkCount += 1;
  splice.consecutiveTorn = 0;
  splice.status = STATUS.PENDING_PULL;
  splice.updatedAt = now;

  // 返工可更换胶带批号/检验人；缺省保留原值
  if (body.tapeLotNo) splice.tapeLotNo = String(body.tapeLotNo);
  if (body.inspector) splice.inspector = String(body.inspector);

  splice.history.push({
    type: "rework",
    at: now,
    reworkCount: splice.reworkCount,
    inspector: body.inspector ? String(body.inspector) : splice.inspector,
    tapeLotNo: body.tapeLotNo ? String(body.tapeLotNo) : splice.tapeLotNo,
    // 旧失败原因保留在 history 中，本次只追加返工记录
    retainedFailureReasons: splice.history
      .filter((item) => item.type === "pull" && !item.passed && item.reason)
      .map((item) => item.reason),
    note: body.note ? String(body.note) : ""
  });

  return splice;
}

function getSplice(db, spliceId) {
  const splice = db.splices.find((item) => item.id === spliceId);
  if (!splice) throw error(404, "SPLICE_NOT_FOUND", "接片记录不存在");
  return splice;
}

module.exports = {
  listSplices,
  registerSplice,
  recordPull,
  registerRework,
  releaseGate,
  getSplice
};
