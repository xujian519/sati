# 第二步：多模态模型选择项（`fallback.media` 键）前后端完整方案

> 状态：设计稿 | 目标：在桌面端/Web 智能体路由设置中增加显式「多模态模型」选择，语义上把媒体升级候选与故障降级链彻底分离
> 前置：第一步已交付（媒体重路由 `resolveMediaReroute` 纯函数 + `rerouteDecisionForMedia` 就绪 + bootstrap 注释）
> 原则：向后兼容（未配置 `media` 时行为与现状一致）、`media` 键不进故障降级链、成本透明

---

## 1. 语义设计（核心契约）

```
router.fallback:
  media: [moonshot/kimi-k3]        ← 新增：跨场景多模态候选（仅媒体升级）
  default: [文本模型A, 视觉模型]    ← 既有：故障降级链 +（缺省时）媒体升级兜底
  subagent: [...]
  explicit: [...]
```

| 规则 | 说明 |
|---|---|
| **只进媒体升级** | `planFallback`（`runFallbackChain.ts`）按 `scenarioType` 读 `fallback[scenarioType] ?? fallback.default`，`media` 键**结构上天然不进故障降级链**——零改动即隔离 |
| **优先顺序** | 媒体重路由候选 = `media` + `fallback[scenarioType]` + `fallback.default`（去重）——配置了 `media` 就优先用它，否则回退现状 |
| **缺省向后兼容** | 未配置 `media` → `fallbackCandidatesFor` 只读场景键 + default，行为与第一步交付完全一致 |
| **成本透明** | UI 明确标注"多模态模型用于附图/PDF 等请求，视觉/thinking 模型调用成本显著更高" |

---

## 2. 后端改动

### 2.1 `src/router/config/schema.ts` — 类型扩展

```ts
export type RouterFallbackConfig = Partial<Record<RouterScenarioType, RouterModelRef[]>> & {
  maxFallbacks?: number;
  /** 跨场景多模态模型候选：仅用于媒体升级（含图/PDF/音频请求），不参与故障降级。 */
  media?: RouterModelRef[];
};
```

### 2.2 `src/router/config/parseRouterConfig.ts` — `parseFallback` 解析 `media` 键

在 `maxFallbacks` 分支后新增 `media` 分支（`media` 不在 `SCENARIO_KEYS`，类比 `maxFallbacks` 特殊处理）：

```ts
if (key === "media") {
  if (!Array.isArray(value)) {
    diagnostics.push({
      code: "ROUTER_FALLBACK_MEDIA_NOT_ARRAY",
      severity: "fatal",
      path: "router.fallback.media",
      message: "router.fallback.media must be an array of provider/model strings.",
    });
    continue;
  }
  const refs: RouterModelRef[] = [];
  value.forEach((item, index) => {
    const ref = consumeRef(item, `router.fallback.media[${index}]`, modelConfig, diagnostics);
    if (ref) refs.push(ref);
  });
  if (refs.length > 0) fallback.media = refs;
  continue;
}
```

> `SCENARIO_KEYS`（`parseRouterConfig.ts:31`）= `["default", "subagent", "explicit"]` 保持不变；`media` 走独立分支，不进 `SCENARIO_KEYS.includes` 检查（否则会打 `ROUTER_FALLBACK_UNKNOWN_SCENARIO` 警告）。

### 2.3 `src/router/RouterRuntime.ts` — `fallbackCandidatesFor` 加 `media` 优先

```ts
function fallbackCandidatesFor(scenarioType: RouterScenarioType): RouterModelRef[] {
  const candidates: RouterModelRef[] = [];
  const add = (refs: RouterModelRef[] | undefined) => {
    for (const ref of refs ?? []) {
      const id = ref.id || `${ref.provider}/${ref.model}`;
      if (!candidates.some(c => c.provider === ref.provider && c.model === ref.model)) {
        candidates.push({ ...ref, id });
      }
    }
  };
  add(config.fallback?.media);                                  // ① media 优先（多模态候选）
  add((config.fallback as Record<string, RouterModelRef[] | undefined> | undefined)?.[scenarioType]);
  add(config.fallback?.default);                                // ③ default 兜底
  return candidates;
}
```

> 该函数**仅被媒体重路由**（`rerouteDecisionForMedia` → `resolveMediaReroute`）使用；故障降级走 `planFallback`（`runFallbackChain.ts`），`media` 键天然隔离，无需改动。

### 2.4 `scripts/bootstrap-sati-config.mjs` — 配置模板

在 fallback 注释块中追加：

```yaml
  # media：跨场景多模态模型候选（附图/PDF 等请求的模型升级目标）。
  # 与 default/subagent/explicit 不同，media 仅用于媒体升级，不参与故障降级。
  # 未配置时媒体重路由回退到 default 链。视觉/thinking 模型调用成本较高，
  # 请按需配置。
  # media:
  #   - moonshot/kimi-k3
```

### 2.5 测试

| 文件 | 用例 |
|---|---|
| `tests/router/config/parseRouterConfig.spec.ts`（或既有解析测试）| `media` 数组解析成功；`media` 非数组 → `ROUTER_FALLBACK_MEDIA_NOT_ARRAY` fatal；`media` 空数组不写入 |
| `tests/router/utils/mediaReroute.spec.ts`（扩展）| candidates 顺序验证：`media` 候选先于 `default`（`resolveMediaReroute` 是纯函数，直接构造 candidates 顺序即可，无需动 RouterRuntime）|
| 既有 `tests/router/fallback/runFallbackChain.spec.ts` | 回归：`media` 键不影响 `planFallback`（media 不进故障链）|

