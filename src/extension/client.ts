import type { AgentContextRequest, AgentContextResponse, EdgeDecisionRequest, ExplainRequest, ExplainResponse, HealthResponse, IndexBatchRequest, IndexFileRequest, IndexLspRequest, Lockfile, OrbitGraphResponse } from "../shared/protocol";
import { AUTH_HEADER } from "../shared/protocol";

export class DuckGraphClient {
  public constructor(private readonly lockfile: Lockfile) {}

  public get workspaceRoot(): string {
    return this.lockfile.workspaceRoot;
  }

  public async health(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/health");
  }

  public async indexFile(request: IndexFileRequest): Promise<void> {
    await this.post("/index", request);
  }

  public async indexBatch(request: IndexBatchRequest): Promise<void> {
    await this.post("/index_batch", request);
  }

  public async indexLsp(request: IndexLspRequest): Promise<void> {
    await this.post("/index_lsp", request);
  }

  public async explain(request: ExplainRequest): Promise<ExplainResponse> {
    return this.post<ExplainResponse>("/explain", request);
  }

  public async orbitGraph(): Promise<OrbitGraphResponse> {
    return this.get<OrbitGraphResponse>("/graph/orbit");
  }

  public async agentContext(request: AgentContextRequest): Promise<AgentContextResponse> {
    return this.post<AgentContextResponse>("/agent/context", request);
  }

  public async agentSubgraph(request: AgentContextRequest): Promise<unknown> {
    return this.post("/agent/subgraph", request);
  }

  public async readSource(request: AgentContextRequest): Promise<unknown> {
    return this.post("/agent/read_source", request);
  }

  public async confirmEdge(request: EdgeDecisionRequest): Promise<void> {
    await this.post("/edge/confirm", request);
  }

  public async dismissEdge(request: EdgeDecisionRequest): Promise<void> {
    await this.post("/edge/dismiss", request);
  }

  public async clearCache(): Promise<void> {
    await this.post("/cache/clear", {});
  }

  public async shutdown(): Promise<void> {
    await this.post("/shutdown", {});
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  private async post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  private async request<T>(path: string, init: RequestInit, timeoutMs = 30000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${this.lockfile.port}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...init.headers,
          [AUTH_HEADER]: this.lockfile.token
        }
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`CodeGraph daemon ${response.status}: ${text}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`CodeGraph daemon timed out on ${path}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Backward-compat alias after rename duckgraph -> codegraph.
export { DuckGraphClient as CodeGraphClient };
