#!/usr/bin/env node
// check-catalog-mirror.mjs
// UI 侧模型目录（ui/src/shared/catalogProviders.ts）与引擎目录
// （src/model/catalog/providers.ts）的一致性门禁。
//
// 为什么需要：设置页的「生效窗口 / 输出上限」提示取自 UI 侧镜像，而**实际生效值**
// 来自引擎 catalog（parseCapabilities 取 catalog → 协议默认）。两边漂移就会重现
// 「输入框提示 200k / 后端生效 128k」这类不一致（issue #449）。
//
// 规则：
//   1. 两边都有的 provider，protocol 必须一致；
//   2. 两边都有的模型，UI 声明的 maxContextTokens / maxOutputTokens / supportsImage
//      必须等于引擎值（UI 未声明该字段 = 不参与对拍）；
//   3. 引擎没有的模型，UI 不得声明 maxContextTokens / maxOutputTokens——后端对这些
//      模型取协议默认，声明数值等于给用户看一个不会生效的数字；
//   4. UI 列的 provider 必须在引擎目录中存在（否则该 provider 根本无法解析）。
//
// 明确不在范围内：
//   - defaultUrl：UI 预填值 vs 引擎默认值（当前 minimax 两边不一致，属待定项，不是
//     「提示值说谎」这一类）；
//   - modelListUrl / requiresApiKey：UI 独有的运行时探测配置；
//   - 引擎有而 UI 未列的模型：选择器省略（用户仍可手填），不是数值不一致。
//
// 为什么用 TS 编译器解析而不是 import：两份都是 .ts（引擎侧还用了
// `{ ...OPENAI_SHARED_MODELS }` 这样的 spread）。.mjs 脚本无法直接 import TS，
// 而本门禁只看字面量数据，用编译器 API 求值即可，也不引入 tsconfig 越界。
//
// 挂载：根 package.json 的 lint 脚本（与其余 check:* 门禁同处）。
// 用法：node scripts/check-catalog-mirror.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_FILE = join(REPO_ROOT, "src", "model", "catalog", "providers.ts");
const UI_FILE = join(REPO_ROOT, "ui", "src", "shared", "catalogProviders.ts");

/** 求值：只接受字面量，遇到任何表达式形态一律抛错（门禁必须看见真实数据）。 */
function evaluateNode(node, file, trail, topLevelValues) {
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element, index) => evaluateNode(element, file, `${trail}[${index}]`, topLevelValues));
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out = {};
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        if (!ts.isIdentifier(property.expression)) {
          throw new Error(`${file}: 不支持的 spread 形态 @${trail}`);
        }
        const spread = topLevelValues.get(property.expression.text);
        if (spread === undefined) {
          throw new Error(`${file}: spread 引用了未知标识符 ${property.expression.text} @${trail}`);
        }
        Object.assign(out, spread);
        continue;
      }
      if (!ts.isPropertyAssignment(property)) {
        throw new Error(`${file}: 不支持的属性形态 @${trail}（只支持 key: 字面量）`);
      }
      const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
      if (key === null) {
        throw new Error(`${file}: 不支持的属性名形态 @${trail}`);
      }
      out[key] = evaluateNode(property.initializer, file, `${trail}.${key}`, topLevelValues);
    }
    return out;
  }
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ""));
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  throw new Error(`${file}: 不支持的取值形态 @${trail}（只支持字符串/数字/布尔/null）`);
}

/** 读取一个 .ts 模块的全部顶层字面量常量（含 export 与非 export，供 spread 解析）。 */
function loadTopLevelLiterals(file) {
  const source = readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);
  const values = new Map();
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
      values.set(declaration.name.text, evaluateNode(declaration.initializer, file, declaration.name.text, values));
    }
  }
  return values;
}

function main() {
  const engine = loadTopLevelLiterals(ENGINE_FILE).get("PROVIDER_CATALOG");
  const uiProviders = loadTopLevelLiterals(UI_FILE).get("CATALOG_PROVIDERS");
  if (!engine || !Array.isArray(uiProviders)) {
    console.error("check-catalog-mirror: 未能从目录文件求值出 PROVIDER_CATALOG / CATALOG_PROVIDERS");
    process.exit(1);
  }

  const violations = [];
  let sharedModels = 0;

  for (const uiProvider of uiProviders) {
    const engineProvider = engine[uiProvider.id];
    if (!engineProvider) {
      violations.push(`provider ${uiProvider.id}：引擎目录没有该 provider（该 provider 无法解析）`);
      continue;
    }
    if (engineProvider.protocol !== uiProvider.protocol) {
      violations.push(`provider ${uiProvider.id}.protocol：UI=${uiProvider.protocol} 引擎=${engineProvider.protocol}`);
    }
    for (const uiModel of uiProvider.models) {
      const engineModel = engineProvider.models[uiModel.id];
      if (!engineModel) {
        for (const field of ["maxContextTokens", "maxOutputTokens"]) {
          if (uiModel[field] !== undefined) {
            violations.push(
              `${uiProvider.id}/${uiModel.id}.${field}=${uiModel[field]}：引擎目录无此模型，` +
                "后端会走协议默认，UI 不应声明该数值",
            );
          }
        }
        continue;
      }
      sharedModels += 1;
      const expected = {
        maxContextTokens: engineModel.capabilities?.maxContextTokens,
        maxOutputTokens: engineModel.capabilities?.maxOutputTokens,
        supportsImage: Array.isArray(engineModel.multimodal?.input)
          ? engineModel.multimodal.input.includes("image")
          : undefined,
      };
      for (const [field, engineValue] of Object.entries(expected)) {
        const uiValue = uiModel[field];
        if (uiValue === undefined || engineValue === undefined) continue;
        if (uiValue !== engineValue) {
          violations.push(`${uiProvider.id}/${uiModel.id}.${field}：UI=${uiValue} 引擎=${engineValue}`);
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error("check-catalog-mirror: UI 目录与引擎目录不一致：");
    for (const violation of violations) console.error(`  ✗ ${violation}`);
    console.error("\nUI 侧数值以引擎为准（引擎才是 parse 期生效的那份）。");
    process.exit(1);
  }
  console.log(`check-catalog-mirror: fresh（${uiProviders.length} 个 provider，${sharedModels} 个共同模型）`);
}

main();
