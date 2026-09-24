"use strict";

// 接片存档层：只管接片记录的读写，不知道规则细节，也不处理 HTTP。
// 与曲目主存档 data/db.json 分离：接片返工/试拉绝不改动原段和打孔进度。
// 写入采用临时文件 + rename 的原子替换，避免半截 JSON。

const path = require("path");
const { readFile, writeFile, rename, mkdir } = require("fs/promises");

const DEFAULT_ARCHIVE_FILE = path.join(__dirname, "..", "data", "splices.json");

function createSpliceStore(options = {}) {
  const archiveFile = options.archiveFile || DEFAULT_ARCHIVE_FILE;
  const idPrefix = options.idPrefix || "splice";
  const idGenerator = options.idGenerator || (() =>
    `${idPrefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const clock = options.clock || (() => new Date().toISOString());

  async function loadRaw() {
    try {
      const parsed = JSON.parse(await readFile(archiveFile, "utf8"));
      if (!parsed || !Array.isArray(parsed.splices)) {
        return { version: 1, splices: [] };
      }
      return { version: parsed.version || 1, splices: parsed.splices };
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, splices: [] };
      throw error;
    }
  }

  async function saveRaw(data) {
    await mkdir(path.dirname(archiveFile), { recursive: true });
    const tmpFile = path.join(path.dirname(archiveFile), `.${path.basename(archiveFile)}.${process.pid}.tmp`);
    await writeFile(tmpFile, JSON.stringify(data, null, 2), "utf8");
    await rename(tmpFile, archiveFile);
  }

  async function listSplices(filter = {}) {
    const data = await loadRaw();
    return data.splices.filter(
      (item) =>
        (!filter.tuneId || item.tuneId === filter.tuneId) &&
        (!filter.status || item.status === filter.status) &&
        (filter.seamBeat === undefined || item.seamBeat === filter.seamBeat)
    );
  }

  async function getById(spliceId) {
    const data = await loadRaw();
    return data.splices.find((item) => item.id === spliceId) || null;
  }

  async function findSeam(tuneId, seamBeat) {
    const data = await loadRaw();
    return (
      data.splices.find((item) => item.tuneId === tuneId && item.seamBeat === seamBeat) || null
    );
  }

  async function insertSplice(record) {
    const data = await loadRaw();
    const splice = {
      id: idGenerator(),
      status: record.status,
      tuneId: record.tuneId,
      leftSectionId: record.leftSectionId,
      rightSectionId: record.rightSectionId,
      seamBeat: record.seamBeat,
      tapeBatch: record.tapeBatch,
      inspector: record.inspector,
      paperType: record.paperType,
      tensionLimitN: record.tensionLimitN,
      consecutiveBroken: 0,
      failureReasons: [],
      events: [
        {
          type: "register",
          inspector: record.inspector,
          tapeBatch: record.tapeBatch,
          at: clock()
        }
      ],
      createdAt: clock()
    };
    data.splices.push(splice);
    await saveRaw(data);
    return splice;
  }

  // 以记录 id 为锚点应用变更，返回更新后的记录；找不到时抛 404 语义错误。
  async function updateSplice(spliceId, mutator) {
    const data = await loadRaw();
    const index = data.splices.findIndex((item) => item.id === spliceId);
    if (index === -1) {
      const error = new Error("接片记录不存在");
      error.status = 404;
      throw error;
    }
    const updated = mutator(data.splices[index], clock) || data.splices[index];
    data.splices[index] = updated;
    await saveRaw(data);
    return updated;
  }

  return {
    archiveFile,
    loadRaw,
    listSplices,
    getById,
    findSeam,
    insertSplice,
    updateSplice
  };
}

module.exports = { createSpliceStore, DEFAULT_ARCHIVE_FILE };
