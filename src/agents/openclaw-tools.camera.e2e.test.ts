import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGateway } = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({ callGateway }));
vi.mock("../media/image-ops.js", () => ({
  getImageMetadata: vi.fn(async () => ({ width: 1, height: 1 })),
  resizeToJpeg: vi.fn(async () => Buffer.from("jpeg")),
}));

import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

const NODE_ID = "mac-1";
const BASE_RUN_INPUT = { action: "run", node: NODE_ID, command: ["echo", "hi"] } as const;

function unexpectedGatewayMethod(method: unknown): never {
  throw new Error(`unexpected method: ${String(method)}`);
}

function getNodesTool(agentSessionKey?: string) {
  const tool = createOpenClawTools({ agentSessionKey }).find(
    (candidate) => candidate.name === "nodes",
  );
  if (!tool) {
    throw new Error("missing nodes tool");
  }
  return tool;
}

async function executeNodes(input: Record<string, unknown>, opts?: { sessionKey?: string }) {
  const sessionKey = opts?.sessionKey ?? `test-${Date.now()}-${Math.random()}`;
  return getNodesTool(sessionKey).execute("call1", input as never);
}

function mockNodeList(commands?: string[]) {
  return {
    nodes: [{ nodeId: NODE_ID, ...(commands ? { commands } : {}) }],
  };
}

beforeEach(() => {
  callGateway.mockReset();
});

