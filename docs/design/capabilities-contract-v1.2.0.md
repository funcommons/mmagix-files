# v1.2.0 执行进度（无人值守循环）

> 方案：`docs/design/capabilities-design-v1.2.0.md`
> 循环：cron `*/5 * * * *` 每 5 分钟续跑 · 主 agent 调度汇报 · 子 agent 单一职责（写测试/写业务/跑测试/评审各一）· 并发 ≤5
> 每步流程：写测试 → 写业务 → 跑测试 → 修复 → 评审轮（≤4 轮或无 P0-P2）
> 范围内全量测试触发条件：改动 >10% 行 / >1000 行 / >10 任务

## 里程碑状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | 底座：sigv4 extraQuery + client 5 方法 + IDB v2 checkpoint store | ✅ **收官**（新例 11+16+15+7=49 全绿 + 回归 79 零破坏；评审 R1 四修复闭合 + R2 两 P2 收尾：守卫红测试×5 已钉、注释修正 34/34） |
| M2 | 断点上传补齐（checkpoint/单片重试/自适��分片/进度/孤儿清理） | 🔄 核心域 ✅ **关闭**（22+9+18=49 全绿；评审 R1 四修+R2 零新发现）；装配接线（resumeCheckpoints UI+partSize 校验硬性要求）随 UI 波次 |
| M3 | 回收站 + 版本历史 | ✅ **关闭**（核心 19/19 含 6 守卫钉；TrashPanel 7/7 + 接线 commands-trash 12/12 + 总线 19 键点亮 + checkpointStore 注入；版本历史 F8：VersionPanel 8/8+右键入口+14 对 i18n） |
| M4 | 在线解压（zip-reader/浏览器/解出/安全） | ⬜ |
| M5 | 分享增强（信封/校验页/管理台） | 🔄 核心域 ✅ **关闭**（share-crypto 35/35：R1 四修+R2 四闭合+P2×2 收尾+守卫 6 钉全绿）；UI 波次（ShareDialog/校验页/管理台）待排 |

## M1 波次

| 波 | 任务 | 子 agent | 状态 |
|---|---|---|---|
| W1 | 测试：sigv4 extraQuery | test-writer-A | ✅ 10 例（6 红/4 按设计绿）；假设：编码后键名排序、Signature 恒末尾、{} 逐字节回归 |
| W1 | 测试：client 5 方法（versioning/versions/deleteVersion/uploads） | test-writer-B | ✅ 14 例红透（DOMParser 解析、query 顺序固化断言） |
| W1 | 测试：checkpoint-store（IDB v2 + v1→v2 迁移 + 内存降级） | test-writer-C | ✅ 15 例红透；⚠️ 实证：createIdbMetaStore open(dbName,1) 升 v2 后会 VersionError——已补发 coder-C 同修 open 版本号 |
| W2 | 业务：sigv4 extraQuery（**仅 sigv4.ts**；client getPresignedUrl 透传延后至 B 落地） | coder-A | ✅ 落地（+10/-1，静态对拍 10/10；同名键共存不覆盖性质已核实） |
| W2 | 业务：client 5 方法 + types 接口 | coder-B | ✅ 落地（VersionRow 等类型入 types.ts；vue-tsc 0 错；存疑：空串参数按未传处理、maxKeys:0 字面透传） |
| W2 | 业务：search-index v2 + checkpoint-store.ts | coder-C | ✅ 落地（共享 openSearchDb 开启器：新库直建两 store、v1 升级保 objects；IDB_DB_NAME/IDB_UPLOADS_STORE 导出。注：其「测试文件不存在」判断有误，已核实磁盘存在） |
| W2b | 业务：client.getPresignedUrl/presignPutUrl 透传 extraQuery（client.ts 小改） | coder-F | ✅ 落地——**M1 实现域全闭环**（接口全量同步 nowMs 防位置错位，向后兼容已验证） |

## M4 契约（zip-reader 纯函数模块，新文件 frontend/src/files/zip-reader.ts）

