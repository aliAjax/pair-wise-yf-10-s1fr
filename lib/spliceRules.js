"use strict";

// 接片规则层：纯函数，不读写存档、不碰 HTTP。
// 规则含义（接片放行）：
//   1. 两段拍号必须首尾相接（左段末拍 N，右段首拍 N+1，接口拍号 = N）。
//   2. 接缝不能跨过任何已校对区间（含其整段覆盖接口两侧的情况）。
//   3. 试拉张力超过该纸型上限，或接口连续两次破孔，即判待返工。
//   4. 返工只改变接片记录状态；原段信息与打孔进度不由本层修改。
//   5. 旧曲目无接片资料时按未放行处理（由闸门函数兜底）。

// 纸型试拉张力上限，单位 N（牛顿）。未知纸型无上限可依，按不放行处理。
const PAPER_TENSION_LIMITS = {
  半透明纸带: 18,
  牛皮纸带: 26,
  蜡光纸带: 22
};

// 接片状态
const SpliceStatus = Object.freeze({
  TESTING: "待试拉",
  REWORK: "待返工",
  RELEASED: "已放行"
});

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function tensionLimitFor(paperType) {
  return Object.prototype.hasOwnProperty.call(PAPER_TENSION_LIMITS, paperType)
    ? PAPER_TENSION_LIMITS[paperType]
    : null;
}

// 校验接片登记内容。返回 { ok, errors }。
// context: { leftSection, rightSection, paperType, allSections? }
// 区间均来自既有曲目资料，登记只读取、不修改它们。
function validateRegistration(input, context) {
  const errors = [];
  const seamBeat = Number(input.seamBeat);

  const required = ["tuneId", "leftSectionId", "rightSectionId", "tapeBatch", "inspector", "seamBeat"];
  for (const field of required) {
    if (input[field] === undefined || input[field] === null || input[field] === "") {
      errors.push(`缺少字段：${field}`);
    }
  }

  if (!isPositiveInt(seamBeat)) errors.push("接口拍号必须为正整数");
  if (input.leftSectionId && input.leftSectionId === input.rightSectionId) {
    errors.push("左右段不能是同一区间");
  }

  const { leftSection, rightSection, paperType, allSections } = context || {};
  if (input.leftSectionId && !leftSection) errors.push("左段区间不存在");
  if (input.rightSectionId && !rightSection) errors.push("右段区间不存在");

  if (leftSection && rightSection && input.tuneId) {
    if (leftSection.tuneId !== input.tuneId || rightSection.tuneId !== input.tuneId) {
      errors.push("左右段必须同属该曲目");
    }
  }

  if (isPositiveInt(seamBeat) && leftSection && rightSection) {
    // 首尾相接：左段以接口拍结束，右段从下一拍开始。
    if (leftSection.endBeat !== seamBeat) {
      errors.push(`拍号未首尾相接：左段末拍为 ${leftSection.endBeat}，接口拍号为 ${seamBeat}`);
    }
    if (rightSection.startBeat !== seamBeat + 1) {
      errors.push(`拍号未首尾相接：右段首拍应为 ${seamBeat + 1}，实际为 ${rightSection.startBeat}`);
    }
    // 接缝不能跨过任何已校对区间。
    // 接缝位于 N 与 N+1 之间；某区间同时覆盖接缝两侧（start<=N 且 end>=N+1）才算跨过。
    // 区间恰在接缝边缘结束/开始（只覆盖一侧）不算，因此已校对的左右两段在分界处仍可相接。
    // 扫描该曲目全部区间，而不限于登记的左右两段。
    const candidates = allSections || [leftSection, rightSection];
    const straddled = candidates.find((section) => {
      if (!section.checked) return false;
      if (input.tuneId && section.tuneId && section.tuneId !== input.tuneId) return false;
      return section.startBeat <= seamBeat && section.endBeat >= seamBeat + 1;
    });
    if (straddled) {
      errors.push(`接缝跨过已校对区间：${straddled.id}（${straddled.startBeat}-${straddled.endBeat}拍）`);
    }
  }

  if (paperType !== undefined && tensionLimitFor(paperType) === null) {
    errors.push(`未知纸型「${paperType}」，没有试拉张力上限可依`);
  }

  return { ok: errors.length === 0, errors };
}

