import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";
import {
  parseScreenRecordPayload,
  parseScreenSnapshotPayload,
  screenRecordTempPath,
  screenSnapshotTempPath,
  writeScreenRecordToFile,
  writeScreenSnapshotToFile,
} from "../nodes-screen.js";
import { parseDurationMs } from "../parse-duration.js";
import { runNodesCommand } from "./cli-utils.js";
import { buildNodeInvokeParams, callGatewayCli, nodesCallOpts, resolveNodeId } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

export function registerNodesScreenCommands(nodes: Command) {
  const screen = nodes
    .command("screen")
    .description("Capture screen snapshots or recordings from a paired node");

  nodesCallOpts(
    screen
      .command("snapshot")
      .description("Capture a screen snapshot from a node (prints MEDIA:<path>)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--screen <index>", "Screen index (0 = primary)", "0")
      .option("--format <png|jpg|jpeg>", "Image format", "jpeg")
      .option("--max-width <px>", "Optional max width in pixels")
      .option("--quality <0-1>", "JPEG quality (0-1)")
      .option("--out <path>", "Output path")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 120000)", "120000")
      .action(
        async (
          opts: NodesRpcOpts & {
            out?: string;
            format?: string;
            maxWidth?: string;
            quality?: string;
          },
        ) => {
          await runNodesCommand("screen snapshot", async () => {
            const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
            const screenIndex = Number.parseInt(String(opts.screen ?? "0"), 10);
            const formatRaw = String(opts.format ?? "jpeg")
              .trim()
              .toLowerCase();
            const format =
              formatRaw === "jpg" || formatRaw === "jpeg"
                ? "jpeg"
                : formatRaw === "png"
                  ? "png"
                  : null;
            if (!format) {
              throw new Error("invalid format (png|jpg|jpeg)");
            }
            const maxWidth =
              typeof opts.maxWidth === "string" && opts.maxWidth.trim()
                ? Number.parseInt(opts.maxWidth.trim(), 10)
                : undefined;
            const quality =
              typeof opts.quality === "string" && opts.quality.trim()
                ? Number.parseFloat(opts.quality.trim())
                : undefined;
            const timeoutMs = opts.invokeTimeout
              ? Number.parseInt(String(opts.invokeTimeout), 10)
              : undefined;

            const invokeParams = buildNodeInvokeParams({
              nodeId,
              command: "screen.snapshot",
              params: {
                format,
                screenIndex: Number.isFinite(screenIndex) ? screenIndex : undefined,
                maxWidth:
                  typeof maxWidth === "number" && Number.isFinite(maxWidth) ? maxWidth : undefined,
                quality:
                  typeof quality === "number" && Number.isFinite(quality) ? quality : undefined,
              },
              timeoutMs,
            });

            const raw = await callGatewayCli("node.invoke", opts, invokeParams);
            const res =
              typeof raw === "object" && raw !== null ? (raw as { payload?: unknown }) : {};
            const parsed = parseScreenSnapshotPayload(res.payload);
            const normalizedFormat = parsed.format.toLowerCase();
            const isJpeg = normalizedFormat === "jpg" || normalizedFormat === "jpeg";
            const filePath = opts.out ?? screenSnapshotTempPath({ ext: isJpeg ? "jpg" : "png" });
            const written = await writeScreenSnapshotToFile(filePath, parsed.base64);

            if (opts.json) {
              defaultRuntime.log(
                JSON.stringify(
                  {
                    file: {
                      path: written.path,
                      format: parsed.format,
                      width: parsed.width,
                      height: parsed.height,
                      screenIndex: parsed.screenIndex,
                    },
                  },
                  null,
                  2,
                ),
              );
              return;
            }
            defaultRuntime.log(`MEDIA:${shortenHomePath(written.path)}`);
          });
        },
      ),
    { timeoutMs: 180_000 },
  );

  nodesCallOpts(
    screen
      .command("click")
      .description("Click a screen coordinate on a paired node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .requiredOption("--x <number>", "Global X coordinate in pixels")
      .requiredOption("--y <number>", "Global Y coordinate in pixels")
      .option("--screen <index>", "Screen index (0 = primary)", "0")
      .option("--button <left|right|middle>", "Mouse button", "left")
      .option("--count <n>", "Click count (default 1)", "1")
      .option("--move-only", "Move cursor only, do not click", false)
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 120000)", "120000")
      .action(
        async (opts: NodesRpcOpts & { button?: string; count?: string; moveOnly?: boolean }) => {
          await runNodesCommand("screen click", async () => {
            const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
            const x = Number.parseFloat(String(opts.x ?? ""));
            const y = Number.parseFloat(String(opts.y ?? ""));
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
              throw new Error("x and y must be valid numbers");
            }
            const screenIndex = Number.parseInt(String(opts.screen ?? "0"), 10);
            const clickCount = Number.parseInt(String(opts.count ?? "1"), 10);
            const button = String(opts.button ?? "left")
              .trim()
              .toLowerCase();
            if (button !== "left" && button !== "right" && button !== "middle") {
              throw new Error("invalid button (left|right|middle)");
            }
            const timeoutMs = opts.invokeTimeout
              ? Number.parseInt(String(opts.invokeTimeout), 10)
              : undefined;

            const invokeParams = buildNodeInvokeParams({
              nodeId,
              command: "screen.click",
              params: {
                x,
                y,
                button,
                clickCount: Number.isFinite(clickCount) ? Math.max(1, clickCount) : 1,
                moveOnly: opts.moveOnly === true,
                screenIndex: Number.isFinite(screenIndex) ? screenIndex : 0,
              },
              timeoutMs,
            });

            const raw = await callGatewayCli("node.invoke", opts, invokeParams);
            const res =
              typeof raw === "object" && raw !== null ? (raw as { payload?: unknown }) : {};
            const payload = res.payload ?? { ok: true };
            if (opts.json) {
              defaultRuntime.log(JSON.stringify(payload, null, 2));
              return;
            }
            defaultRuntime.log(JSON.stringify(payload));
          });
        },
      ),
    { timeoutMs: 120_000 },
  );

  nodesCallOpts(
    screen
      .command("type")
      .description("Type text into the focused element on a paired node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .requiredOption("--text <string>", "Text to type")
      .option("--screen <index>", "Screen index (0 = primary)", "0")
      .option("--submit", "Send Return/Enter after typing", false)
      .option("--interval-ms <ms>", "Inter-key delay in ms")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 120000)", "120000")
      .action(
        async (
          opts: NodesRpcOpts & {
            text?: string;
            submit?: boolean;
            intervalMs?: string;
          },
        ) => {
          await runNodesCommand("screen type", async () => {
            const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
            const text = String(opts.text ?? "");
            if (!text.trim()) {
              throw new Error("text required");
            }
            const screenIndex = Number.parseInt(String(opts.screen ?? "0"), 10);
            const intervalMs =
              typeof opts.intervalMs === "string" && opts.intervalMs.trim()
                ? Number.parseFloat(opts.intervalMs.trim())
                : undefined;
            const timeoutMs = opts.invokeTimeout
              ? Number.parseInt(String(opts.invokeTimeout), 10)
              : undefined;

            const invokeParams = buildNodeInvokeParams({
              nodeId,
              command: "screen.type",
              params: {
                text,
                submit: opts.submit === true,
                intervalMs:
                  typeof intervalMs === "number" && Number.isFinite(intervalMs)
                    ? intervalMs
                    : undefined,
                screenIndex: Number.isFinite(screenIndex) ? screenIndex : 0,
              },
              timeoutMs,
            });

            const raw = await callGatewayCli("node.invoke", opts, invokeParams);
            const res =
              typeof raw === "object" && raw !== null ? (raw as { payload?: unknown }) : {};
            const payload = res.payload ?? { ok: true };
            if (opts.json) {
              defaultRuntime.log(JSON.stringify(payload, null, 2));
              return;
            }
            defaultRuntime.log(JSON.stringify(payload));
          });
        },
      ),
    { timeoutMs: 120_000 },
  );

  nodesCallOpts(
    screen
      .command("record")
      .description("Capture a short screen recording from a node (prints MEDIA:<path>)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--screen <index>", "Screen index (0 = primary)", "0")
      .option("--duration <ms|10s>", "Clip duration (ms or 10s)", "10000")
      .option("--fps <fps>", "Frames per second", "10")
      .option("--no-audio", "Disable microphone audio capture")
      .option("--out <path>", "Output path")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 120000)", "120000")
      .action(async (opts: NodesRpcOpts & { out?: string }) => {
        await runNodesCommand("screen record", async () => {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const durationMs = parseDurationMs(opts.duration ?? "");
          const screenIndex = Number.parseInt(String(opts.screen ?? "0"), 10);
          const fps = Number.parseFloat(String(opts.fps ?? "10"));
          const timeoutMs = opts.invokeTimeout
            ? Number.parseInt(String(opts.invokeTimeout), 10)
            : undefined;

          const invokeParams = buildNodeInvokeParams({
            nodeId,
            command: "screen.record",
            params: {
              durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
              screenIndex: Number.isFinite(screenIndex) ? screenIndex : undefined,
              fps: Number.isFinite(fps) ? fps : undefined,
              format: "mp4",
              includeAudio: opts.audio !== false,
            },
            timeoutMs,
          });

          const raw = await callGatewayCli("node.invoke", opts, invokeParams);
          const res = typeof raw === "object" && raw !== null ? (raw as { payload?: unknown }) : {};
          const parsed = parseScreenRecordPayload(res.payload);
          const filePath = opts.out ?? screenRecordTempPath({ ext: parsed.format || "mp4" });
          const written = await writeScreenRecordToFile(filePath, parsed.base64);

          if (opts.json) {
            defaultRuntime.log(
              JSON.stringify(
                {
                  file: {
                    path: written.path,
                    durationMs: parsed.durationMs,
                    fps: parsed.fps,
                    screenIndex: parsed.screenIndex,
                    hasAudio: parsed.hasAudio,
                  },
                },
                null,
                2,
              ),
            );
            return;
          }
          defaultRuntime.log(`MEDIA:${shortenHomePath(written.path)}`);
        });
      }),
    { timeoutMs: 180_000 },
  );
}
