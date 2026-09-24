"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");

const { createSpliceStore } = require("../lib/spliceStore");

async function tempArchive() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splice-store-"));
  return path.join(dir, "splices.json");
}

function sampleRecord(overrides = {}) {
  return {
    status: "待试拉",
    tuneId: "tune_demo",
    leftSectionId: "section_demo_1",
    rightSectionId: "section_demo_2",
    seamBeat: 32,
    tapeBatch: "T-1",
    inspector: "老周",
    paperType: "半透明纸带",
    tensionLimitN: 18,
    ...overrides
  };
}

test("插入后可按曲目、接缝查询", async () => {
  const store = createSpliceStore({ archiveFile: await tempArchive() });
  const splice = await store.insertSplice(sampleRecord());
  assert.equal(splice.status, "待试拉");
  assert.equal(splice.consecutiveBroken, 0);
  assert.deepEqual(splice.failureReasons, []);
  assert.equal(splice.events[0].type, "register");

  const found = await store.findSeam("tune_demo", 32);
  assert.equal(found.id, splice.id);
  assert.equal((await store.listSplices({ tuneId: "tune_demo" })).length, 1);
  assert.equal((await store.listSplices({ tuneId: "other" })).length, 0);
});

test("重启（重新实例化 store）后记录仍可查", async () => {
  const archiveFile = await tempArchive();
  const store1 = createSpliceStore({ archiveFile });
  await store1.insertSplice(sampleRecord());

  const store2 = createSpliceStore({ archiveFile });
  const found = await store2.findSeam("tune_demo", 32);
  assert.ok(found);
  assert.equal(found.tapeBatch, "T-1");
  assert.equal(found.inspector, "老周");
});

test("updateSplice 追加事件与失败原因，旧失败原因保留", async () => {
  const store = createSpliceStore({ archiveFile: await tempArchive() });
  const splice = await store.insertSplice(sampleRecord());

  const afterFail = await store.updateSplice(splice.id, (record, now) => {
    record.status = "待返工";
    record.failureReasons.push({ reason: "张力超限", at: now });
    record.events.push({ type: "to_rework", at: now });
    return record;
  });
  assert.equal(afterFail.status, "待返工");

  const afterRework = await store.updateSplice(splice.id, (record, now) => {
    record.status = "待试拉";
    record.events.push({ type: "rework", at: now });
    return record;
  });
  // 旧失败原因不清除
  assert.equal(afterRework.failureReasons.length, 1);
  assert.equal(afterRework.events.map((e) => e.type).join(","), "register,to_rework,rework");
});

test("存档文件不存在时按空存档处理（旧曲目无资料）", async () => {
  const store = createSpliceStore({ archiveFile: path.join(await fs.mkdtemp(path.join(os.tmpdir(), "empty-")), "nope.json") });
  assert.deepEqual(await store.listSplices(), []);
});