```ts
export interface ZipEntryMeta {
  name: string; size: number; compressedSize: number; method: number
  crc32: number; lastModified: number; encrypted: boolean
  offset: number; isDirectory: boolean
}
export interface ZipCentral { entries: ZipEntryMeta[]; zip64: boolean; comment: string }
export interface RangeReader {
  size(): Promise<number>
  read(start: number, end: number): Promise<Uint8Array>   // [start, end)
}
export function parseCentralDirectory(r: RangeReader): Promise<ZipCentral>
// 尾部 min(65557,size) 从尾向头找最后一个 EOCD PK\x05\x06；zip64 locator PK\x06\x07 → zip64 EOCD PK\x06\x06
// PK\x01\x02 解析：bit0 加密位；bit11 UTF-8，否则 TextDecoder('utf-8',{fatal:true}) 失败回退 'gbk'
// zip64：size/offset===0xFFFFFFFF 或 count===0xFFFF → extra 0x0001 取真值；DOS 时间→epoch ms
export async function extractEntry(r: RangeReader, entry: ZipEntryMeta): Promise<Uint8Array>
// local header PK\x03\x04 @offset，extraLen 以 local 为准；0 store/8 fflate inflateRaw/其他 throw
// CRC32 校验失败 throw；encrypted 兜底 throw（UI 先拦）
export function sanitizeEntryName(name: string): string | null
// 反斜杠→/；绝对路径/盘符/含 '..' 段 → null（zip slip）
export const ZIP_BOMB_RATIO_LIMIT = 200
export function checkBomb(entries: ZipEntryMeta[], opts?: { maxTotalBytes?; maxEntries?; ratio? }): { ok: boolean; reason?: string }
// 默认 maxTotalBytes=2GB、maxEntries=10000、单条 ratio>200 拦
```

## M4 波次

| 波 | 任务 | 子 agent | 状态 |
|---|---|---|---|
| W1 | 测试：zip-reader（fixture 用 fflate 造常规包 + 手工二进制造 GBK/加密位/zip64） | test-writer-G | ✅ 26 例红透；/tmp 参考实现对拍 26/26（fixture 已自证）；钉死：CrcMismatch 错误名、DOS→UTC、isDirectory=名尾 / |
| W2 | 业务：zip-reader.ts | coder-H | ✅ 落地（EOCD 两段式倒序扫；zip64 extra 缺序消费；fflate inflateSync 实证；CRC 失败 err.name=CrcMismatch；偏差四处均非静默） |
| W3 | 跑测试（zip-reader 26 例） | test-runner-D | ✅ 后续闭环：23/26→26/26（realm 修正后全绿） |
| W5 | M4 评审轮（zip-reader.ts） | reviewer-E | ✅ P0×1（炸弹闸伪造 CD 绕过，1024× 放大实证）P1×3（extraEnd 越界/cdSize 无钳制/clone 反向优化）P2×5 → 修复轮下发（P2-1 记录为 ZIP 固有两义性；P2-5 零长度 Range 注记 UI 契约） |
| W5 | M4 评审修复 R1（P0-1/P1-1/2/3+P2-2/3/4） | fixer-L | ✅ 七项全修 26/26 绿（inflate out 封顶+硬校验——实证推翻评审 fflate 假设：huffman 块静默截断；越界三面全收口；端到端炸弹实证闭环+残余语义留档） |
| W5 | M4 守卫补钉（炸弹闸/越界/NUL/GBK 六枚） | writer-G 二轮 | ✅ 32/32 绿（resetModules 绕模块级缓存） |
| W5 | M4 R2 复评 | reviewer-E 续 | ⚠️ 未收官：六项闭合、P0-1 真闭合，但新 P1（:369 compressedSize 驱动读无界验——5GB 包单条解出 OOM）+ P2×3（注释口径失实/stored 裸 RangeError/zip64 U32_MAX 静默保留）→ R2 修复轮 |
| W5 | M4 评审修复 R2（:369 界验+注释口径+stored 归一+U32_MAX 显式拒） | fixer-M | ✅ 四修 32/32+下游 40/40 绿（措辞并入「中心目录损坏」分类族兼容守卫钉正则） |
| W5 | M4 R3 快速复核 | reviewer-E 续 | ✅ 四点全闭合零新发现（六声明值读点收口终查完备）——**M4 评审轮收官** |
| 裁决 | M4-UI 偏差：① unzipMaxBytes 走 appOptions 通道=照准 ② zip 解出→upload-queue 接线归装配收尾 | 主 agent | ✅ |
| W4 | 修复 zip-reader 3 红（返回值独立化） | fixer-E | ✅ 25/26：真因=vitest jsdom realm 分裂（#4043，预设修法被探针推翻）；实现侧改 structuredClone 副本（memory 语义+）；末 1 红=测试混用两 realm → writer-G 按 zip.test.ts 先例改 realm 安全比较。⚠ 其提及 src/files/__tests__/tmp-p1-verify.test.ts（疑 fixer-G 在途临时件）——fixer-G 落地后核查清理 |
| W2+ | UI：zip 浏览器内置应用 + 解出上传接线 + i18n | 后续排 | ⬜ |
| W3 | 跑测试（新 3 文件 + 既有 sigv4/client/search-index 回归） | test-runner | ⬜ |
| W4 | 修复（如有失败） | fixer | ⬜ |
| W5 | 评审轮（P0-P2 → 修复，≤4 轮） | reviewer/fixer | ⬜ |

