"use strict";

// 接片放行规则：纯函数模块，不读写存档、不碰 HTTP，便于单独测试。
// 纸带断裂续接后，两段拍号必须首尾相接；接缝不得落在已校对区间；
// 试拉张力超纸型上限，或接口连续两次破孔，则留在待返工。

const STATUS = Object.freeze({
  PENDING_PULL: "pending_pull", // 已登记，待试拉
  PULL_FAILED: "pull_failed", // 试拉未过（如单次破孔），可再次试拉
  REWORK_PENDING: "rework_pending", // 留在待返工，原段与打孔进度不动
  RELEASED: "released" // 放行，可继续打孔
});

// 试拉失败原因（旧原因在返工后仍保留，只追加不清空）
const REASON = Object.freeze({
  TENSION_OVER_LIMIT: "TENSION_OVER_LIMIT", // 试拉张力超过纸型上限
  HOLE_TORN: "HOLE_TORN", // 接口破孔（第一次）
  CONSECUTIVE_TORN: "CONSECUTIVE_TORN" // 接口连续两次破孔
});

const REASON_MESSAGES = Object.freeze({
  [REASON.TENSION_OVER_LIMIT]: "试拉张力超过纸型上限",
  [REASON.HOLE_TORN]: "接口破孔",
  [REASON.CONSECUTIVE_TORN]: "接口连续两次破孔"
});

// 放行闸门的阻断码
const BLOCK = Object.freeze({
  NO_SPLICE_DATA: "NO_SPLICE_DATA", // 旧曲目无接片资料，按未放行处理
  UNFINISHED_SPLICE: "UNFINISHED_SPLICE" // 存在未放行的接口
});

// 默认纸型试拉张力上限（牛）。存档中的 paperTypes 表为准，此表仅作播种/兜底。
const DEFAULT_TENSION_LIMITS = Object.freeze([
  { paperType: "半透明纸带", tensionLimitN: 24 },
  { paperType: "加厚牛皮纸带", tensionLimitN: 38 },
  { paperType: "棉线加固纸带", tensionLimitN: 45 }
]);

function fail(code, message) {
  return { ok: false, code, message };
}

/**
 * 登记接片前的结构校验。
 * input:
 *   tuneId                 曲目 id
 *   junctionBeat           接口拍号（左段最后一拍）
 *   leftSection/rightSection  左右段（含 startBeat/endBeat/tuneId）
 *   checkedIntervals       该曲目已校对区间列表（checked=true 的段）
 *   existingJunctionBeats  该曲目已登记的接口拍号集合
 */
function validateSpliceRegistration(input) {
  const {
    tuneId,
    junctionBeat,
    leftSection,
    rightSection,
    checkedIntervals,
    existingJunctionBeats
  } = input;

  if (!leftSection || leftSection.tuneId !== tuneId) {
    return fail("LEFT_SECTION_NOT_FOUND", "左段不存在或不属于该曲目");
  }
  if (!rightSection || rightSection.tuneId !== tuneId) {
    return fail("RIGHT_SECTION_NOT_FOUND", "右段不存在或不属于该曲目");
  }
  if (leftSection.id === rightSection.id) {
    return fail("SAME_SEGMENT", "左右段不能是同一段纸带");
  }

  // 两段拍号首尾相接：接口拍号 = 左段尾拍 = 右段首拍 - 1
  const tailMeets = Number(leftSection.endBeat) === Number(junctionBeat);
  const headMeets = Number(rightSection.startBeat) === Number(junctionBeat) + 1;
  if (!tailMeets || !headMeets) {
    return fail(
      "BEATS_NOT_CONTIGUOUS",
      `两段拍号未首尾相接：接口拍号应为左段尾拍 ${leftSection.endBeat}，且等于右段首拍 ${rightSection.startBeat} 的前一拍`
    );
  }

  // 接缝不能跨过已校对区间：接口拍号不得落在任一已校对区间内（含端点，
  // 胶带会盖住接口拍，已校对的拍不允许再被动到）。
  const crossed = checkedIntervals.find(
    (section) => junctionBeat >= section.startBeat && junctionBeat <= section.endBeat
  );
  if (crossed) {
    return fail(
      "SEAM_CROSSES_CHECKED",
      `接缝跨过已校对区间 ${crossedLabel(crossed)}，不允许放行登记`
    );
  }

  if (existingJunctionBeats.includes(Number(junctionBeat))) {
    return fail("SEAM_ALREADY_EXISTS", `接口拍号 ${junctionBeat} 已登记过接片`);
  }

  return { ok: true };
}