> 注意：`resolveMediaReroute` 已把 candidates 顺序逻辑独立，`media` 优先语义在 `fallbackCandidatesFor` 里体现；纯函数测试只需验证"candidates 顺序决定命中"，RouterRuntime 集成语义由 parse + candidates 顺序覆盖。

---

## 3. 前端改动

### 3.1 `ui/src/shared/modelOptions.ts` — `ModelOption` 加 `supportsImage`

```ts
export type ModelOption = {
  value: string;
  label: string;
  supportsImage?: boolean;
};
```

`buildModelOptionsForProvider` 填充：
- catalog 模型：`supportsImage: catalogModel.supportsImage`
- 自定义模型（`provider.models` 声明）：从 `userDef.multimodal.input` 含 `"image"` 判断（复用 `modelRefs.ts` 的 `activeModelCapabilities` 思路），默认 `false`

### 3.2 `ui/src/components/settings/view/agentRoute/components/ModelRefInput.tsx` — 显示 🖼

`options` 类型从 `{ value; label }` 扩展为 `ModelOption`，label 渲染 `🖼 ` 前缀（`supportsImage` 为 true 时），并加 `title` 提示"该模型支持图片输入"。

### 3.3 新增 `MultimodalModelEditor.tsx`

`ui/src/components/settings/view/agentRoute/components/MultimodalModelEditor.tsx`：

```tsx
type Props = { config: SatiConfig; onChange: (next: SatiConfig) => void };

export default function MultimodalModelEditor({ config, onChange }: Props) {
  const { t } = useTranslation("settings");
  const media = config.router?.fallback?.media ?? [];
  const modelOpts = useDynamicModelOptions(config);

  const setMedia = (chain: string[]) =>
    onChange(patch(ensureModelRefsConfigured(config, chain), ["router", "fallback", "media"], chain));

  // 渲染：标题 + 说明（成本警示）+ 模型链（复用 ModelRefInput）+ 添加/删除
}
```

- 复用 `RouterFallbackEditor` 的交互范式（ModelRefInput 列表 + 添加/删除），但**无 scenario 键**——就是单个模型列表，写 `fallback.media`
- 说明文案强调成本与用途（i18n）

### 3.4 `ui/src/components/settings/view/agentRoute/components/RouterSection.tsx` — 引入

在 `RouterFallbackEditor` 上方插入 `<MultimodalModelEditor config={config} onChange={onChange} />`（多模态模型是独立语义，应比故障降级链更显眼）。

### 3.5 i18n（`ui/src/i18n/locales/{zh-CN,en}/settings.json`）

在 `satiConfig.panels.router` 下新增：

```jsonc
// zh-CN
"media": {
  "title": "多模态模型",
  "description": "附图 / PDF 等请求的模型升级候选。仅用于媒体理解，不参与主模型失败时的回退。视觉 / thinking 模型调用成本较高，请按需配置。",
  "empty": "未配置多模态模型。媒体请求将回退到回退链查找视觉模型。",
  "addModel": "添加多模态模型",
  "add": "添加"
}
// en（对应翻译）
"media": {
  "title": "Multimodal model",
  "description": "Model upgrade candidates for figure/PDF requests. Used only for media understanding, not for failure fallback. Vision/thinking models cost significantly more — configure as needed.",
  "empty": "No multimodal model configured. Media requests fall back to the fallback chain for a vision-capable model.",
  "addModel": "Add multimodal model",
  "add": "Add"
}
```

> `SatiConfig.router.fallback` 已定义为 `Record<string, string[]>`（`ui/src/components/settings/view/modelPool/types/index.ts:138`），`media` 键**前端类型零改动**。

---

## 4. 实施顺序（每步独立提交）

| 步骤 | 内容 | 提交类型 |
|---|---|---|
| 1 | 后端：schema + parseFallback + 测试 | feat(router) |
| 2 | 后端：`fallbackCandidatesFor` media 优先 + bootstrap 注释 + 测试 | feat(router) |
| 3 | 前端：`ModelOption.supportsImage` + `ModelRefInput` 🖼 | feat(ui) |
| 4 | 前端：`MultimodalModelEditor` + `RouterSection` 引入 + i18n | feat(ui) |

## 5. 验收标准

1. `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` 全绿
2. 后端：`router.fallback.media` 解析正确；未配置 media 时媒体重路由行为与现状一致（回归）
3. 后端：media 候选优先于 default；media 不进 `planFallback` 故障链（测试断言）
4. 前端：路由设置页出现「多模态模型」卡片，选择模型写入 `fallback.media`；模型下拉显示 🖼 图标
5. i18n：zh-CN / en 均有 media 文案

## 6. 风险

| 风险 | 缓解 |
|---|---|
| media 键与场景键语义混淆 | parse 用独立分支 + 注释；UI 独立卡片 + 说明文案 |
| 成本（视觉模型被误配）| UI 说明强调成本；media 不进故障链（结构性隔离）|
| 向后兼容 | 未配置 media → `fallbackCandidatesFor` 只读场景键 + default，零行为变化 |
| 前端 ModelOption 改动波及面 | `supportsImage` 为 optional 字段，其他消费方（agentModel 等）不受影响 |

---

*关联：`docs/vision-routing-minimal-plan.md`（第一步已实施）；代码位置：`src/router/config/`、`src/router/RouterRuntime.ts`、`ui/src/components/settings/view/agentRoute/`、`ui/src/i18n/locales/`。*
