# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间和试奏问题；接片放行单独存档于 `data/splices.json`。

## 启动

```bash
PORT=3019 node server.js
```

测试：

```bash
npm test          # node --test test/
```

## 接片放行（续接断带）

三层分开维护：

- `lib/spliceRules.js` — 接片规则（纯函数，无 IO）：首尾相接、已校对区间、张力/破孔判定、闸门。
- `lib/spliceStore.js` — 存档读写：独立 JSON 文件，临时文件 + rename 原子写入，与曲目主库互不影响。
- `lib/spliceRoutes.js` — 接口入口（HTTP 编解码与编排），规则与存档均委托上面两层。

### 规则要点

- 登记接片须记录：左右段编号、接口拍号、胶带批号、检验人（另有纸型及其张力上限快照）。
- 两段拍号必须首尾相接：左段末拍 = 接口拍号 N，右段首拍 = N+1，否则拒绝登记（防止拍号接错）。
- 接缝不能跨过任何已校对区间（某区间同时覆盖接缝两侧 N、N+1 即拒绝；接缝恰在已校对区间分界处不算跨过）。
- 试拉张力超过纸型上限（半透明纸带 18N、牛皮纸带 26N、蜡光纸带 22N；未知纸型拒绝判定），或接口连续两次破孔，即转「待返工」。
- 待返工期间不能继续打孔，也不能直接试拉；原段资料和打孔进度一律不动。返工后试拉通过才转「已放行」，历史失败原因与事件链永久保留。
- 旧曲目无接片资料时，闸门一律按未放行处理（fail-closed）；存档在磁盘，重启后可查。

### 接片接口

- `POST /tunes/:id/splices` — 登记接片（body：`leftSectionId`、`rightSectionId`、`seamBeat`、`tapeBatch`、`inspector`）
- `GET  /tunes/:id/splices?status=` — 查询曲目接片记录
- `GET  /tunes/:id/splice-gate?seamBeat=N` — 某接缝是否已放行
- `GET  /tunes/:id/punch-gate?nextBeat=N+1` — 继续打孔闸门（查 N|N+1 接缝）
- `POST /splices/:id/pulls` — 上报试拉（`tensionN`、`holesBroken`、`note?`）
- `POST /splices/:id/reworks` — 登记返工（`tapeBatch?`、`inspector?`、`note?`）
- `GET  /splices/:id` — 接片记录详情（含失败原因与事件链）

接片状态：`待试拉` → `已放行`（试拉通过）／`待返工`（超限或连续两次破孔）；返工登记后回 `待试拉`。

环境变量：`PORT`（默认 3019）、`DB_FILE`（曲目主库）、`SPLICE_DB_FILE`（接片存档）。

## 主要接口

- `GET /health`
- `GET /tunes`
- `POST /tunes`
- `GET /tunes/:id/progress`
- `GET /tunes/:id/sections`
- `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`
- `POST /issues`
- `PATCH /issues/:id/status`

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":45,"lane":9,"description":"第45拍第9轨多打孔"}'
```

## 接片闭环示例

```bash
# 登记 32|33 接缝（左段末拍32，右段首拍33）
curl -X POST http://127.0.0.1:3019/tunes/tune_demo/splices \
  -H 'Content-Type: application/json' \
  -d '{"leftSectionId":"section_demo_1","rightSectionId":"section_demo_2","seamBeat":32,"tapeBatch":"T-01","inspector":"老周"}'

# 试拉：张力与破孔情况
curl -X POST http://127.0.0.1:3019/splices/<id>/pulls \
  -H 'Content-Type: application/json' -d '{"tensionN":15,"holesBroken":false}'

# 放行了才能继续打第33拍
curl "http://127.0.0.1:3019/tunes/tune_demo/punch-gate?nextBeat=33"
```

