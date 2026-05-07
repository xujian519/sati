export const TungstenTool = {
  name: 'tungsten' as const,
  description: 'Internal Anthropic tool (stub)',
  isEnabled: () => false,
  prompt: '',
  inputJSONSchema: { type: 'object' as const, properties: {} },
  userFacingName: () => 'Tungsten',
  isReadOnly: () => true,
  run: async () => ({ type: 'text' as const, text: 'Not available in dev build' }),
}
