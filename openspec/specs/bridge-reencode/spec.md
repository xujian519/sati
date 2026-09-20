# bridge-reencode Specification

## Purpose

让模型在收尾前先把需求用自己的话重述一遍、并给出要求的中间形式（bridge-and-re-encode），降低「答非所问但看着像答了」的概率。实现见 `src/methodology/runtime/components/bridge-reencode.ts`（默认注册进方法论注册表；按推理/分析触发关键词命中注入提示）。

## Requirements

### Requirement: Bridge-and-re-encode prompt is injected when triggered

The methodology component SHALL inject a prompt that instructs the model to (1) restate the requirement in one line in its own words and (2) let the required intermediate form before the conclusion.

#### Scenario: Triggered by reasoning keywords
- **WHEN** the task goal matches reasoning/analysis trigger keywords
- **THEN** the component's `identify` returns a positive score and `execute` returns a prompt containing the re-encode and bridge instructions.

#### Scenario: Prompt contains both instructions
- **WHEN** the component is executed
- **THEN** the returned prompt mentions re-encoding the requirement and forming the intermediate before the conclusion.

### Requirement: Component is registered by default

The component SHALL be part of the default methodology registry so it is available on matching tasks without extra configuration.

#### Scenario: Registered in the default set
- **WHEN** the default methodology components are enumerated
- **THEN** the bridge-reencode component is present.