## 契约（W1/W2 对齐用，改动即更新此处）

```ts
// A. sigv4.ts：PresignInput 追加可选字段，保持既有参数形状
interface PresignInput { /* 现有字段不动 */ extraQuery?: Record<string, string> }
// extraQuery 与 X-Amz-* 六项合并进 canonical query（编码后按键名字典序排序），
// 同时参与签名与最终 URL；不传时行为与旧逻辑逐字节一致。

// B. client.ts（S3SigV4Client 具体类必实现；S3Client 接口加可选方法，仿 getPresignedUrl?）
getBucketVersioning(): Promise<'Enabled' | 'Suspended' | 'Disabled'>   // GET ?versioning，空配置=Disabled
listObjectVersions(opts?: { prefix?; keyMarker?; versionIdMarker?; maxKeys? }):
  Promise<{ versions: { key; versionId; isLatest; lastModified; size }[];
            deleteMarkers: { key; versionId; isLatest; lastModified }[];
            isTruncated; nextKeyMarker?; nextVersionIdMarker? }>          // GET ?versions
deleteVersion(key: string, versionId: string): Promise<void>            // DELETE ?versionId=
listMultipartUploads(): Promise<{ key; uploadId; initiated? }[]>        // GET ?uploads

// C. frontend/src/files/checkpoint-store.ts（新文件）
export interface UploadCheckpoint {
  fingerprint: string; path: string; size: number; lastModified: number;
  partSize: number; uploadId: string; parts: { number: number; etag: string }[];
  createdAt: number; updatedAt: number;
}
export interface CheckpointStore {
  load(fingerprint: string): Promise<UploadCheckpoint | null>;
  put(row: UploadCheckpoint): Promise<void>;
  remove(fingerprint: string): Promise<void>;
  listAll(): Promise<UploadCheckpoint[]>;
}
export function createIdbCheckpointStore(dbName?: string): CheckpointStore
// 默认 DB 'mmagic-search' 升 v2 增 store 'uploads'(keyPath 'fingerprint')；
// v1→v2 迁移必须保留 objects 数据；无 indexedDB 环境降级内存实现
export function createMemoryCheckpointStore(): CheckpointStore
```

## M2 契约（断点上传补齐，W1 已按此写测试）

