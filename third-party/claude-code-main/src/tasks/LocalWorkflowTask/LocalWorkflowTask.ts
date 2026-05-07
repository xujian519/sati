export const LocalWorkflowTask = {
  name: 'local-workflow' as const,
  create: () => { throw new Error('Not available in dev build'); },
};
export default LocalWorkflowTask;
