"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const rules = require("../lib/spliceRules");

const left = { id: "sec_l", tuneId: "t1", startBeat: 1, endBeat: 32, checked: false };
const right = { id: "sec_r", tuneId: "t1", startBeat: 33, endBeat: 64, checked: false };
const baseContext = { leftSection: left, rightSection: right, paperType: "半透明纸带" };
const baseInput = {
  tuneId: "t1",
  leftSectionId: "sec_l",
  rightSectionId: "sec_r",
  seamBeat: 32,
  tapeBatch: "T-2026-09",
  inspector: "老周"
};

test("首尾相接且未跨校对区间：登记校验通过", () => {
  const result = rules.validateRegistration(baseInput, baseContext);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("左段末拍与接口拍号不一致：拒绝", () => {
  const result = rules.validateRegistration({ ...baseInput, seamBeat: 31 }, baseContext);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("；"), /左段末拍/);
});

test("右段首拍不是 N+1：拒绝（拍号接错场景）", () => {
  const wrongRight = { ...right, startBeat: 40 };
  const result = rules.validateRegistration(baseInput, { ...baseContext, rightSection: wrongRight });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("；"), /右段首拍应为 33/);
});

test("已校对区间整段覆盖接缝：拒绝（接缝跨过已校对区间）", () => {
  const checked = { id: "sec_c", tuneId: "t1", startBeat: 30, endBeat: 35, checked: true };
  const result = rules.validateRegistration(baseInput, { leftSection: checked, rightSection: right, paperType: "半透明纸带" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("；"), /跨过已校对区间/);
});

test("接缝正好落在两个已校对区间的分界：不构成跨过，可登记", () => {
  const checkedLeft = { ...left, checked: true };
  const checkedRight = { ...right, checked: true };
  const result = rules.validateRegistration(baseInput, {
    leftSection: checkedLeft,
    rightSection: checkedRight,
    paperType: "半透明纸带"
  });
  assert.equal(result.ok, true);
});

test("第三个已校对区间横跨接缝：即使登记的左右段未校对也拒绝", () => {
  const overlapper = { id: "sec_x", tuneId: "t1", startBeat: 30, endBeat: 35, checked: true };
  const result = rules.validateRegistration(baseInput, {
    ...baseContext,
    allSections: [left, right, overlapper]
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("；"), /sec_x/);
});

test("缺少必填字段（胶带批号/检验人等）：拒绝并列出", () => {
  const result = rules.validateRegistration({ tuneId: "t1" }, baseContext);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(), /tapeBatch/);
  assert.match(result.errors.join(), /inspector/);
});

test("未知纸型：拒绝，避免无张力上限放行", () => {
  const result = rules.validateRegistration(baseInput, { ...baseContext, paperType: "绢布带" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("；"), /未知纸型/);
});

test("张力合格且无破孔：直接放行", () => {
  const splice = { status: rules.SpliceStatus.TESTING, paperType: "半透明纸带", consecutiveBroken: 0 };
  const verdict = rules.evaluatePull(splice, { tensionN: 15, holesBroken: false }, "now");
  assert.equal(verdict.ok, true);
  assert.equal(verdict.status, rules.SpliceStatus.RELEASED);
});

test("张力超过纸型上限：判待返工，并附失败原因", () => {
  const splice = { status: rules.SpliceStatus.TESTING, paperType: "半透明纸带", consecutiveBroken: 0 };
  const verdict = rules.evaluatePull(splice, { tensionN: 19, holesBroken: false }, "now");
  assert.equal(verdict.status, rules.SpliceStatus.REWORK);
  assert.equal(verdict.failures[0].reason, "张力超限");
  assert.match(verdict.failures[0].detail, /上限 18N/);
});

test("接口连续两次破孔：第二次判待返工", () => {
  const first = rules.evaluatePull(
    { status: rules.SpliceStatus.TESTING, paperType: "半透明纸带", consecutiveBroken: 0 },
    { tensionN: 15, holesBroken: true },
    "t1"
  );
  assert.equal(first.status, rules.SpliceStatus.TESTING);
  assert.equal(first.consecutiveBroken, 1);
  const second = rules.evaluatePull(
    { status: rules.SpliceStatus.TESTING, paperType: "半透明纸带", consecutiveBroken: 1 },
    { tensionN: 15, holesBroken: true },
    "t2"
  );
  assert.equal(second.status, rules.SpliceStatus.REWORK);
  assert.equal(second.failures.some((f) => f.reason === "连续两次破孔"), true);
  assert.equal(second.consecutiveBroken, 0);
});

test("中间一次无破孔：连续计数清零", () => {
  const splice = { status: rules.SpliceStatus.TESTING, paperType: "半透明纸带", consecutiveBroken: 1 };
  const verdict = rules.evaluatePull(splice, { tensionN: 15, holesBroken: false }, "now");
  assert.equal(verdict.status, rules.SpliceStatus.RELEASED);
  assert.equal(verdict.consecutiveBroken, 0);
});

test("待返工状态不能直接试拉，必须先登记返工", () => {
  const splice = { status: rules.SpliceStatus.REWORK, paperType: "半透明纸带", consecutiveBroken: 0 };
  const blocked = rules.evaluatePull(splice, { tensionN: 15, holesBroken: false }, "now");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 409);
  const rework = rules.registerRework(splice, { inspector: "老周" }, "now");
  assert.equal(rework.ok, true);
  assert.equal(rework.status, rules.SpliceStatus.TESTING);
  const pull = rules.evaluatePull({ ...splice, status: rework.status }, { tensionN: 15, holesBroken: false }, "later");
  assert.equal(pull.status, rules.SpliceStatus.RELEASED);
});

test("非待返工状态登记返工：拒绝", () => {
  const splice = { status: rules.SpliceStatus.TESTING, paperType: "半透明纸带" };
  const rework = rules.registerRework(splice, {}, "now");
  assert.equal(rework.ok, false);
  assert.equal(rework.code, 409);
});

test("已放行记录再试拉：拒绝", () => {
  const splice = { status: rules.SpliceStatus.RELEASED, paperType: "半透明纸带" };
  const verdict = rules.evaluatePull(splice, { tensionN: 15 }, "now");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 409);
});

test("闸门：无接片资料的旧曲目按未放行处理", () => {
  assert.equal(rules.seamReleased([], "old_tune", 32).released, false);
  assert.equal(rules.seamReleased([], "old_tune", 32).status, "未放行");
  const gate = rules.canContinuePunching([], "old_tune", 33);
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /无接片资料/);
});

test("闸门：待返工/待试拉都不能继续打孔，已放行才可以", () => {
  const make = (status) => [{ tuneId: "t1", seamBeat: 32, status }];
  assert.equal(rules.canContinuePunching(make(rules.SpliceStatus.TESTING), "t1", 33).allowed, false);
  assert.equal(rules.canContinuePunching(make(rules.SpliceStatus.REWORK), "t1", 33).allowed, false);
  assert.equal(rules.canContinuePunching(make(rules.SpliceStatus.RELEASED), "t1", 33).allowed, true);
});