```ts
// frontend/src/files/upload-queue.ts 扩展（UploadParams 追加，现有字段不动）
maxParts?: number                    // 默认 10000
partRetry?: number                   // 默认 3（每片独立重试）
partRetryBaseMs?: number             // 默认 500，退避 ×2^n + 0~250ms 抖动
checkpointStore?: CheckpointStore    // 传入启用跨会话续传；不传=现状行为零回归
onProgress?: (p: { bytes: number; total: number; rate?: number }) => void
// 自适应分片（导出纯函数）：effectivePartSize(size, basePartSize, maxParts)
//   = max(basePartSize, pow2ceil(size / maxParts))，保证片数 ≤ maxParts
// checkpoint 行为：multipart 在 createMultipart 返回后落行（行出现即字段齐全；enqueue→create crash 窗口
//   服务端无会话、零可续传损失——2026-10-29 评审修订，原「入队即 put」作废）；
//   每片成功更新 parts；complete/abort/终态失败 remove；≤阈值单 PUT 不写 checkpoint
// 退避口径（评审裁决）：**间隔制** sleep(base×2^attempt + 抖动)（500/1000/2000），禁用累计制
// 新增：resumeCheckpoints(): Promise<ResumeCandidate[]>
//   listAll → 用 listMultipartUploads 探活 uploadId（存活→候选；NoSuchUpload→移除 checkpoint）
// 单片重试：仅网络/5xx/超时重试；UPLOAD_ABORTED_CODE(4901) 与 4xx 语义错不重试；
//   分片进度纳入 onProgress（完成片×partSize + 完成后 complete）

// frontend/src/files/orphan-sweeper.ts（新文件）
export interface SweepResult { key: string; uploadId: string; aborted: boolean }
export function sweepOrphanUploads(
  client: Pick<S3Client, 'listMultipartUploads' | 'abortMultipart'>,
  opts?: { maxAgeMs?: number },   // 默认 7d
): Promise<SweepResult[]>
// initiated 超龄→abort(aborted:true)；解析失败/缺失→跳过不动(aborted:false，保守)
```

## M2 波次

| 波 | 任务 | 子 agent | 状态 |
|---|---|---|---|
| W1 | 测试：upload-queue checkpoint/重试/自适应/进度 | test-writer-D | 🔄 |
| W1 | 测试：orphan-sweeper | test-writer-E | ✅ 7 例红透（假时钟 NOW 固定；严格 > 边界 ±1ms；abort 抛错隔离） |
| W2 | 业务：upload-queue 四特性（单文件域，串行） | coder-D | ✅ 落地（admit 占位行+cpChain 保序回填；isRetryablePartError 正向判别；真实字节进度；探活抛错→保守 [] 不删行；偏差三处均非静默） |
| W3 | 跑测试（M2 两新 + upload-queue 回归） | test-runner-B | ✅ 42/47（orphan 7/7、回归 18/18）；5 红全在 checkpoint 特性：占位行时序×2 / abort 未清 / 退避未翻倍 / 直传误发进度 |
| W4 | 修复 M2 五红（upload-queue.ts） | fixer-B | ✅ 39/40（回归 18/18 零破坏）：占位行废弃改 create 后落行；discard 同步发起；退避按测试口径改累计制（⚠ 与契约文字有出入，留评审轮裁决）；直传删 onProgress；「parts 复活」用例判定测试缺陷（插桩证明与 remove 承诺互斥）→ 退回 writer-D 修正 |
| W2 | 业务：orphan-sweeper.ts | coder-E | ✅ 落地（?? 保 maxAgeMs:0、abort 隔离、可选方法缺失→空清单降级） |
| W3 | 跑测试（M1 三新 + sigv4/client/search-index 回归） | test-runner-A | ✅ 116/118 绿零回归；红① sigv4-extraquery 多键特殊字符排序；红② checkpoint-store 迁移后 db.version=1 |
| W4 | 修复红①（sigv4.ts 排序/编码）+红②（checkpoint-store 迁移） | fixer-A | ✅ 红②已修（工厂即开库 +7/-2，15/15 绿，104 例回归 103 绿）；红①判定测试缺陷（期望串漏末尾 d，证据链完整）→ 已退回 test-writer-A 自修 |
| W5 | M1 评审轮（P0-P2 → 执行，≤4 轮） | reviewer-A/fixer | R1：**无 P0**；P1×2（openSearchDb blocked/versionchange；listMultipartUploads 截断误删断点）P2×3 → 修复轮下发（P2-5 接口形状留档不改） |
| W5 | M1 评审修复 R1（P1-1/P1-2/P2-3/P2-4） | fixer-C | ✅ 四项全修，124/125 绿；唯一红=测试喂保留键撞新守卫（两正确要求冲突，裁决守卫优先）→ 测试侧换 X-Amzz-Middle |
| W5 | M1 R2 复评（范围=R1 diff + 测试修正） | reviewer-A 续 | ✅ 四修复全闭合无新 P0/P1；剩 P2×2：①三守卫缺红测试钉（sigv4 例→writer-A 补；uploads 翻页/maxAgeMs→writer-I 补）②search-index:251 降级注释失真（下个 fixer 槽改） |
| W5 | M1 R2 收尾：补 uploads 翻页/maxAgeMs 守卫测试 + 修注释 | writer-A'/'fixer-F | ⬜ |