describe("nodes camera_snap", () => {
  it("maps jpg payloads to image/jpeg", async () => {
    callGateway.mockImplementation(async ({ method }) => {
      if (method === "node.list") {
        return mockNodeList();
      }
      if (method === "node.invoke") {
        return {
          payload: {
            format: "jpg",
            base64: "aGVsbG8=",
            width: 1,
            height: 1,
          },
        };
      }
      return unexpectedGatewayMethod(method);
    });

    const result = await executeNodes({
      action: "camera_snap",
      node: NODE_ID,
      facing: "front",
    });

    const images = (result.content ?? []).filter((block) => block.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/jpeg");
  });

  it("passes deviceId when provided", async () => {
    callGateway.mockImplementation(async ({ method, params }) => {
      if (method === "node.list") {
        return mockNodeList();
      }
      if (method === "node.invoke") {
        expect(params).toMatchObject({
          command: "camera.snap",
          params: { deviceId: "cam-123" },
        });
        return {
          payload: {
            format: "jpg",
            base64: "aGVsbG8=",
            width: 1,
            height: 1,
          },
        };
      }
      return unexpectedGatewayMethod(method);
    });

    await executeNodes({
      action: "camera_snap",
      node: NODE_ID,
      facing: "front",
      deviceId: "cam-123",
    });
  });
});

describe("nodes screen_snapshot", () => {
  it("maps jpeg payloads to image/jpeg", async () => {
    callGateway.mockImplementation(async ({ method }) => {
      if (method === "node.list") {
        return mockNodeList();
      }
      if (method === "node.invoke") {
        return {
          payload: {
            format: "jpeg",
            base64: "aGVsbG8=",
            width: 1,
            height: 1,
            screenIndex: 0,
          },
        };
      }
      return unexpectedGatewayMethod(method);
    });

    const result = await executeNodes({
      action: "screen_snapshot",
      node: NODE_ID,
      outputFormat: "jpeg",
      screenIndex: 0,
    });

    const images = (result.content ?? []).filter((block) => block.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/jpeg");
  });

  it("normalizes jpg output format to jpeg", async () => {
    callGateway.mockImplementation(async ({ method, params }) => {
      if (method === "node.list") {
        return mockNodeList();
      }
      if (method === "node.invoke") {
        expect(params).toMatchObject({
          command: "screen.snapshot",
          params: {
            format: "jpeg",
            screenIndex: 1,
          },
        });
        return {
          payload: {
            format: "jpg",
            base64: "aGVsbG8=",
            width: 1,
            height: 1,
            screenIndex: 1,
          },
        };
      }
      return unexpectedGatewayMethod(method);
    });

    await executeNodes({
      action: "screen_snapshot",
      node: NODE_ID,
      outputFormat: "jpg",
      screenIndex: 1,
    });
  });
});

describe("nodes screen_click and screen_type", () => {
  it("returns a preflight snapshot when click is requested without fresh observation", async () => {
    const invokeCommands: string[] = [];
    callGateway.mockImplementation(async ({ method, params }) => {
      if (method === "node.list") {
        return mockNodeList(["screen.snapshot", "screen.click", "screen.type"]);
      }
      if (method === "node.invoke") {
        const rawCommand = (params as { command?: unknown })?.command;
        const command = typeof rawCommand === "string" ? rawCommand : "";
        invokeCommands.push(command);
        if (command === "screen.snapshot") {
          return {
            payload: {
              format: "jpeg",
              base64: "aGVsbG8=",
              width: 1,
              height: 1,
              screenIndex: 0,
            },
          };
        }
        if (command === "screen.click") {
          return { payload: { ok: true } };
        }
      }
      return unexpectedGatewayMethod(method);
    });

    const result = await executeNodes(
      {
        action: "screen_click",
        node: NODE_ID,
        x: 100,
        y: 200,
      },
      { sessionKey: "screen-preflight-click" },
    );

    expect(invokeCommands).toEqual(["screen.snapshot"]);
    const textBlocks = (result.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text);
    expect(textBlocks.join("\n")).toContain("PRECONDITION:");
  });

  it("executes click after a snapshot in the same session", async () => {
    const invokeCommands: string[] = [];
    callGateway.mockImplementation(async ({ method, params }) => {
      if (method === "node.list") {
        return mockNodeList(["screen.snapshot", "screen.click"]);
      }
      if (method === "node.invoke") {
        const rawCommand = (params as { command?: unknown })?.command;
        const command = typeof rawCommand === "string" ? rawCommand : "";
        invokeCommands.push(command);
        if (command === "screen.snapshot") {
          return {
            payload: {
              format: "jpeg",
              base64: "aGVsbG8=",
              width: 1,
              height: 1,
              screenIndex: 0,
            },
          };
        }
        if (command === "screen.click") {
          expect(params).toMatchObject({
            command: "screen.click",
            params: { x: 10, y: 20, button: "left" },
          });
          return { payload: { ok: true } };
        }
      }
      return unexpectedGatewayMethod(method);
    });

    const sessionKey = "screen-click-ready";
    await executeNodes(
      { action: "screen_snapshot", node: NODE_ID, screenIndex: 0 },
      { sessionKey },
    );
    invokeCommands.length = 0;
    await executeNodes(
      {
        action: "screen_click",
        node: NODE_ID,
        x: 10,
        y: 20,
      },
      { sessionKey },
    );
    expect(invokeCommands).toEqual(["screen.click"]);
  });

  it("returns a preflight snapshot when typing is requested without fresh observation", async () => {
    const invokeCommands: string[] = [];
    callGateway.mockImplementation(async ({ method, params }) => {
      if (method === "node.list") {
        return mockNodeList(["screen.snapshot", "screen.type"]);
      }
      if (method === "node.invoke") {
        const rawCommand = (params as { command?: unknown })?.command;
        const command = typeof rawCommand === "string" ? rawCommand : "";
        invokeCommands.push(command);
        if (command === "screen.snapshot") {
          return {
            payload: {
              format: "jpeg",
              base64: "aGVsbG8=",
              width: 1,
              height: 1,
              screenIndex: 0,
            },
          };
        }
        if (command === "screen.type") {
          return { payload: { ok: true } };
        }
      }
      return unexpectedGatewayMethod(method);
    });

    const result = await executeNodes(
      {
        action: "screen_type",
        node: NODE_ID,
        text: "hello",
      },
      { sessionKey: "screen-preflight-type" },
    );

    expect(invokeCommands).toEqual(["screen.snapshot"]);
    const textBlocks = (result.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text);
    expect(textBlocks.join("\n")).toContain("PRECONDITION:");
  });
});

describe("nodes run", () => {
  it("passes invoke and command timeouts", async () => {
    callGateway.mockImplementation(async ({ method, params }) => {
      if (method === "node.list") {
        return mockNodeList(["system.run"]);
      }
      if (method === "node.invoke") {
        expect(params).toMatchObject({
          nodeId: NODE_ID,
          command: "system.run",
          timeoutMs: 45_000,
          params: {
            command: ["echo", "hi"],
            cwd: "/tmp",
            env: { FOO: "bar" },
            timeoutMs: 12_000,
          },
        });
        return {
          payload: { stdout: "", stderr: "", exitCode: 0, success: true },
        };
      }
      return unexpectedGatewayMethod(method);
    });

    await executeNodes({
      ...BASE_RUN_INPUT,
      cwd: "/tmp",
      env: ["FOO=bar"],
      commandTimeoutMs: 12_000,
      invokeTimeoutMs: 45_000,
    });
  });

  it("requests approval and retries with allow-once decision", async () => {
    let invokeCalls = 0;
    let approvalId: string | null = null;
    callGateway.mockImplementation(async ({ method, params }) => {
      if (method === "node.list") {
        return mockNodeList(["system.run"]);
      }
      if (method === "node.invoke") {
        invokeCalls += 1;
        if (invokeCalls === 1) {
          throw new Error("SYSTEM_RUN_DENIED: approval required");
        }
        expect(params).toMatchObject({
          nodeId: NODE_ID,
          command: "system.run",
          params: {
            command: ["echo", "hi"],
            runId: approvalId,
            approved: true,
            approvalDecision: "allow-once",
          },
        });
        return { payload: { stdout: "", stderr: "", exitCode: 0, success: true } };
      }
      if (method === "exec.approval.request") {
        expect(params).toMatchObject({
          id: expect.any(String),
          command: "echo hi",
          host: "node",
          timeoutMs: 120_000,
        });
        approvalId =
          typeof (params as { id?: unknown } | undefined)?.id === "string"
            ? ((params as { id: string }).id ?? null)
            : null;
        return { decision: "allow-once" };
      }
      return unexpectedGatewayMethod(method);
    });

    await executeNodes(BASE_RUN_INPUT);
    expect(invokeCalls).toBe(2);
  });

  it("fails with user denied when approval decision is deny", async () => {
    callGateway.mockImplementation(async ({ method }) => {
      if (method === "node.list") {
        return mockNodeList(["system.run"]);
      }
      if (method === "node.invoke") {
        throw new Error("SYSTEM_RUN_DENIED: approval required");
      }
      if (method === "exec.approval.request") {
        return { decision: "deny" };
      }
      return unexpectedGatewayMethod(method);
    });

    await expect(executeNodes(BASE_RUN_INPUT)).rejects.toThrow("exec denied: user denied");
  });

  it("fails closed for timeout and invalid approval decisions", async () => {
    callGateway.mockImplementation(async ({ method }) => {
      if (method === "node.list") {
        return mockNodeList(["system.run"]);
      }
      if (method === "node.invoke") {
        throw new Error("SYSTEM_RUN_DENIED: approval required");
      }
      if (method === "exec.approval.request") {
        return {};
      }
      return unexpectedGatewayMethod(method);
    });
    await expect(executeNodes(BASE_RUN_INPUT)).rejects.toThrow("exec denied: approval timed out");

    callGateway.mockImplementation(async ({ method }) => {
      if (method === "node.list") {
        return mockNodeList(["system.run"]);
      }
      if (method === "node.invoke") {
        throw new Error("SYSTEM_RUN_DENIED: approval required");
      }
      if (method === "exec.approval.request") {
        return { decision: "allow-never" };
      }
      return unexpectedGatewayMethod(method);
    });
    await expect(executeNodes(BASE_RUN_INPUT)).rejects.toThrow(
      "exec denied: invalid approval decision",
    );
  });
});
