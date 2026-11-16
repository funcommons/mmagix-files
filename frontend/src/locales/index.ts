import { createI18n } from 'vue-i18n'
import zhCN from './zh-CN'
import enUS from './en-US'

export type SupportedLocale = 'zh-CN' | 'en-US'

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS,
    // 别名: vue-i18n 9.x fallback 时会把 'zh-CN'/'en-US' 拆成 ['zh-CN', 'zh'] /
    // ['en-US', 'en'] 依次尝试, 注册 'zh'/'en' 避免缺失警告.
    'zh': zhCN,
    'en': enUS,
  },
  // 导演台的非通用 pose 标签走 t(key, rawLabel) 兜底, raw label 从 pose.json 里拿.
  // 这部分 key 故意缺失, 抑制它们的 missing/fallback 警告 (但其它 key 仍警告).
  // vue-i18n 语义: RegExp 表示「只对匹配的 key 警告」, 用 negative lookahead 排除 pose key.
  missingWarn: /^(?!director\.pose\.)/,
  fallbackWarn: /^(?!director\.pose\.)/,
})

export default i18n