## M3 契约（回收站核心，UI/版本历史后续波次）

```ts
// frontend/src/files/tree-store.ts 追加（export interface + TreeStore 方法）
export interface TrashEntry {
  key: string                    // 原路径
  deleteMarkerVersionId: string  // latest DeleteMarker 的 versionId（恢复即删它）
  deletedAt: number | null       // marker LastModified（epoch ms）；缺失/不可解析=null（UI 显示「—」）——2026-10-29 R1 修订
  versions: number               // 该 key 实体版本数（含 marker 外的全部 Version）
}
listTrash(opts?: { prefix?: string }): Promise<TrashEntry[]>
// client.listObjectVersions 分页聚合（isTruncated 用 nextKeyMarker/nextVersionIdMarker 续拉）
// → 按 key 分组 → 仅收 latest 为 DeleteMarker 的组；versions=该 key 的 Version 条目数
restoreTrash(entries: TrashEntry[]): Promise<void>
// 每条 client.deleteVersion(key, deleteMarkerVersionId)；并发 3；空数组无操作
purgeTrash(entries: TrashEntry[]): Promise<void>
// 逐条：listObjectVersions({prefix:key}) 聚合全部 versionId（Version+DeleteMarker）→ 复验 latest 仍为
// DeleteMarker（陈旧条目防误删活版本，跳过计 skipped）→ 逐个 deleteVersion；并发 3；
// 失败聚合抛 TrashBatchError（SdkError 子类，failedDetails 含 `${key}: ${cause.message}`）——R1 修订
// restoreTrash 失败语义同轮修订：停取新任务+等全部落定+聚合 TrashBatchError（不再首错即抛）
emptyTrash(opts?: { prefix?: string }): Promise<{ purged: number }>
// listTrash(opts) → purgeTrash 全部 → 返回条数
```

## M3 波次

