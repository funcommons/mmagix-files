# @mmagix/files-client

mmagix-files 宿主侧接入客户端：裸 `window.postMessage` 双向协议封装，**零运行时依赖**。

- **核心入口**（框架无关）：`createMmagixFilesHost` —— iframe 装载、origin 双闸、reply-by-id、事件订阅
- **Vue 3 入口**：`useMmagixFilesClient` —— 状态机（idle/mounting/ready/error）+ 日志 + 组件卸载自动销毁

## 安装

```bash
npm install @mmagix/files-client
# Vue 3 项目（vue 为 optional peerDependency）
```

## 快速开始（Vue 3）

```vue
<template>
  <iframe ref="iframeRef" style="width:100%;height:80vh" />
</template>

<script setup lang="ts">
import { onMounted } from "vue";
import { useMmagixFilesClient } from "@mmagix/files-client/vue";

const { iframeRef, mount, call, on, status } = useMmagixFilesClient();

onMounted(async () => {
  await mount(
    {
      mode: "workspace",
      v: 1,
      backend: { endpoint, region, bucket, prefix, credentials },
      security: { allowedOrigins: [] }, // 宿主 origin 会自动追加
    },
    "https://your-files-app.example/", // mmagix-files SPA 基址
  );
  await call("navigate", { path: "/reports" });
  on("fileOpened", (p) => console.log("opened", p));
});
</script>
```

## 快速开始（无框架）

```ts
import { createMmagixFilesHost } from "@mmagix/files-client";

const host = createMmagixFilesHost({ iframe: document.querySelector("iframe")!, config, baseUrl });
await host.ready;
const tabs = await host.call<{ list: unknown[] }>("getTabs");
host.on("expired", () => console.log("session expired"));
```

## ⚠️ 头号坑

iframe 侧按「event.origin ∈ config.security.allowedOrigins」白名单校验入站消息：
**白名单不含宿主自身 origin 时，宿主发出的每条命令都会被静默丢弃（全部 4004 超时）**。
`createMmagixFilesHost` / `mount` 已自动把 `window.location.origin` 追加进白名单（去重保序），
宿主业务侧无需手填；换域名部署也无需改代码——自动追加的永远是自己。

## 协议与配置类型

- `MmxWorkspaceConfig` / `MmxSingleFileConfig`（mode 二选一；#config / #file fragment 互斥）
- 事件名全集与载荷：`MmxEventName`（ready / pathChanged / fileOpened / uploadProgress / expired / error …）
- 失败统一 `MmxError`（code：4004 超时 / 4303 未握手 / **4005 宿主侧语义=未装载/contentWindow 不可用**（宿主正本同码 BAD_PARAM=参数非法，同名不同义）/ 5001 origin 拒绝 / 5000 终态；业务码见 §七）
- 配置只走 URL fragment（`#config=` / `#file=` + `encodeURIComponent`），禁 query——fragment 不到服务端/代理日志

完整协议契约：仓库 `../../../docs/design/jsdk-api.md`。

## 构建与测试（本仓内）

```bash
cd frontend/packages/files-client
../../node_modules/.bin/tsc -p tsconfig.build.json   # 产 dist（ESM + d.ts）
cd frontend && pnpm vitest run packages/files-client  # 21 用例（vitest 挂在 frontend 包）
```

发布：改完源码**先重建 dist 再** `npm publish`（`files: ["dist"]`，ESM-only，Node ≥18，vue 为可选 peer）。

## 漂移哨兵

协议常量（NS/PROTOCOL_VERSION/CONFIG_VERSION/DEFAULT_TIMEOUT_MS/DEFAULT_FILES_BASE）与 MmxError 形状
镜像自宿主 `frontend/src/sdk`——`frontend/src/shared/__tests__/clientProtocol.test.ts` 双侧比对，
任一侧单独改动即红（不比信封全形状与事件清单，扩面时哨兵同步扩）。
