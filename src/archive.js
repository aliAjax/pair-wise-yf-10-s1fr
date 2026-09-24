"use strict";

// 存档读写：只负责 data/db.json 的读取、迁移与原子落盘，
// 不包含任何接片业务判定（规则见 spliceRules.js）。

const { readFile, writeFile, rename, mkdir } = require("fs/promises");
const path = require("path");
const { DEFAULT_TENSION_LIMITS } = require("./spliceRules");

const DB_FILE = process.env.ORGAN_DB_FILE
  ? path.resolve(process.env.ORGAN_DB_FILE)
  : path.join(__dirname, "..", "data", "db.json");

const initialData = {
  tunes: [
    {
      id: "tune_demo",
      title: "雨后圆舞曲",
      composer: "匿名",
      stripSpec: {
        widthMm: 70,
        scale: "20音",
        tempoBpm: 82,
        paperType: "半透明纸带"
      },
      createdAt: new Date("2026-06-16T00:00:00.000Z").toISOString()
    }
  ],
  sections: [
    {
      id: "section_demo_1",
      tuneId: "tune_demo",
      startBeat: 1,
      endBeat: 32,
      laneRange: "1-10",
      checked: true,
      note: "开头主题已试奏"
    },
    {
      id: "section_demo_2",
      tuneId: "tune_demo",
      startBeat: 33,
      endBeat: 64,
      laneRange: "4-18",
      checked: false,
      note: "副歌段等待校对"
    }
  ],
  issues: [
    {
      id: "issue_demo",
      tuneId: "tune_demo",
      sectionId: "section_demo_2",
      type: "漏孔",
      beat: 41,
      lane: 12,
      description: "第41拍高音孔漏打",
      status: "open",
      createdAt: new Date("2026-06-16T00:00:00.000Z").toISOString(),
      resolvedAt: null
    }
  ],
  // 纸型 -> 试拉张力上限（牛），接片试拉判定以此为准
  paperTypes: DEFAULT_TENSION_LIMITS.map((item) => ({ ...item })),
  // 接片资料：旧存档无此集合时按空表迁入，旧曲目因此被视为未放行
  splices: []
};

/**
 * 就地迁移旧存档：补齐缺失的集合，绝不删除旧字段。
 * 返回是否发生过迁移（需要回写）。
 */
function migrate(db) {
  let changed = false;
  for (const key of ["tunes", "sections", "issues"]) {
    if (!Array.isArray(db[key])) {
      db[key] = [];
      changed = true;
    }
  }
  if (!Array.isArray(db.paperTypes)) {
    db.paperTypes = DEFAULT_TENSION_LIMITS.map((item) => ({ ...item }));
    changed = true;
  }
  // 保证存档中曲目用到的纸型都有上限配置
  for (const tune of db.tunes) {
    const paperType = tune.stripSpec && tune.stripSpec.paperType;
    if (paperType && !db.paperTypes.some((item) => item.paperType === paperType)) {
      db.paperTypes.push({ paperType, tensionLimitN: null });
      changed = true;
    }
  }
  if (!Array.isArray(db.splices)) {
    db.splices = [];
    changed = true;
  }
  return changed;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2) + "\n");
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  if (migrate(db)) {
    await persist(db);
  }
  return db;
}

// 临时文件 + 改名，避免写入中途崩溃把存档截坏
async function persist(data) {
  const tmp = `${DB_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, DB_FILE);
}

const writeDb = persist;

module.exports = { DB_FILE, initialData, migrate, readDb, writeDb };