| 波 | 任务 | 子 agent | 状态 |
|---|---|---|---|
| W1 | 测试：tree-store 回收站四方法 | test-writer-F | ✅ 修正后 13/13 绿 + 回归 22/22（两处桩断言不可达已按反证修正） |
| W5 | M3 评审轮（tree-store.ts 增量） | reviewer-C | ✅ 无 P0；P1×2（runLimited 首错后台不停；purge 无新鲜度复验=不可逆数据丢失面）P2×4 → 修复轮下发（P2-2 刷新/emit 与 P2-3 DI 放宽归 UI 波次接线） |
| W5 | M3 评审修复 R1（P1-1/P1-2/P2-1/P2-4） | fixer-G | ✅ 四项全修 35/35 绿（runLimited 停取+聚合 TrashBatchError；purge 合并单阶段复验 latestIsMarker；deletedAt number|null；failedDetails 经 SdkError 子类保真） |
| W5 | M3 R2 复评 | reviewer-C 续 | ✅ 四修复全闭合无 P0/P1（停取仿真实证、透传链核验、幂等删除查证 MinIO 已对齐 AWS）；P2×3 → 收尾：N1+N2=fixer-K 🔄 · N3 四枚钉=writer-F ⬜ 下槽 |
| W5 | M2 评审轮（upload-queue.ts 增量，含累计退避口径裁决） | reviewer-B | ✅ 无 P0；裁决：契约间隔制正确、累计制=偏差、测试断言混合基线缺陷；P1×1（退避）P2×4 → 修复轮双开（fixer 源码 + writer 测试） |
| W5 | M2 评审修复 R1（退避回间隔制/cpRow guard/parts 拷贝/注释清理） | fixer-J | ✅ 四修全落，终态 40/40 绿（与 writer-D 新断言交汇即绿） |
| W5 | M2 测试修正（退避断言改 partTimes 相邻差） | writer-D 二轮 | ✅ 22/22 绿（间隔制口径双侧落实） |
| W5 | M2 R2 复评 | reviewer-B 续 | ✅ 四项全闭合零新发现——**M2 评审轮收官**（49/49 复跑；guard×cpChain 时序推演关死孤儿窗口；间隔制+抖动窗核验） |
| W2 | 业务：tree-store 四方法 | coder-G | ✅ 落地（runLimited 并发闸；purge 两阶段含 list 失败聚合；FileTreeWithTrash 扩展接口避免破坏既有绿测类型）；/tmp 机械仿真 12/13，反证出测试 2 处断言不可达 → 已退回 test-writer-F 修正 |
| W2+ | UI：TrashPanel.vue + nav + i18n + commands（restore/purge） | 后续排 | ⬜ |

## M5 契约（分享信封纯模块，新文件 frontend/src/files/share-crypto.ts）

```ts
export interface ShareMetaV1 {
  v: 1; key: string; name: string; size: number
  createdAt: number; expiresAt: number
  kdf: { alg: 'PBKDF2-SHA256'; iterations: number; salt: string }  // salt=b64
  blob: string    // AES-GCM-256 密文 b64（明文=对象预签名 GET URL）
  iv: string      // 12B b64
}
export function randomShareId(): string          // 16B random → base64url（22 字符不可枚举）
export function randomPassword(len?: number): string  // 默认 6 位，无歧义字符集（去 0O1lI）
export function toB64Url(b: Uint8Array): string
export function fromB64Url(s: string): Uint8Array
export async function sealShareSecret(plaintext: string, password: string, opts?: { iterations?: number }):
  Promise<{ blob: string; iv: string; kdf: ShareMetaV1['kdf'] }>
// PBKDF2-SHA256 默认 100000 轮 + 随机 16B salt → AES-GCM-256（12B iv）
export async function openShareSecret(blob: string, iv: string, kdf: ShareMetaV1['kdf'], password: string): Promise<string>
// 错密码/密文篡改 → reject（GCM auth tag）——「密码校验=解密成功」语义本体
export function buildShareMeta(input: { key: string; name: string; size: number
  sealed: { blob: string; iv: string; kdf: ShareMetaV1['kdf'] }   // = await sealShareSecret(...) 结果，纯组装零密码学
  ttlMs?: number; now?: number }): ShareMetaV1                    // 2026-10-29 契约改版：废除双引擎（seal-then-assemble）
export function isShareExpired(meta: ShareMetaV1, now?: number): boolean
```

## M5 波次

