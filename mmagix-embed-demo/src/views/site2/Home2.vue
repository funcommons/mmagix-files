<script setup lang="ts">
// 站点 v2 首页（S01 hero + S03 功能地图 + S02 场景三卡 + footer，路由 /）。
// 视觉正本：docs/design/site-redesign-v2/prototypes/s01/s02/s03；
// 颜色一律走项目 --app-* token，SVG 沿原型内联线稿（stroke 1.5）。
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { FcButton, FcSection } from "@/components/sdk";

const { t } = useI18n();
const router = useRouter();

const goGuide = () => router.push("/guide");
const goDocs = () => router.push("/docs");

/** 信任条三枚（页面中段 + footer 复用同一份）；三个图标都是纯 path 线稿 */
const trustItems = computed(() => [
  {
    key: "noBackend",
    title: t("site2.home.trust.noBackend"),
    desc: t("site2.home.trust.noBackendDesc"),
    paths: ["M18 10h-1.26A8 8 0 1 0 9 20h9a4 4 0 0 0 0-8z"],
  },
  {
    key: "embed",
    title: t("site2.home.trust.embed"),
    desc: t("site2.home.trust.embedDesc"),
    paths: ["M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-5 5 5 5 0 0 1-5-5V8zM12 16v5"],
  },
  {
    key: "plugins",
    title: t("site2.home.trust.plugins"),
    desc: t("site2.home.trust.pluginsDesc"),
    paths: [
      "M5 8V5a1 1 0 0 1 1-1h3a2 2 0 1 1 4 0h3a1 1 0 0 1 1 1v3a2 2 0 1 0 0 4v3a1 1 0 0 1-1 1h-3a2 2 0 1 0-4 0H6a1 1 0 0 1-1-1v-3a2 2 0 1 1 0-4z",
    ],
  },
]);

/** 六能力组「深入了解」锚点（slug 对照 src/docs/manifest.ts） */
const capLinks = {
  browse: "/docs/user-guide",
  upload: "/docs/user-guide",
  share: "/docs/user-guide",
  versions: "/docs/changelog",
  unzip: "/docs/user-guide",
  embed: "/docs/jsdk-api",
};
</script>

