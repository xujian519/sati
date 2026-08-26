export class BoardStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardStoreError";
  }
}