| 波 | 任务 | 子 agent | 状态 |
|---|---|---|---|
| W1 | 测试：share-crypto（WebCrypto 桩用 node:crypto.webcrypto） | test-writer-H | ✅ 21 例红透；钉死：fromB64Url 抛错、默认 ttl=86400_000；提示：勿顶层解构 crypto.subtle |
| W2 | 业务：share-crypto.ts | coder-I | ✅ 首版落地（21 例静态对拍+WebCrypto 互通实证）；⚠️ 契约级裁决：同步签名逼出手搓 AES-GCM 双引擎→**改 seal-then-assemble**（buildShareMeta 纯组装，双引擎删除），writer-H 改 4 例中 |
| W2b | 业务：share-crypto 删双引擎改纯组装 | coder-I 续 | ✅ 29/29 绿（模块 ~200 行零手写密码学；sealed 三元组原样透传钉死） |
| W5 | M5 评审轮（share-crypto.ts） | reviewer-D | ✅ P0×1（iterations 无下限+账实不符）P1×1（open 全信不可信 meta=DoS 面）P2×2 → 修复轮下发 |
| W5 | M5 评审修复 R1（P0-1/P1-1/P2-1/P2-2） | fixer-H | ✅ 四项全修 29/29 绿（KDF floor=1000/上界=1000 万/salt16B/iv12B/blob 双闸 10MB；空密码双口拦） |
| W5 | M5 守卫红测试补钉 | writer-H 二轮 | ✅ 33/33 绿（含「预检先行」防回退钉） |
| W5 | M5 R2 复评 | reviewer-D 续 | ✅ 四项全闭合无 P0/P1；遗留 P2×2（seal 上界不对称、blob<16B 未钉）→ 裁决：本轮顺手收尾不留尾 |
| W5 | M5 P2 收尾（fixer: seal 上界对称；writer: blob<16B+上界补钉） | fixer-I/writer-H 三轮 | 🔄 |
| W2+ | UI：ShareDialog 增强/校验页 /s/:id/管理台/i18n/命令 | 后续排 | ⬜ |

## 待办队列（下一空槽优先级）

1. **全量测试**（触发：任务数已超 10 个 / 新增代码+测试已超 1000 行）——test-runner-C 跑 `pnpm vitest run`（全仓）+ `pnpm test:coverage` 检查 ≥80% 门禁不回退
2. fixer-B 绿后 → M2 评审轮（reviewer-B，范围 upload-queue.ts）
3. coder-G 绿后 → M3 runner + 评审
4. writer-G/H 落地 → coder-H（zip-reader）/ coder-I（share-crypto）
5. M3/M4/M5 核心绿后 → UI 波次（TrashPanel/zip 浏览器/ShareDialog+校验页+i18n+命令注册）

## M3-F8 波次（版本历史，P1 顺带——versioning 白送能力）

```vue
<!-- TreePanel 右键菜单（文件项）追加「历史版本」→ emit('open-history', key) -->
<!-- frontend/src/files/ui/VersionPanel.vue（IO 回调注入） -->
props: {
  list: (key: string) => Promise<VersionRow[]>            // tree.listObjectVersions 包装（filter key）
  restore: (key: string, versionId: string) => Promise<void>  // 恢复=deleteVersion；确认框在父级或内嵌确认后调
  download?: (key: string, versionId: string) => Promise<void>
  key: string                                              // 目标文件
  busy?: boolean
}
<!-- 列表：版本 Id 短显/大小/时间/isLatest 标；恢复钮（非 latest 版本）；关闭 -->
```

## M3-F8 波次表

| 波 | 任务 | 子 agent | 状态 |
|---|---|---|---|
| W1 | 测试：VersionPanel + 右键项 | test-writer-O | 🔄 |
| W2 | 实现：TreePanel 菜单项 + VersionPanel | coder-S | ⬜ |

## UI 波次契约（核心五域绿后开启；纯展示组件 emit 语义，业务接线在 Home/workspace-ops）

**M2 接线硬性要求（评审 P2-3）**：消费 ResumeCandidate 时**必须校验 candidate.partSize === effectivePartSize(当前配置)**——不一致整件重传（partNumber↔字节区间错位会拼出坏对象）；候选 partSize 是构造期冻结值，配置变更后跨会话必漂移。

