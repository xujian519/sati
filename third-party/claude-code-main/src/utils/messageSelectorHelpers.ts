import type {
  ContentBlockParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import {
  BASH_STDERR_TAG,
  BASH_STDOUT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  TASK_NOTIFICATION_TAG,
  TEAMMATE_MESSAGE_TAG,
  TICK_TAG,
} from '../constants/xml.js'
import type { Message, UserMessage } from '../types/message.js'
import {
  isSyntheticMessage,
  isToolUseResultMessage,
} from '../utils/messages.js'

function isTextBlock(block: ContentBlockParam): block is TextBlockParam {
  return block.type === 'text'
}

export function selectableUserMessagesFilter(
  message: Message,
): message is UserMessage {
  if (message.type !== 'user') {
    return false
  }
  if (
    Array.isArray(message.message.content) &&
    message.message.content[0]?.type === 'tool_result'
  ) {
    return false
  }
  if (isSyntheticMessage(message)) {
    return false
  }
  if (message.isMeta) {
    return false
  }
  if (message.isCompactSummary || message.isVisibleInTranscriptOnly) {
    return false
  }

  const content = message.message.content
  const lastBlock =
    typeof content === 'string' ? null : content[content.length - 1]
  const messageText =
    typeof content === 'string'
      ? content.trim()
      : lastBlock && isTextBlock(lastBlock)
        ? lastBlock.text.trim()
        : ''

  if (
    messageText.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
    messageText.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`) ||
    messageText.includes(`<${BASH_STDOUT_TAG}>`) ||
    messageText.includes(`<${BASH_STDERR_TAG}>`) ||
    messageText.includes(`<${TASK_NOTIFICATION_TAG}>`) ||
    messageText.includes(`<${TICK_TAG}>`) ||
    messageText.includes(`<${TEAMMATE_MESSAGE_TAG}`)
  ) {
    return false
  }

  return true
}

export function messagesAfterAreOnlySynthetic(
  messages: Message[],
  fromIndex: number,
): boolean {
  for (let i = fromIndex + 1; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg) {
      continue
    }

    if (isSyntheticMessage(msg)) {
      continue
    }
    if (isToolUseResultMessage(msg)) {
      continue
    }
    if (msg.type === 'progress') {
      continue
    }
    if (msg.type === 'system') {
      continue
    }
    if (msg.type === 'attachment') {
      continue
    }
    if (msg.type === 'user' && msg.isMeta) {
      continue
    }

    if (msg.type === 'assistant') {
      const content = msg.message.content
      if (Array.isArray(content)) {
        const hasMeaningfulContent = content.some(
          block =>
            (block.type === 'text' && block.text.trim()) ||
            block.type === 'tool_use',
        )
        if (hasMeaningfulContent) {
          return false
        }
      }
      continue
    }

    if (msg.type === 'user') {
      return false
    }
  }

  return true
}