<template>
  <div class="home2">
    <!-- ═══ S01 · Hero：左文右景 5:7 ═══ -->
    <section class="hero">
      <div class="shell hero-grid">
        <div class="hero-copy">
          <h1>{{ t("site2.home.heroTitle") }}</h1>
          <p class="lede">{{ t("site2.home.heroLede") }}</p>
          <p class="hint">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M19 12l-7 7-7-7" /></svg>
            {{ t("site2.home.heroHint") }}
          </p>
          <div class="cta">
            <FcButton variant="primary" size="lg" data-testid="home-cta-demo" @click="goGuide">
              {{ t("site2.home.ctaDemo") }}
            </FcButton>
            <FcButton variant="secondary" size="lg" data-testid="home-cta-docs" @click="goDocs">
              {{ t("site2.home.ctaDocs") }}
            </FcButton>
          </div>
          <!-- 三步流程条：连接 → 浏览 → 分享 -->
          <div class="steps" role="img" :aria-label="t('site2.home.stepsLabel')">
            <div class="step">
              <span class="step-ic">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-5 5 5 5 0 0 1-5-5V8zM12 16v5" /></svg>
              </span>
              <span class="step-name">{{ t("site2.home.step.connect") }}</span>
              <span class="step-cap">{{ t("site2.home.step.connectCap") }}</span>
            </div>
            <span class="step-line">
              <svg width="36" height="12" viewBox="0 0 36 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M0 6h30" /><path d="M27 2.5L31.5 6 27 9.5" /></svg>
            </span>
            <div class="step">
              <span class="step-ic">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></svg>
              </span>
              <span class="step-name">{{ t("site2.home.step.browse") }}</span>
              <span class="step-cap">{{ t("site2.home.step.browseCap") }}</span>
            </div>
            <span class="step-line">
              <svg width="36" height="12" viewBox="0 0 36 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M0 6h30" /><path d="M27 2.5L31.5 6 27 9.5" /></svg>
            </span>
            <div class="step">
              <span class="step-ic">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
              </span>
              <span class="step-name">{{ t("site2.home.step.share") }}</span>
              <span class="step-cap">{{ t("site2.home.step.shareCap") }}</span>
            </div>
          </div>
        </div>

        <!-- 自绘浏览器框：实景界面板 -->
        <div class="hero-visual">
          <div class="frame-wrap">
            <div class="frame">
              <div class="frame-head">
                <span class="dots"><i class="dot-r" /><i class="dot-y" /><i class="dot-g" /></span>
                <span class="addr mono">mmagix.demo/files</span>
              </div>
              <div class="frame-body">
                <!-- 左：目录树 -->
                <div class="tree">
                  <div class="tree-cap">{{ t("site2.home.mockup.treeCap") }}</div>
                  <div class="trow">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" transform="rotate(-90 12 12)" /></svg>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></svg>
                    reports/
                  </div>
                  <div class="trow">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" transform="rotate(-90 12 12)" /></svg>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></svg>
                    notes/
                  </div>
                  <div class="trow on">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></svg>
                    hello.md
                  </div>
                  <div class="trow">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10M15 10v10" /></svg>
                    demo.csv
                  </div>
                  <div class="trow">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="8.5" cy="10" r="1.5" /><path d="M21 15l-5-5-9 9" /></svg>
                    logo.svg
                  </div>
                </div>
                <!-- 中：文件列表（种子 4 行，第二行 focus 描边示意活界面） -->
                <div class="list">
                  <div class="list-cap mono">sessions/demo/</div>
                  <div class="lrow">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></svg>
                    <span class="name">hello.md</span>
                    <span class="meta mono">1.2 KB · 2026-11-04 09:12</span>
                  </div>
                  <div class="lrow focus-demo">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></svg>
                    <span class="name">notes/meeting.md</span>
                    <span class="meta mono">3.4 KB · 2026-11-03 18:40</span>
                  </div>
                  <div class="lrow">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10M15 10v10" /></svg>
                    <span class="name">demo.csv</span>
                    <span class="badge-chain">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
                      {{ t("site2.home.mockup.sharedBadge") }}
                    </span>
                    <span class="meta mono">18 KB · 2026-10-28</span>
                  </div>
                  <div class="lrow">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="8.5" cy="10" r="1.5" /><path d="M21 15l-5-5-9 9" /></svg>
                    <span class="name">logo.svg</span>
                    <span class="meta mono">6.8 KB · 2026-10-28</span>
                  </div>
                </div>
                <!-- 右：hello.md 渲染预览 -->
                <div class="preview">
                  <h4>{{ t("site2.home.mockup.previewTitle") }}</h4>
                  <p>{{ t("site2.home.mockup.previewBody") }}</p>
                  <ul>
                    <li>{{ t("site2.home.mockup.previewLi1") }}</li>
                    <li>{{ t("site2.home.mockup.previewLi2") }}</li>
                    <li>{{ t("site2.home.mockup.previewLi3") }}</li>
                  </ul>
                </div>
              </div>
            </div>
            <span class="capsule">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7" /></svg>
              {{ t("site2.home.mockup.capsule") }}
            </span>
          </div>
          <p class="frame-note">{{ t("site2.home.mockup.frameNote") }}</p>
        </div>
      </div>
    </section>

    <!-- ═══ 信任条三枚 ═══ -->
    <section class="trust">
      <div class="shell trust-grid">
        <div v-for="item in trustItems" :key="item.key" class="trust-cell">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path v-for="(d, i) in item.paths" :key="i" :d="d" />
          </svg>
          <div><strong>{{ item.title }}</strong><span>{{ item.desc }}</span></div>
        </div>
      </div>
    </section>

    <!-- ═══ S03 · 功能地图（锚点目标 #features） ═══ -->
    <section id="features" class="map-section">
      <div class="shell">
        <header class="head">
          <h2>{{ t("site2.home.mapTitle") }}</h2>
          <p class="sub">{{ t("site2.home.mapSub") }}</p>
        </header>

        <div class="map">
          <!-- 数据源带 -->
          <div class="band">
            <div class="chip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a4 4 0 0 0 0-8z" /></svg>
              <div><strong>{{ t("site2.home.srcS3") }}</strong><span>{{ t("site2.home.srcS3Desc") }}</span></div>
            </div>
            <div class="chip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></svg>
              <div><strong>{{ t("site2.home.srcWebdav") }}</strong><span>{{ t("site2.home.srcWebdavDesc") }}</span></div>
            </div>
          </div>

          <!-- 连线：两源汇入引擎 -->
          <svg class="wires" viewBox="0 0 1328 34" fill="none" aria-hidden="true">
            <path d="M476 0v12M836 0v12M476 12h360M664 12v22" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>

          <!-- 引擎块 -->
          <div class="engine">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></svg>
            <strong>{{ t("site2.home.engine") }}</strong>
            <span>{{ t("site2.home.engineSub") }}</span>
          </div>

          <!-- 连线：引擎扇出到三列 -->
          <svg class="wires" viewBox="0 0 1328 34" fill="none" aria-hidden="true">
            <path d="M664 0v10M221 10h886M221 10v24M664 10v24M1107 10v24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>

          <!-- 2×3 六能力组 -->
          <div class="cells">
            <section class="cell">
              <div class="cell-head">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></svg>
                <h3>{{ t("site2.home.cap.browse") }}</h3>
              </div>
              <p>{{ t("site2.home.cap.browseDesc") }}</p>
              <RouterLink class="more" :to="capLinks.browse">{{ t("site2.home.cap.more") }}
                <svg class="more-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </RouterLink>
              <span class="slug mono">{{ capLinks.browse }}</span>
            </section>

            <section class="cell">
              <div class="cell-head">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                <h3>{{ t("site2.home.cap.upload") }}</h3>
              </div>
              <p>{{ t("site2.home.cap.uploadDesc") }}</p>
              <RouterLink class="more" :to="capLinks.upload">{{ t("site2.home.cap.more") }}
                <svg class="more-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </RouterLink>
              <span class="slug mono">{{ capLinks.upload }}</span>
            </section>

            <section class="cell">
              <div class="cell-head">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
                <h3>{{ t("site2.home.cap.share") }}</h3>
              </div>
              <p>{{ t("site2.home.cap.shareDesc") }}</p>
              <RouterLink class="more" :to="capLinks.share">{{ t("site2.home.cap.more") }}
                <svg class="more-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </RouterLink>
              <span class="slug mono">{{ capLinks.share }}</span>
            </section>

            <section class="cell">
              <div class="cell-head">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>
                <h3>{{ t("site2.home.cap.versions") }}</h3>
              </div>
              <p>{{ t("site2.home.cap.versionsDesc") }}</p>
              <RouterLink class="more" :to="capLinks.versions">{{ t("site2.home.cap.more") }}
                <svg class="more-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </RouterLink>
              <span class="slug mono">{{ capLinks.versions }}</span>
            </section>

            <section class="cell">
              <div class="cell-head">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></svg>
                <h3>{{ t("site2.home.cap.unzip") }}</h3>
              </div>
              <p>{{ t("site2.home.cap.unzipDesc") }}</p>
              <RouterLink class="more" :to="capLinks.unzip">{{ t("site2.home.cap.more") }}
                <svg class="more-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </RouterLink>
              <span class="slug mono">{{ capLinks.unzip }}</span>
            </section>

            <section class="cell">
              <div class="cell-head">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-5 5 5 5 0 0 1-5-5V8zM12 16v5" /></svg>
                <h3>{{ t("site2.home.cap.embed") }}</h3>
              </div>
              <p>{{ t("site2.home.cap.embedDesc") }}</p>
              <RouterLink class="more" :to="capLinks.embed">{{ t("site2.home.cap.more") }}
                <svg class="more-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </RouterLink>
              <span class="slug mono">{{ capLinks.embed }}</span>
            </section>
          </div>
        </div>
      </div>
    </section>

    <!-- ═══ S02 · 场景三卡（锚点目标 #scenarios） ═══ -->
    <section id="scenarios" class="scenarios">
      <div class="shell">
        <header class="head scenario-head">
          <div>
            <h2>{{ t("site2.home.scenarioTitle") }}</h2>
            <p class="sub">{{ t("site2.home.scenarioSub") }}</p>
          </div>
          <FcButton variant="primary" size="lg" @click="goGuide">{{ t("site2.home.ctaDemo") }}</FcButton>
        </header>

        <div class="cards">
          <FcSection class="card" shadow="none" padding="none">
            <div class="art" role="img" :aria-label="t('site2.home.scenario.artNas')">
              <svg width="180" height="120" viewBox="0 0 180 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 104h156" />
                <path d="M28 58L90 24l62 34" />
                <path d="M40 52v44h100V52" />
                <rect x="54" y="58" width="36" height="26" rx="2" />
                <rect x="60" y="62" width="36" height="26" rx="2" />
                <circle cx="69" cy="70" r="2.5" />
                <path d="M64 82l8-9 6 6 4-4 8 8" />
                <rect x="108" y="62" width="42" height="26" rx="3" />
                <circle cx="116" cy="75" r="3" />
                <path d="M124 69h18M124 75h14M124 81h18" />
              </svg>
            </div>
            <h3>{{ t("site2.home.scenario.nas") }}</h3>
            <p class="desc">{{ t("site2.home.scenario.nasDesc") }}</p>
            <div class="uses">
              <div class="uses-cap">{{ t("site2.home.scenario.usesCap") }}</div>
              <div class="use-row"><span class="k">{{ t("site2.home.scenario.keyAddr") }}</span><span class="v mono">http://localhost:5240</span></div>
              <div class="use-row"><span class="k">{{ t("site2.home.scenario.keyMount") }}</span><span class="v mono">/nas</span></div>
            </div>
            <RouterLink class="more card-more" to="/guide">{{ t("site2.home.scenario.more") }}
              <svg class="more-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </RouterLink>
          </FcSection>

          <FcSection class="card" shadow="none" padding="none">
            <div class="art" role="img" :aria-label="t('site2.home.scenario.artTeam')">
              <svg width="180" height="120" viewBox="0 0 180 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 104h156" />
                <rect x="28" y="26" width="64" height="70" rx="2" />
                <path d="M28 58h64" />
                <path d="M40 58V42M50 58V44M60 58V42M70 58V45" />
                <path d="M76 58l5-16" />
                <path d="M40 96V72M48 96V70M56 96V74M64 96V72M74 96V73" />
                <circle cx="130" cy="52" r="9" />
                <path d="M114 88a16 16 0 0 1 32 0" />
                <circle cx="156" cy="64" r="7" />
                <path d="M144 90a12 12 0 0 1 24 0" />
              </svg>
            </div>
            <h3>{{ t("site2.home.scenario.team") }}</h3>
            <p class="desc">{{ t("site2.home.scenario.teamDesc") }}</p>
            <div class="uses">
              <div class="uses-cap">{{ t("site2.home.scenario.usesCap") }}</div>
              <div class="use-row"><span class="k">{{ t("site2.home.scenario.keyBucket") }}</span><span class="v mono">mmagic-demo</span></div>
              <div class="use-row"><span class="k">{{ t("site2.home.scenario.keyPreset") }}</span><span class="v">{{ t("site2.home.scenario.presetReadonly") }}</span></div>
            </div>
            <RouterLink class="more card-more" to="/guide">{{ t("site2.home.scenario.more") }}
              <svg class="more-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </RouterLink>
          </FcSection>

          <FcSection class="card" shadow="none" padding="none">
            <div class="art" role="img" :aria-label="t('site2.home.scenario.artDropbox')">
              <svg width="180" height="120" viewBox="0 0 180 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 104h156" />
                <path d="M90 66V28" />
                <path d="M76 42L90 28l14 14" />
                <path d="M50 72v22a6 6 0 0 0 6 6h68a6 6 0 0 0 6-6V72" />
                <path d="M50 72L36 62M130 72l14-10" />
                <rect x="76" y="80" width="28" height="16" rx="2" />
                <path d="M82 86h16M82 91h10" />
              </svg>
            </div>
            <h3>{{ t("site2.home.scenario.dropbox") }}</h3>
            <p class="desc">{{ t("site2.home.scenario.dropboxDesc") }}</p>
            <div class="uses">
              <div class="uses-cap">{{ t("site2.home.scenario.usesCap") }}</div>
              <div class="use-row"><span class="k">{{ t("site2.home.scenario.keyPreset") }}</span><span class="v">{{ t("site2.home.scenario.presetDropbox") }}</span></div>
              <div class="use-row"><span class="k">{{ t("site2.home.scenario.keyExpiry") }}</span><span class="v">{{ t("site2.home.scenario.expiryValue") }}</span></div>
            </div>
            <RouterLink class="more card-more" to="/guide">{{ t("site2.home.scenario.more") }}
              <svg class="more-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </RouterLink>
          </FcSection>
        </div>
      </div>
    </section>

    <!-- ═══ Footer：信任条复用 + 品牌行 + 链接 ═══ -->
    <footer class="foot">
      <div class="shell foot-trust">
        <div v-for="item in trustItems" :key="item.key" class="trust-cell">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path v-for="(d, i) in item.paths" :key="i" :d="d" />
          </svg>
          <div><strong>{{ item.title }}</strong><span>{{ item.desc }}</span></div>
        </div>
      </div>
      <div class="foot-bar">
        <div class="shell foot-inner">
          <span class="foot-brand">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></svg>
            {{ t("site2.footer.brand") }}
          </span>
          <span class="foot-links">
            <RouterLink to="/docs">{{ t("site2.footer.docs") }}</RouterLink>
            <RouterLink to="/guide">{{ t("site2.footer.demo") }}</RouterLink>
            <span>{{ t("site2.footer.copyright") }}</span>
          </span>
        </div>
      </div>
    </footer>
  </div>