```vue
<!-- M3-UI: frontend/src/files/ui/TrashPanel.vue（纯展示，风格对齐 UploadPanel.vue） -->
props: { entries: TrashEntry[]; busy?: boolean }
emits: 'restore'(选中 TrashEntry[]) | 'purge'(选中 TrashEntry[]) | 'empty'
<!-- 列表：checkbox 多选 + 原路径 + 删除时间（deletedAt null→'—'走 i18n）+ 版本数；工具栏：恢复/彻底删除/清空 -->

<!-- M4-UI: frontend/src/apps/ui/ZipBrowser.vue（IO 全部回调注入，组件可测） -->
props: {
  load: () => Promise<ZipCentral>                       // renderer 注入：RangeReader+parseCentralDirectory
  extract: (entries: ZipEntryMeta[]) => Promise<void>   // renderer 注入：sanitize+checkBomb 已在回调内做，组件只传勾选
  download: (entries: ZipEntryMeta[]) => Promise<void>
  busy?: boolean
}
<!-- 行为：mount 调 load → 条目表（名称/大小/修改时间/🔒加密标）；勾选→「解出所选」调 extract；
     「全部解出」「下载所选」同构；load reject → 错误态；加密条目默认不可勾+提示行 -->

<!-- M5-UI-a: frontend/src/views/share/ShareAccess.vue（校验页，公开路由 /s/:shareId；IO 回调注入） -->
props: {
  shareId: string
  fetchMeta: (shareId: string) => Promise<ShareMetaV1 | null>   // null=已撤销/不存在
  openSecret: (meta: ShareMetaV1, password: string) => Promise<string>  // 返回下载 URL
}
<!-- 状态机：loading→(meta null→已取消态 | isShareExpired→到期态 | 密码框)；错密码→错误提示+
     本地错 5 次锁 30s（localStorage 计数器 key 'share:lock:<shareId>'）；成功→文件名/大小+「下载」按钮 -->

<!-- M5-UI-b: ShareDialog.vue 增强（既有组件，IO 回调注入保持既有风格） -->
props 追加: {
  createShare?: (input: { key; name; size; password; ttlMs }) => Promise<{ shareId; url }>  // 注入则启用增强面
  listShares?: () => Promise<ShareRow[]>      // ShareRow = { shareId; key; name; createdAt; expiresAt }
  revokeShare?: (shareId: string) => Promise<void>
}
<!-- 行为：密码开关（默认随机 6 位+重掷）+ 有效期（1h/24h/7d/自定义≤7d 禁用超标）→ 生成调 createShare
     → 结果区链接+密码同框各带复制；「管理」区：listShares 列表（目标/到期/复制/撤销）；
     回调未注入 → 增强面整体不渲染（向后兼容，既有用例零回归） -->
```
```

- 2026-10-29 M2 装配点亮：setup.ts 注入 checkpointStore（fixer-N，49/49 绿）——resume 面包条生产装配生效。
- 2026-10-29 UI 批量评审（reviewer-F）：无 P0；P1×4（ShareAccess 回灌守卫/存储写防护、zip 直链生命周期/错误全吞）+P2×6 → 双 fixer 并行修复中；zip.ts 零测试导入=已知覆盖缺口（renderer 胶水，ctx 桩成本高，记录不改）。

- 2026-10-29 循环启动；M1/W1 三个测试子 agent 并行下发。
- 2026-10-29 **全量测试+覆盖门禁通过**：1741/1743（唯一红=zip-reader realm 例，writer-G 随后已修至 26/26）；意外失败 0；lines 81.79% ≥ 80 门禁过（v1.1 基线 80.91%→升 0.88pp）。UI 波次开启（M3-UI 先行）。

## 评审轮收官账

- **UI 评审轮收官**（reviewer-F R3）：fixer-Q 四点全闭合零新发现（兜底移除无死引用、降级触发完备、聚合上报不吞、i18n 双语齐备）。carryover（P2 不阻塞）：① ShareAccess 跨源 `<a download>` 失效——接线时 openSecret 侧补 response-content-disposition ② reject 统一文案「密码不正确」口径 ③ zip.ts 渲染器零直接测试覆盖（ctx 桩成本高，R1 起记录在案）。
