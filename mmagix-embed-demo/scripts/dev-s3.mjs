#!/usr/bin/env node
/**
 * dev-s3.mjs —— 演示用 S3 兼容服务（s3rver 封装；真 MinIO 由 brew 提供，见 README）
 *
 *   端口 9000；数据目录 <demo>/s3-data；桶 mmagic-demo 自动创建
 *   演示凭据：mmagic / mmagic12345（s3rver 不校验，任意 AK/SK 皆可签名通过）
 *   CORS：s3rver 默认放行所有 origin，浏览器直连无需配置
 *
 *   GET/PUT/DELETE /<bucket>/<key>   匿名即可（本服务不做鉴权）
 */
import s3rverPkg from 's3rver' // CJS 包：Node 26 互操作下 default 可能是类本体或命名空间，双形态兼容
const S3rver = typeof s3rverPkg === 'function' ? s3rverPkg : (s3rverPkg.S3rver ?? s3rverPkg.default ?? s3rverPkg)
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'

const PORT = Number(process.env.S3RVER_PORT || 9000)
const BUCKET = 'mmagic-demo'
const here = dirname(fileURLToPath(import.meta.url))
const dataDir = join(here, '..', 's3-data')
mkdirSync(dataDir, { recursive: true })

/** 种子对象：装载后目录树/预览即有内容可看 */
const SEEDS = [
  {
    key: 'hello.md',
    body: `# MMagic-Files × MinIO 演示\n\n这是一份通过 **s3rver**（S3 兼容服务）提供的 Markdown 对象。\n\n- 目录树左侧应能看到它\n- 点开即渲染预览\n- 试着编辑保存（Ctrl+S）→ putObject 走 SigV4 PUT\n\n> endpoint: http://localhost:9000 · bucket: ${BUCKET} · region: us-east-1\n`,
    type: 'text/markdown; charset=utf-8',
  },
  {
    key: 'notes/meeting.md',
    body: `# 会议纪要\n\n## 事项\n1. iframe 接入演示走通（ready 握手 → workspace 装载）\n2. SigV4 签名请求被 s3rver 正常受理\n\n## 待办\n- [ ] 上传一张图片试试预览\n- [ ] 拖拽一个文件进树面板\n`,
    type: 'text/markdown; charset=utf-8',
  },
  {
    key: 'demo.csv',
    body: `id,name,city,amount\n1,Alice,杭州,120.50\n2,Bob,上海,89.00\n3,Carol,深圳,240.75\n4,Dave,北京,15.20\n`,
    type: 'text/csv; charset=utf-8',
  },
  {
    key: 'logo.svg',
    body: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" rx="16" fill="#409eff"/><text x="60" y="70" font-size="40" fill="#fff" text-anchor="middle" font-family="sans-serif">MF</text></svg>\n`,
    type: 'image/svg+xml',
  },
]

const server = new S3rver({
  directory: dataDir,
  port: PORT,
  address: '0.0.0.0',
  configureBuckets: [BUCKET],
  silent: false,
})

await server.run()
console.log(`s3rver ready: http://localhost:${PORT}  bucket=${BUCKET}  dataDir=${dataDir}`)

// 种子灌入：s3rver 不校验鉴权，匿名 PUT 直达
for (const { key, body, type } of SEEDS) {
  const res = await fetch(`http://localhost:${PORT}/${BUCKET}/${key}`, {
    method: 'PUT',
    headers: { 'content-type': type },
    body,
  })
  console.log(`seed ${res.ok ? '✓' : '✗ ' + res.status} ${BUCKET}/${key} (${body.length}B)`)
}