</template>

<style scoped lang="scss">
.home2 {
  // 原型 token → 项目 --app-* 映射（信号色只用于主按钮/当前态/链接）
  --h2-pad-x: 56px;
  --h2-wash: color-mix(in srgb, var(--app-primary) 8%, transparent);
  --h2-signal-deep: color-mix(in srgb, var(--app-primary) 84%, #000);
  --h2-hairline: var(--app-separator);
  --h2-ink-faint: var(--app-text-tertiary);
  color: var(--app-text-primary);
  background: var(--app-bg-page);

  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }

  .shell {
    max-width: var(--site2-container, 1360px);
    margin: 0 auto;
    padding-left: var(--h2-pad-x);
    padding-right: var(--h2-pad-x);
  }

  :focus-visible { outline: 2px solid var(--app-primary); outline-offset: 2px; }

  h1, h2, h3, h4, p, ul { margin: 0; padding: 0; }

  a { color: var(--app-primary); text-decoration: none; }
  a:hover { color: var(--h2-signal-deep); }

  .more {
    display: inline-flex; align-items: baseline; gap: var(--space-sm, 8px);
    font-size: 13px; font-weight: 600;
  }
  .more-ic { width: 13px; height: 13px; transform: translateY(1px); }

  // ───────── Hero ─────────
  .hero { padding: var(--space-2xl, 48px) 0 56px; }
  .hero-grid {
    display: grid; grid-template-columns: 5fr 7fr;
    gap: var(--space-2xl, 48px); align-items: center;
  }
  .hero-copy {
    h1 { font-size: 40px; line-height: 1.16; letter-spacing: -0.5px; font-weight: 700; }
    .lede { margin-top: var(--space-md, 16px); font-size: 16.5px; line-height: 1.65; color: var(--app-text-secondary); }
    .hint {
      margin-top: var(--space-sm, 8px);
      display: flex; align-items: center; gap: 6px;
      font-size: 13px; color: var(--h2-ink-faint);
      svg { width: 14px; height: 14px; flex: none; }
    }
    .cta { margin-top: var(--space-lg, 24px); display: flex; gap: var(--space-md, 16px); flex-wrap: wrap; }
  }

  .steps {
    margin-top: var(--space-2xl, 48px); padding-top: var(--space-lg, 24px);
    border-top: 1px solid var(--h2-hairline);
    display: flex; align-items: flex-start;
  }
  .step { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 76px; flex: none; }
  .step-ic {
    width: 40px; height: 40px; border-radius: var(--radius-full, 9999px);
    display: grid; place-items: center;
    background: var(--app-bg-card); border: 1px solid var(--h2-hairline); color: var(--app-text-secondary);
    svg { width: 18px; height: 18px; }
  }
  .step-name { font-size: 13.5px; font-weight: 600; color: var(--app-text-primary); }
  .step-cap { font-size: 11px; color: var(--h2-ink-faint); white-space: nowrap; }
  .step-line { flex: 1; margin-top: 20px; display: grid; place-items: center; color: var(--h2-ink-faint); min-width: 24px; }

  // ───────── 实景浏览器框 ─────────
  .hero-visual { min-width: 0; }
  .frame-wrap { position: relative; }
  .frame {
    background: var(--app-bg-card);
    border: 1px solid var(--h2-hairline);
    border-radius: var(--app-radius-md, 12px);
    box-shadow: var(--app-shadow-lg);
    overflow: hidden;
  }
  .frame-head {
    height: 38px; display: flex; align-items: center; gap: var(--space-md, 16px);
    padding: 0 14px; background: var(--app-bg-page); border-bottom: 1px solid var(--h2-hairline);
  }
  .dots { display: flex; gap: 6px; }
  .dots i { width: 10px; height: 10px; border-radius: var(--radius-full, 9999px); display: block; }
  .dot-r { background: var(--app-color-danger); }
  .dot-y { background: var(--app-color-warning); }
  .dot-g { background: var(--app-color-success); }
  .addr {
    margin: 0 auto;
    padding: 3px 16px; border: 1px solid var(--h2-hairline); border-radius: var(--radius-full, 9999px);
    background: var(--app-bg-card); font-size: 12px; color: var(--app-text-secondary);
  }
  .frame-body { display: grid; grid-template-columns: 172px minmax(0, 1fr) 220px; height: 352px; }

  .tree { background: var(--app-bg-page); border-right: 1px solid var(--h2-hairline); padding: var(--space-sm, 8px); }
  .tree-cap { font-size: 11px; color: var(--h2-ink-faint); padding: 4px 8px 6px; }
  .trow {
    display: flex; align-items: center; gap: 7px; height: 30px; padding: 0 8px;
    border-radius: var(--app-radius-sm, 8px); font-size: 13px; color: var(--app-text-secondary);
    white-space: nowrap; overflow: hidden;
    svg { width: 15px; height: 15px; color: var(--h2-ink-faint); flex: none; }
    &.on { background: var(--h2-wash); color: var(--app-text-primary); }
    &.on svg { color: var(--app-primary); }
  }

  .list { padding: var(--space-sm, 8px) var(--space-md, 16px); min-width: 0; }
  .list-cap { font-size: 11px; color: var(--h2-ink-faint); padding: 4px 10px 6px; }
  .lrow {
    display: flex; align-items: center; gap: 10px; height: 46px; padding: 0 10px;
    border-radius: var(--app-radius-sm, 8px); font-size: 13px;
    svg { width: 17px; height: 17px; color: var(--h2-ink-faint); flex: none; }
    .name { color: var(--app-text-primary); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta { margin-left: auto; font-size: 11.5px; color: var(--h2-ink-faint); white-space: nowrap; }
  }
  .badge-chain {
    display: inline-flex; align-items: center; gap: 4px; flex: none;
    padding: 2px 8px; border: 1px solid var(--h2-hairline); border-radius: var(--radius-full, 9999px);
    background: var(--app-bg-card); font-size: 11px; color: var(--app-text-secondary);
    svg { width: 11px; height: 11px; color: var(--app-primary); }
  }
  // 关键交互点：第二行 hover 后的 focus 描边（静态画出）
  .focus-demo { outline: 2px solid var(--app-primary); outline-offset: -2px; }

  .preview { border-left: 1px solid var(--h2-hairline); padding: var(--space-md, 16px); overflow: hidden; }
  .preview h4 {
    font-size: 15px; font-weight: 700; padding-bottom: var(--space-sm, 8px);
    margin-bottom: var(--space-sm, 8px); border-bottom: 1px solid var(--h2-hairline);
  }
  .preview p { font-size: 12.5px; line-height: 1.7; color: var(--app-text-secondary); }
  .preview ul { margin-top: var(--space-sm, 8px); padding-left: 18px; }
  .preview li { font-size: 12.5px; line-height: 1.8; color: var(--app-text-secondary); }

  .capsule {
    position: absolute; left: 50%; bottom: 0; transform: translate(-50%, 50%);
    display: inline-flex; align-items: center; gap: 8px;
    padding: 7px 18px; border-radius: var(--radius-full, 9999px);
    background: var(--app-bg-card); border: 1px solid var(--h2-hairline);
    box-shadow: var(--app-shadow-lg);
    font-size: 12.5px; font-weight: 600; color: var(--app-text-primary);
    white-space: nowrap;
    svg { width: 14px; height: 14px; color: var(--app-color-success); }
  }
  .frame-note { margin-top: 20px; text-align: center; font-size: 11.5px; color: var(--h2-ink-faint); }

  // ───────── 信任条 ─────────
  .trust { border-top: 1px solid var(--h2-hairline); background: var(--app-bg-card); }
  .foot-trust { padding-top: var(--space-md, 16px); padding-bottom: var(--space-md, 16px); }
  .trust-grid {
    display: grid; grid-template-columns: 1fr 1fr 1fr;
    padding-top: var(--space-md, 16px); padding-bottom: var(--space-md, 16px);
  }
  .trust-cell {
    display: flex; align-items: center; gap: var(--space-md, 16px);
    padding: 0 var(--space-lg, 24px);
    svg { width: 22px; height: 22px; color: var(--app-text-secondary); flex: none; }
    strong { font-size: 14px; color: var(--app-text-primary); }
    span { font-size: 13px; color: var(--app-text-secondary); }
  }
  .trust-cell + .trust-cell { border-left: 1px solid var(--h2-hairline); }

  // ───────── 功能地图 / 场景公共页头 ─────────
  .map-section, .scenarios { scroll-margin-top: 96px; }
  .head {
    padding: var(--space-2xl, 48px) 0 var(--space-lg, 24px);
    h2 { font-size: 30px; font-weight: 700; letter-spacing: -0.3px; }
    .sub { margin-top: var(--space-sm, 8px); font-size: 14.5px; color: var(--app-text-secondary); }
  }

  // ───────── 功能地图 ─────────
  .band {
    max-width: 720px; margin: 0 auto;
    display: flex; gap: var(--space-md, 16px);
  }
  .chip {
    flex: 1; display: flex; align-items: center; gap: var(--space-md, 16px);
    padding: 12px 18px;
    background: var(--app-bg-card);
    border: 1px solid var(--h2-hairline);
    border-radius: var(--app-radius-md, 12px);
    font-size: 13.5px;
    svg { width: 20px; height: 20px; color: var(--app-text-secondary); flex: none; }
    strong { display: block; font-weight: 600; }
    span { color: var(--h2-ink-faint); font-size: 12.5px; }
  }
  .wires {
    display: block; margin: 0 auto; width: 100%; max-width: 1328px; height: auto;
    color: var(--h2-ink-faint);
  }
  .engine {
    max-width: 720px; margin: 0 auto;
    display: flex; align-items: center; justify-content: center; gap: var(--space-md, 16px);
    padding: 14px 24px;
    background: var(--app-bg-card);
    border: 1px solid var(--h2-hairline);
    border-radius: var(--app-radius-md, 12px);
    box-shadow: var(--app-shadow-md);
    text-align: center;
    svg { width: 22px; height: 22px; color: var(--app-primary); flex: none; }
    strong { font-size: 16px; font-weight: 700; white-space: nowrap; }
    span { font-size: 13px; color: var(--h2-ink-faint); }
  }

  .cells {
    margin-top: var(--space-lg, 24px);
    display: grid; grid-template-columns: 1fr 1fr 1fr;
    border-top: 1px solid var(--h2-hairline);
  }
  .cell { padding: var(--space-md, 16px) var(--space-lg, 24px); min-width: 0; }
  .cell:nth-child(3n+2), .cell:nth-child(3n+3) { border-left: 1px solid var(--h2-hairline); }
  .cell:nth-child(n+4) { border-top: 1px solid var(--h2-hairline); }
  .cell-head {
    display: flex; align-items: center; gap: var(--space-sm, 8px);
    svg { width: 20px; height: 20px; color: var(--app-text-secondary); flex: none; }
    h3 { font-size: 15.5px; font-weight: 700; }
  }
  .cell p { margin-top: var(--space-sm, 8px); font-size: 13px; line-height: 1.7; color: var(--app-text-secondary); }
  .cell .more { margin-top: var(--space-sm, 8px); }
  .slug { display: block; margin-top: var(--space-xs, 4px); font-size: 11px; color: var(--h2-ink-faint); }

  // ───────── 场景三卡 ─────────
  .scenario-head {
    display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-md, 16px);
    flex-wrap: wrap;
  }
  .cards {
    display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--space-lg, 24px);
    padding-bottom: var(--space-2xl, 48px);
  }
  .card {
    display: flex; flex-direction: column;
    padding: var(--space-lg, 24px) var(--space-lg, 24px) var(--space-md, 16px);
    background: var(--app-bg-card);
    border: 1px solid var(--h2-hairline);
    border-radius: var(--app-radius-md, 12px);
  }
  .art {
    height: 156px; flex: none;
    display: grid; place-items: center;
    background: var(--app-bg-page);
    border: 1px solid var(--h2-hairline);
    border-radius: var(--app-radius-sm, 8px);
    color: var(--app-text-secondary);
    margin-bottom: var(--space-md, 16px);
  }
  .card h3 { font-size: 19px; font-weight: 700; }
  .card .desc { margin-top: var(--space-sm, 8px); font-size: 14px; line-height: 1.65; color: var(--app-text-secondary); }
  .uses { margin-top: var(--space-md, 16px); padding-top: var(--space-md, 16px); border-top: 1px solid var(--h2-hairline); }
  .uses-cap { font-size: 12px; color: var(--h2-ink-faint); margin-bottom: var(--space-sm, 8px); }
  .use-row { display: flex; align-items: center; gap: var(--space-sm, 8px); height: 26px; font-size: 13px; }
  .use-row .k { color: var(--h2-ink-faint); flex: none; }
  .use-row .v {
    padding: 2px 8px; border: 1px solid var(--h2-hairline); border-radius: var(--app-radius-sm, 8px);
    background: var(--app-bg-page); font-size: 12.5px; color: var(--app-text-primary);
    white-space: nowrap;
  }
  .card-more { margin-top: auto; padding-top: var(--space-md, 16px); font-size: 14px; }
  .card-more .more-ic { width: 15px; height: 15px; }

  // ───────── Footer ─────────
  .foot { border-top: 1px solid var(--h2-hairline); background: var(--app-bg-card); }
  .foot-bar { border-top: 1px solid var(--h2-hairline); background: var(--app-bg-page); }
  .foot-inner {
    min-height: 46px;
    display: flex; align-items: center; justify-content: space-between;
    gap: var(--space-md, 16px); flex-wrap: wrap;
    padding-top: var(--space-sm, 8px); padding-bottom: var(--space-sm, 8px);
    font-size: 12.5px; color: var(--h2-ink-faint);
  }
  .foot-brand {
    display: inline-flex; align-items: center; gap: var(--space-sm, 8px);
    svg { width: 15px; height: 15px; color: var(--h2-ink-faint); flex: none; }
  }
  .foot-links {
    display: inline-flex; align-items: center; gap: var(--space-md, 16px);
    a { font-size: 12.5px; color: var(--app-text-secondary); }
    a:hover { color: var(--app-primary); }
  }

  // ───────── 动效（reduced-motion 降级为无动画） ─────────
  @media (prefers-reduced-motion: no-preference) {
    .lrow, .trow, a, .chip, .cell { transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease; }
    .lrow:hover { background: var(--h2-wash); }
    .cell:hover { background: var(--app-bg-card); }
    .card { transition: transform 0.18s ease, box-shadow 0.18s ease; }
    .card:hover { transform: translateY(-2px); box-shadow: var(--app-shadow-md); }
  }

  // ───────── 响应式 ─────────
  @media (max-width: 1180px) {
    .frame-body { grid-template-columns: 172px minmax(0, 1fr); }
    .preview { display: none; }
    .cells { grid-template-columns: 1fr 1fr; }
    .cell { border-left: none; }
    .cell:nth-child(even) { border-left: 1px solid var(--h2-hairline); }
    .cell:nth-child(n+3) { border-top: 1px solid var(--h2-hairline); }
  }
  @media (max-width: 900px) {
    .hero { padding-top: var(--space-lg, 24px); }
    .hero-grid { grid-template-columns: 1fr; }
    .hero-copy h1 { font-size: 32px; }
    .trust-grid, .foot-trust { grid-template-columns: 1fr; }
    .trust-cell { padding: var(--space-md, 16px) 0; }
    .trust-cell + .trust-cell { border-left: none; border-top: 1px solid var(--h2-hairline); }
    .cards { grid-template-columns: 1fr; }
    .band { flex-direction: column; }
    .cells { grid-template-columns: 1fr; }
    .cell, .cell:nth-child(even) { border-left: none; }
    .cell:nth-child(n+2) { border-top: 1px solid var(--h2-hairline); }
    .engine { flex-direction: column; padding: 14px 16px; strong { white-space: normal; } }
  }
  @media (max-width: 768px) {
    .home2 { --h2-pad-x: 20px; }
    .steps { flex-wrap: wrap; gap: var(--space-sm, 8px); }
    .step-line { display: none; }
  }
}
</style>