function crossedLabel(section) {
  return `[${section.startBeat}-${section.endBeat}]`;
}

/**
 * 评估一次试拉。
 * splice 需含 consecutiveTorn；attempt 含 tensionN/toreHole/tensionLimitN。
 * 不修改入参，返回本次判定结果，由服务层落库。
 */
function evaluatePull(splice, attempt) {
  const { tensionN, toreHole, tensionLimitN } = attempt;
  const tensionOverLimit = Number(tensionN) > Number(tensionLimitN);
  const consecutiveTorn = (splice.consecutiveTorn || 0) + (toreHole ? 1 : 0);

  if (tensionOverLimit) {
    return {
      passed: false,
      status: STATUS.REWORK_PENDING,
      reason: REASON.TENSION_OVER_LIMIT,
      reasonMessage: REASON_MESSAGES[REASON.TENSION_OVER_LIMIT],
      tensionOverLimit: true,
      toreHole: Boolean(toreHole),
      consecutiveTorn
    };
  }

  if (toreHole && consecutiveTorn >= 2) {
    return {
      passed: false,
      status: STATUS.REWORK_PENDING,
      reason: REASON.CONSECUTIVE_TORN,
      reasonMessage: REASON_MESSAGES[REASON.CONSECUTIVE_TORN],
      tensionOverLimit: false,
      toreHole: true,
      consecutiveTorn
    };
  }

  if (toreHole) {
    return {
      passed: false,
      status: STATUS.PULL_FAILED,
      reason: REASON.HOLE_TORN,
      reasonMessage: REASON_MESSAGES[REASON.HOLE_TORN],
      tensionOverLimit: false,
      toreHole: true,
      consecutiveTorn
    };
  }

  return {
    passed: true,
    status: STATUS.RELEASED,
    reason: null,
    reasonMessage: null,
    tensionOverLimit: false,
    toreHole: false,
    consecutiveTorn: 0
  };
}

/**
 * 曲目放行闸门：
 *  - 无任何接片资料：按未放行处理（旧曲目同样适用）
 *  - 全部接口已放行：可继续打孔
 *  - 否则返回第一个阻断接口
 */
function buildReleaseGate(tuneId, splices) {
  if (!splices.length) {
    return {
      tuneId,
      released: false,
      code: BLOCK.NO_SPLICE_DATA,
      message: "无接片资料，按未放行处理",
      spliceId: null
    };
  }
  const blocker = splices.find((splice) => splice.status !== STATUS.RELEASED);
  if (blocker) {
    return {
      tuneId,
      released: false,
      code: BLOCK.UNFINISHED_SPLICE,
      message: `接口 ${blocker.junctionBeat} 拍状态为 ${blocker.status}，尚未放行`,
      spliceId: blocker.id,
      junctionBeat: blocker.junctionBeat,
      spliceStatus: blocker.status
    };
  }
  return { tuneId, released: true, code: null, message: "全部接口已放行", spliceId: null };
}

module.exports = {
  STATUS,
  REASON,
  REASON_MESSAGES,
  BLOCK,
  DEFAULT_TENSION_LIMITS,
  validateSpliceRegistration,
  evaluatePull,
  buildReleaseGate
};
