export interface A2aAgentInput {
  id: string;
  name: string;
  cardUrl: string;
  enabled: boolean;
  allowPrivateNetwork: boolean;
  timeoutSeconds: number;
  upstreamToken?: string;
}
export interface A2aAgent extends Omit<A2aAgentInput, "upstreamToken"> {
  endpoint: string;
  card: {
    name: string;
    description?: string;
    skills: Array<{ id: string; name: string; description?: string }>;
    supportedInterfaces?: Array<{
      protocolBinding: string;
      protocolVersion: string;
      tenant?: string;
    }>;
  };
  hasUpstreamToken: boolean;
  gatewayPath: string;
  gatewayUrl?: string;
  updatedAt: string;
}
export interface A2aKey {
  id: string;
  name: string;
  agentIds: string[];
  createdAt: string;
}
export interface A2aCall {
  id: string;
  agentId: string;
  keyId: string;
  method: string;
  startedAt: string;
  durationMs: number;
  httpStatus: number | null;
  taskId: string | null;
  contextId: string | null;
  state: string | null;
  error: string | null;
  requestBody: string | null;
  responseBody: string | null;
}
