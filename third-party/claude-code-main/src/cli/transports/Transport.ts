export interface Transport {
  send(data: unknown): Promise<void>;
  close(): Promise<void>;
}
export type TransportConfig = Record<string, unknown>;
