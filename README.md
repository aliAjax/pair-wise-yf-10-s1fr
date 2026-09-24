# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间、试奏问题与**接片放行资料**。

## 启动

```bash
PORT=3019 node server.js
```

存档路径可用 `ORGAN_DB_FILE` 覆盖（测试用）；旧存档首次启动会自动迁移：补齐
`paperTypes`（纸型试拉张力上限）和 `splices`（接片资料）两个集合，不改动旧数据。

## 主要接口

- `GET /health`
- `GET /tunes`
- `POST /tunes`
- `GET /tunes/:id/progress`（含 `spliceGate` 接片放行闸门）
- `GET /tunes/:id/sections`
- `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`
- `POST /issues`
- `PATCH /issues/:id/status`

## 接片放行接口

纸带断裂续接后，登记左右段编号、接口拍号、胶带批号和检验人；规则、存档读写、
HTTP入口分三个模块维护：

- `src/spliceRules.js`：纯规则（首尾相接、接缝避让已校对区间、张力/破孔判定、闸门）
- `src/archive.js`：存档读写与旧库迁移
- `src/spliceApi.js` + `src/spliceService.js`：入口与用例编排

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/tunes/:id/splices` | 查某曲目全部接片资料（重启后仍可查） |
| POST | `/tunes/:id/splices` | 登记接片 |
| GET | `/tunes/:id/splice-gate` | 放行闸门：无接片资料按未放行处理 |
| GET | `/splices/:id` | 单条接片（含完整操作 history） |
| POST | `/splices/:id/pulls` | 记录一次试拉 |
| POST | `/splices/:id/reworks` | 登记返工 |
| GET | `/paper-types` | 纸型试拉张力上限表 |
| PATCH | `/paper-types/:paperType` | 维护某纸型张力上限（牛） |

### 放行规则

1. 两段拍号必须首尾相接：`接口拍号 = 左段 endBeat = 右段 startBeat - 1`，否则拒绝登记。
2. 接缝不能跨过已校对区间（接口拍落在任一 `checked` 区间内即拒绝）。
3. 试拉张力 **超过纸型上限**，或接口**连续两次破孔** → 状态 `rework_pending`，
   留在待返工；原段与打孔进度不改动，且不允许直接再试拉。
4. 仅一次破孔 → `pull_failed`，可再次试拉（连续计数累计）。
5. 返工登记后状态回到待试拉、连续破孔计数清零；旧失败原因在 `history` 中保留
   （返工记录的 `retainedFailureReasons` 可查）。返工后试拉通过才 `released`。
6. 曲目下所有接口放行后闸门才放行，才能继续打孔；旧曲目无接片资料 = 未放行。

## 闭环示例

```bash
# 登记接片：左段 section_a（尾拍24）与右段 section_b（首拍25）
curl -X POST http://127.0.0.1:3019/tunes/tune_demo/splices \
  -H 'Content-Type: application/json' \
  -d '{"leftSectionId":"section_a","rightSectionId":"section_b","junctionBeat":24,"tapeLotNo":"TAPE-A1","inspector":"检验员甲"}'

# 第一次试拉（破孔）-> pull_failed
curl -X POST http://127.0.0.1:3019/splices/<spliceId>/pulls \
  -H 'Content-Type: application/json' -d '{"tensionN":20,"toreHole":true}'

# 第二次连续破孔 -> rework_pending；登记返工后再试拉通过才放行
curl -X POST http://127.0.0.1:3019/splices/<spliceId>/reworks \
  -H 'Content-Type: application/json' -d '{"tapeLotNo":"TAPE-A2","inspector":"检验员乙"}'
curl -X POST http://127.0.0.1:3019/splices/<spliceId>/pulls \
  -H 'Content-Type: application/json' -d '{"tensionN":20,"toreHole":false}'

# 放行闸门
curl http://127.0.0.1:3019/tunes/tune_demo/splice-gate
```

## 测试

```bash
npm test
```

端到端用例使用临时存档与独立端口，覆盖首尾相接校验、接缝避让已校对区间、
张力超限、连续两次破孔、返工后保留旧原因、闸门与重启持久化。
