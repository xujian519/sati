# Agent Note: MCP 校验器注入消音 unknown format 告警

Status: implemented

## Problem

生产日志累计约 3200 行「unknown format "uint32"/"uint64" ignored in schema at path ...」（uint32/uint64 各约 1600 行），与真实告警混在一起难以分辨。来源：Task Master 等外部 MCP server 在 outputSchema 里使用 uint32/uint64 format；MCP SDK 默认的 Ajv 实例（strict:false + validateFormats:true + addFormats）对未注册 format 在每条校验时 console.warn 一次。这些 format 非 JSON Schema 标准、ajv-formats 亦不覆盖，告警无法通过升级依赖消除。

## Decision

MCP Client 构造时注入自定义 `jsonSchemaValidator`（`src/mcp/client/connection.ts` 的 `createJsonSchemaValidator()`，runConnect 处传给 `new Client({...}, { jsonSchemaValidator })`）：

- ajv 配置与 SDK 默认逐项一致（strict:false / validateFormats:true / validateSchema:false / allErrors:true + addFormats），仅额外注册 `formats: { uint32: true, uint64: true }`。`true` = 已注册且恒通过：JSON Schema 规范未定义这两个 format 的校验语义，原行为本就是跳过校验，注册为恒真与之完全等价、仅消音；
- 其余未注册 format 仍会告警（保留「出现新未知 format」的信号）；
- ajv / ajv-formats 从传递依赖提为显式依赖（^8.17.1 / ^3.0.1）——依赖注入面直接使用，不再搭 SDK 便车；
- 每个 Client 一个实例（MCP 连接数少，成本可忽略；共享实例会引入跨连接状态耦合）。
- 类型 workaround 留档于函数注释：ajv/ajv-formats 是 CJS 包但 d.ts 按 ESM 语法声明 default，NodeNext 的 CJS interop 会把 default 导入的类型失真为模块命名空间——ajv 用命名导出 `import { Ajv } from "ajv"` 绕开，ajv-formats 无命名导出、默认导入后断言回模块声明的 default 类型。

## Alternatives considered

- **logger: false / 静音整个 Client 日志** —— 连真实校验错误告警一起消音，丢信号；弃。
- **修外部 MCP server 的 schema（uint32 → integer）** —— 是 npx 拉取的外部包，本地不可控且升级即回退；弃。
- **只用 addFormats、不注册自定义 formats** —— addFormats 不覆盖 uint32/uint64（非标准 format），告警依旧；弃。
- **注册为 false（恒失败）** —— 会让带这些 format 的合法工具输出被拒，且与「忽略未注册 format」的既有行为相反；弃。
- **等 SDK 上游修复** —— 时间不可控；注入点是 SDK 公开选项（ClientOptions.jsonSchemaValidator），本地先行无需 fork（上游修好后再回收）；弃。

## Consequences

- **换来**：日志降噪约 3200 行；其余未知 format 仍可见；校验行为与消音前完全等价（有 smoke 验证：合法输出通过、非法值仍报错、date-time 等真 format 仍校验）。
- **付出**：两个显式依赖 + 一处 CJS/ESM interop 类型断言（成因注释在函数上方）；每个 MCP Client 多一个 ajv 实例。
- 交叉引用源码：`src/mcp/client/connection.ts`。
