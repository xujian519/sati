import { expect, test } from 'bun:test'
import { PROMPT as alwaysOnDiscoveryPlanToolPrompt } from '../tools/AlwaysOnDiscoveryPlanTool/prompt.js'
import {
  buildAlwaysOnDiscoveryPrompt,
  normalizeAlwaysOnDiscoveryPromptLanguage,
} from './alwaysOnDiscoveryPrompt.js'

test('buildAlwaysOnDiscoveryPrompt defaults to English', () => {
  const prompt = buildAlwaysOnDiscoveryPrompt('/tmp/project')

  expect(prompt).toContain('Always-On discovery planning')
  expect(prompt).toContain('recent chats win')
  expect(prompt).toContain('final reply')
  expect(prompt).not.toContain('主动发现规划')
})

test('buildAlwaysOnDiscoveryPrompt supports Simplified Chinese', () => {
  const prompt = buildAlwaysOnDiscoveryPrompt('/tmp/project', 'zh-CN')

  expect(prompt).toContain('Always-On 主动发现规划')
  expect(prompt).toContain('近期聊天语言为准')
  expect(prompt).toContain('最终回复')
  expect(prompt).toContain('## Approval And Execution')
})

test('normalizeAlwaysOnDiscoveryPromptLanguage falls back to English', () => {
  expect(normalizeAlwaysOnDiscoveryPromptLanguage('zh-CN')).toBe('zh-CN')
  expect(normalizeAlwaysOnDiscoveryPromptLanguage('en')).toBe('en')
  expect(normalizeAlwaysOnDiscoveryPromptLanguage('fr')).toBe('en')
  expect(normalizeAlwaysOnDiscoveryPromptLanguage(undefined)).toBe('en')
})

test('AlwaysOnDiscoveryPlan tool prompt explains recent chat language priority', () => {
  expect(alwaysOnDiscoveryPlanToolPrompt).toContain('contextRefs.recentChats')
  expect(alwaysOnDiscoveryPlanToolPrompt).toContain('recent chats win')
  expect(alwaysOnDiscoveryPlanToolPrompt).toContain('saved plan markdown body')
})
