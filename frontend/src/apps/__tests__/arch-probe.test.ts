import { it } from 'vitest'
import { parseArchitecture } from '../flow-model'
const FIXTURE = ['architecture-beta', '  group cloud(logos:aws-lambda)[云侧]', '  service s3(logos:aws-s3)[S3 存储] in cloud', '  service db(logos:aws-rds)[数据库] in cloud', '  service fe(logos:react)[前端工作台]', '  fe:R --> L:s3', '  fe:B --> T:db'].join('\n')
it('probe', () => {
  const m = parseArchitecture(FIXTURE)
  console.log('PROBE nodes:', [...m.nodes.keys()].join(','), '| edges:', m.edges.map((e) => `${e.from}:${e.to}:${e.kind}`).join(','))
  console.log('PROBE ser:', JSON.stringify(serializeArchitecture(m)))
})
import { serializeArchitecture } from '../flow-model'
