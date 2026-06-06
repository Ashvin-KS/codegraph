import { describe, expect, it } from "vitest";
import path from "node:path";
import { CodeParser } from "../src/server/parser";
import { createLogger } from "../src/server/logger";

const parser = new CodeParser(process.cwd(), createLogger("test-parser"));

describe("CodeParser", () => {
  it("extracts TypeScript functions and call edges", async () => {
    const content = `
export function add(a: number, b: number): number {
  return a + b;
}
export function total(values: number[]): number {
  return values.reduce((sum, value) => add(sum, value), 0);
}
`;
    const parsed = await parser.parseFile(path.join(process.cwd(), "src", "sample.ts"), content);
    expect(parsed?.nodes.map((node) => node.name)).toEqual(expect.arrayContaining(["add", "total"]));
    expect(parsed?.edges.some((edge) => edge.type === "calls")).toBe(true);
  });

  it("handles multi-export curried arrow functions and correct boundaries", async () => {
    const content = `
export const createTryHandleVaultMultiFileChainIntent =
  (deps: any) =>
  async (messageText: string): Promise<boolean> => {
    const {
      isMultiFileVaultIntent,
    } = deps;

    const userInput = (messageText || '').trim();
    if (!userInput) return false;

    if (!userInput) {
      if (!isMultiFileVaultIntent(userInput)) return false;
      return true;
    }
    return true;
  };

export const createHandleAiSend =
  (deps: any) =>
  async (
    messageText: string,
    sendOptions?: {
      displayUserText?: string;
      skipVaultFileListIntent?: boolean;
    }
  ) => {
    const { isAiLoading } = deps;
    if (isAiLoading) return;
    return;
  };
`;
    const parsed = await parser.parseFile(path.join(process.cwd(), "src", "sample.ts"), content);
    expect(parsed?.nodes.map((node) => node.name)).toEqual(expect.arrayContaining(["createTryHandleVaultMultiFileChainIntent", "createHandleAiSend"]));
    const chainNode = parsed?.nodes.find(n => n.name === "createTryHandleVaultMultiFileChainIntent");
    const sendNode = parsed?.nodes.find(n => n.name === "createHandleAiSend");
    
    // Check that the lineStart and lineEnd are exactly matching actual structure
    // createTryHandleVaultMultiFileChainIntent starts at line 2 and ends at line 17
    expect(chainNode?.lineStart).toBe(2);
    expect(chainNode?.lineEnd).toBe(17);

    // createHandleAiSend starts at line 19 and ends at line 31
    expect(sendNode?.lineStart).toBe(19);
    expect(sendNode?.lineEnd).toBe(31);
  });

  it("extracts Rust symbols", async () => {
    const content = `
pub struct ActivityEvent { count: u64 }
pub fn hash_event(event: ActivityEvent) -> u64 { event.count }
pub fn track_event(event: ActivityEvent) -> u64 { hash_event(event) }
`;
    const parsed = await parser.parseFile("sample.rs", content);
    expect(parsed?.nodes.map((node) => node.name)).toEqual(expect.arrayContaining(["ActivityEvent", "hash_event", "track_event"]));
  });

  it("extracts Python functions", async () => {
    const content = `
def normalize(value: str) -> str:
    return value.strip().lower()

def label(value: str) -> str:
    return normalize(value)
`;
    const parsed = await parser.parseFile("sample.py", content);
    expect(parsed?.nodes.map((node) => node.name)).toEqual(expect.arrayContaining(["normalize", "label"]));
  });
});