// 依据一次试拉结果，给出接片记录的下一状态。纯函数，不改入参。
// splice: 当前接片记录；pull: { tensionN, holesBroken, note?, at }
// 返回 { ok, status, consecutiveBroken, failures:[], events:[] }
function evaluatePull(splice, pull, now) {
  const failures = [];
  const events = [];

  if (splice.status === SpliceStatus.RELEASED) {
    return { ok: false, error: "已放行的接片不能再试拉", code: 409 };
  }
  if (splice.status === SpliceStatus.REWORK) {
    return { ok: false, error: "接片待返工，必须先登记返工并处理后才能重新试拉", code: 409 };
  }

  const tension = Number(pull.tensionN);
  if (!Number.isFinite(tension) || tension <= 0) {
    return { ok: false, error: "试拉张力必须为正数", code: 400 };
  }

  const limit = tensionLimitFor(splice.paperType);
  if (limit === null) {
    return { ok: false, error: `未知纸型「${splice.paperType}」，拒绝试拉判定`, code: 400 };
  }

  const overLimit = tension > limit;
  const broken = Boolean(pull.holesBroken);
  // 上一轮待返工状态进入新试拉前应先经返工；此处连续破孔计数只在待试拉内累计。
  const consecutiveBroken = broken ? (splice.consecutiveBroken || 0) + 1 : 0;

  if (overLimit) {
    failures.push({
      reason: "张力超限",
      detail: `试拉 ${tension}N 超过纸型「${splice.paperType}」上限 ${limit}N`,
      tensionN: tension
    });
  }
  if (consecutiveBroken >= 2) {
    failures.push({
      reason: "连续两次破孔",
      detail: `接口在第 ${consecutiveBroken - 1}、${consecutiveBroken} 次试拉中连续破孔`
    });
  }

  events.push({
    type: "pull",
    tensionN: tension,
    holesBroken: broken,
    overLimit,
    at: pull.at || now,
    note: pull.note || ""
  });

  if (failures.length) {
    events.push({ type: "to_rework", reasons: failures.map((item) => item.reason), at: pull.at || now });
    return {
      ok: true,
      status: SpliceStatus.REWORK,
      consecutiveBroken: 0,
      failures,
      events
    };
  }

  // 单次破孔但张力合格：不算通过，继续待试拉，连续计数累计。
  if (broken) {
    events.push({ type: "pull_broken_once", at: pull.at || now });
    return {
      ok: true,
      status: SpliceStatus.TESTING,
      consecutiveBroken,
      failures: [{ reason: "单次破孔", detail: "接口破孔 1 次，未达连续两次，需重新试拉", tensionN: tension }],
      events
    };
  }

  // 张力合格且未破孔：返工后试拉通过同样走这里，状态转已放行。
  events.push({ type: "release", at: pull.at || now });
  return {
    ok: true,
    status: SpliceStatus.RELEASED,
    consecutiveBroken: 0,
    failures: [],
    events
  };
}

// 返工登记：状态转待试拉，旧失败原因保留（不在本函数清除）。
function registerRework(splice, rework, now) {
  if (splice.status !== SpliceStatus.REWORK) {
    return { ok: false, error: "只有待返工的接片可以登记返工", code: 409 };
  }
  const at = rework.at || now;
  const events = [
    {
      type: "rework",
      inspector: rework.inspector || splice.inspector,
      tapeBatch: rework.tapeBatch || splice.tapeBatch,
      note: rework.note || "",
      at
    },
    { type: "to_testing", at }
  ];
  return {
    ok: true,
    status: SpliceStatus.TESTING,
    consecutiveBroken: 0,
    inspector: rework.inspector || splice.inspector,
    tapeBatch: rework.tapeBatch || splice.tapeBatch,
    events
  };
}

// 单个接缝是否可放行。
function seamReleased(splices, tuneId, seamBeat) {
  const splice = (splices || []).find(
    (item) => item.tuneId === tuneId && item.seamBeat === seamBeat
  );
  if (!splice) return { released: false, status: "未放行", reason: "无接片资料，按未放行处理", splice: null };
  const released = splice.status === SpliceStatus.RELEASED;
  return {
    released,
    status: splice.status,
    reason: released ? "已放行" : `接片仍处于「${splice.status}」`,
    splice
  };
}

// 继续打孔闸门：nextBeat 是准备打孔的下一拍，接缝位于 nextBeat-1。
// 旧曲目无接片资料 -> 不放行。
function canContinuePunching(splices, tuneId, nextBeat) {
  if (!isPositiveInt(nextBeat)) return { allowed: false, reason: "下一拍号必须为正整数" };
  const gate = seamReleased(splices, tuneId, nextBeat - 1);
  return {
    allowed: gate.released,
    seamBeat: nextBeat - 1,
    status: gate.status,
    reason: gate.released ? `接缝 ${nextBeat - 1} 拍已放行，可继续打孔` : gate.reason
  };
}

module.exports = {
  PAPER_TENSION_LIMITS,
  SpliceStatus,
  tensionLimitFor,
  validateRegistration,
  evaluatePull,
  registerRework,
  seamReleased,
  canContinuePunching
};
