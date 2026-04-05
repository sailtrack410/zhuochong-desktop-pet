import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createPrefixedId, nowIso } from "@zhuochong/shared";
import {
  chatAppendMessageRequestSchema,
  chatHistoryQuerySchema,
  diaryGetQuerySchema,
  diaryListQuerySchema,
  memoryListQuerySchema,
  reminderAcknowledgeRequestSchema,
  reminderCreateRequestSchema,
  reminderListQuerySchema,
  settingsUpdateRequestSchema,
  type ContractErrorCode,
  type ContractMeta,
  type ContractResult,
  type ChatAppendMessageResponse,
  type ChatHistoryDto,
  type ChatSessionDto,
  type DiaryEntryDto,
  type DiaryListDto,
  type MemoryListDto,
  type PetStateSnapshot,
  type ReminderAcknowledgeResponse,
  type ReminderCreateResponse,
  type ReminderListDto,
  type ReminderRuntimeStatusDto,
  type PetStateUpdateRequest,
  type SettingsDto,
  type SettingsUpdateRequest,
  type SystemContextDto,
  petStateUpdateRequestSchema,
} from "@zhuochong/ui-contracts";

import { streamAssistantReply } from "../application/chat-stream.js";
import {
  createDefaultPetStateSnapshot,
  createDefaultSystemContextDto,
  mapConversationMessageToDto,
  mapConversationSessionToDto,
  mapDiaryEntryToDto,
  mapMemoryRecordToDto,
  mapReminderRecordToDto,
  mapPetStateRecordToDto,
  mapSettingsToDto,
  mapSettingsUpdateRequestToPatch,
} from "../application/mappers.js";
import { getReminderRuntimeStatus } from "../application/reminder-scheduler.js";
import type { LocalServiceRuntime } from "../application/runtime.js";
import type { ConversationMessage, PetStateSnapshotRecord } from "../domain/models.js";

const applyCorsHeaders = (response: ServerResponse) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Request-Id, X-Correlation-Id",
  );
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const createMeta = (requestId: string, correlationId?: string): ContractMeta => ({
  contractVersion: "2026-04-v1",
  requestId,
  issuedAt: nowIso(),
  source: "local-service",
  ...(correlationId ? { correlationId } : {}),
});

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void => {
  applyCorsHeaders(response);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload, null, 2));
};

const sendSseHeaders = (response: ServerResponse) => {
  applyCorsHeaders(response);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
};

const writeSseEvent = (
  response: ServerResponse,
  payload: Record<string, unknown>,
) => {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const sendResult = <TData>(
  response: ServerResponse,
  result: ContractResult<TData>,
  statusCode = 200,
): void => {
  sendJson(response, statusCode, result);
};

const failure = (
  requestId: string,
  code: ContractErrorCode,
  message: string,
  options?: {
    correlationId?: string;
    retryable?: boolean;
    statusCode?: number;
    fieldErrors?: Array<{ field: string; reason: string }>;
  },
) => ({
  statusCode: options?.statusCode ?? 400,
  body: {
    ok: false,
    error: {
      code,
      message,
      retryable: options?.retryable ?? false,
      ...(options?.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
    },
    meta: createMeta(requestId, options?.correlationId),
  } satisfies ContractResult<never>,
});

export const createLocalServiceHttpServer = (runtime: LocalServiceRuntime) =>
  createServer(async (request, response) => {
    const requestId = request.headers["x-request-id"]?.toString() ?? "local-request";
    const correlationId = request.headers["x-correlation-id"]?.toString();
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (method === "OPTIONS") {
      applyCorsHeaders(response);
      response.writeHead(204);
      response.end();
      return;
    }

    if (method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        service: "local-service",
        storage: runtime.storage,
        issuedAt: nowIso(),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/settings/get") {
      const settings = await runtime.repositories.settingsRepository.get();
      sendResult<SettingsDto>(response, {
        ok: true,
        data: mapSettingsToDto(settings),
        meta: createMeta(requestId, correlationId),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/settings/update") {
      try {
        const parsed = settingsUpdateRequestSchema.safeParse(await readJsonBody(request));
        if (!parsed.success) {
          const result = failure(
            requestId,
            "VALIDATION_ERROR",
            "settings/update 请求体校验失败。",
            {
              fieldErrors: parsed.error.issues.map((issue) => ({
                field: issue.path.join(".") || "root",
                reason: issue.message,
              })),
              ...(correlationId ? { correlationId } : {}),
            },
          );
          sendResult(response, result.body, result.statusCode);
          return;
        }

        const patch: SettingsUpdateRequest = parsed.data;
        const nextSettings = await runtime.repositories.settingsRepository.updatePatch(
          mapSettingsUpdateRequestToPatch(patch),
        );

        sendResult<SettingsDto>(response, {
          ok: true,
          data: mapSettingsToDto(nextSettings),
          meta: createMeta(requestId, correlationId),
        });
      } catch {
        const result = failure(
          requestId,
          "INTERNAL_ERROR",
          "settings/update 处理失败。",
          {
            statusCode: 500,
            ...(correlationId ? { correlationId } : {}),
          },
        );
        sendResult(response, result.body, result.statusCode);
      }
      return;
    }

    if (method === "GET" && url.pathname === "/chat/session/active") {
      const session = await runtime.repositories.conversationRepository.getOrCreateActiveSession();
      sendResult<ChatSessionDto>(response, {
        ok: true,
        data: mapConversationSessionToDto(session),
        meta: createMeta(requestId, correlationId),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/chat/session/new") {
      try {
        const session = await runtime.repositories.conversationRepository.createNewSession();
        sendResult<ChatSessionDto>(response, {
          ok: true,
          data: mapConversationSessionToDto(session),
          meta: createMeta(requestId, correlationId),
        });
      } catch (error) {
        const result = failure(
          requestId,
          "INTERNAL_ERROR",
          "创建新会话失败。",
          {
            statusCode: 500,
            ...(correlationId ? { correlationId } : {}),
          },
        );
        sendResult(response, result.body, result.statusCode);
      }
      return;
    }

    if (method === "GET" && url.pathname === "/chat/session/stats") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        const result = failure(
          requestId,
          "VALIDATION_ERROR",
          "缺少 sessionId 参数。",
          { ...(correlationId ? { correlationId } : {}) },
        );
        sendResult(response, result.body, result.statusCode);
        return;
      }

      try {
        const stats = await runtime.repositories.conversationRepository.getSessionStats(sessionId);
        sendResult<{ messageCount: number; userTokens: number; assistantTokens: number }>(response, {
          ok: true,
          data: stats,
          meta: createMeta(requestId, correlationId),
        });
      } catch (error) {
        const result = failure(
          requestId,
          "INTERNAL_ERROR",
          "获取会话统计失败。",
          {
            statusCode: 500,
            ...(correlationId ? { correlationId } : {}),
          },
        );
        sendResult(response, result.body, result.statusCode);
      }
      return;
    }

    if (method === "GET" && url.pathname === "/chat/sessions") {
      const limitInput = url.searchParams.get("limit");
      const limit = limitInput ? Number(limitInput) : 10;

      try {
        const sessions = await runtime.repositories.conversationRepository.listSessions({ limit });
        sendResult<ChatSessionDto[]>(response, {
          ok: true,
          data: sessions.map(mapConversationSessionToDto),
          meta: createMeta(requestId, correlationId),
        });
      } catch (error) {
        const result = failure(
          requestId,
          "INTERNAL_ERROR",
          "获取会话列表失败。",
          {
            statusCode: 500,
            ...(correlationId ? { correlationId } : {}),
          },
        );
        sendResult(response, result.body, result.statusCode);
      }
      return;
    }

    if (method === "GET" && url.pathname === "/chat/history") {
      const limitInput = url.searchParams.get("limit");
      const parsed = chatHistoryQuerySchema.safeParse({
        sessionId: url.searchParams.get("sessionId") ?? "",
        beforeMessageId: url.searchParams.get("beforeMessageId") ?? undefined,
        limit: limitInput ? Number(limitInput) : undefined,
      });

      if (!parsed.success) {
        const result = failure(
          requestId,
          "VALIDATION_ERROR",
          "chat/history 查询参数校验失败。",
          {
            fieldErrors: parsed.error.issues.map((issue) => ({
              field: issue.path.join(".") || "root",
              reason: issue.message,
            })),
            ...(correlationId ? { correlationId } : {}),
          },
        );
        sendResult(response, result.body, result.statusCode);
        return;
      }

      const requestedLimit = parsed.data.limit ?? 20;
      const rows = await runtime.repositories.conversationRepository.listMessages({
        sessionId: parsed.data.sessionId,
        limit: requestedLimit + 1,
        ...(parsed.data.beforeMessageId
          ? { beforeMessageId: parsed.data.beforeMessageId }
          : {}),
      });

      const hasMore = rows.length > requestedLimit;
      const messages = (hasMore ? rows.slice(1) : rows).map(
        mapConversationMessageToDto,
      );

      sendResult<ChatHistoryDto>(response, {
        ok: true,
        data: {
          sessionId: parsed.data.sessionId,
          messages,
          hasMore,
        },
        meta: createMeta(requestId, correlationId),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/chat/messages/append") {
      try {
        const parsed = chatAppendMessageRequestSchema.safeParse(await readJsonBody(request));

        if (!parsed.success) {
          const result = failure(
            requestId,
            "VALIDATION_ERROR",
            "chat/messages/append 请求体校验失败。",
            {
              fieldErrors: parsed.error.issues.map((issue) => ({
                field: issue.path.join(".") || "root",
                reason: issue.message,
              })),
              ...(correlationId ? { correlationId } : {}),
            },
          );
          sendResult(response, result.body, result.statusCode);
          return;
        }

        const activeSession =
          await runtime.repositories.conversationRepository.getOrCreateActiveSession();

        if (
          parsed.data.sessionId !== undefined &&
          parsed.data.sessionId !== activeSession.sessionId
        ) {
          const result = failure(
            requestId,
            "NOT_FOUND",
            "当前只支持写入活动会话。",
            {
              statusCode: 404,
              ...(correlationId ? { correlationId } : {}),
            },
          );
          sendResult(response, result.body, result.statusCode);
          return;
        }

        const createdAt = nowIso();
        const message: ConversationMessage = {
          messageId: createPrefixedId("msg"),
          sessionId: activeSession.sessionId,
          role: parsed.data.role,
          source: parsed.data.source,
          text: parsed.data.text,
          createdAt,
          ...(parsed.data.relatedReminderId
            ? { relatedReminderId: parsed.data.relatedReminderId }
            : {}),
        };

        await runtime.repositories.conversationRepository.appendMessage(message);
        await runtime.repositories.conversationRepository.touchSession(
          activeSession.sessionId,
          createdAt,
        );

        sendResult<ChatAppendMessageResponse>(response, {
          ok: true,
          data: {
            session: mapConversationSessionToDto({
              ...activeSession,
              lastMessageAt: createdAt,
            }),
            message: mapConversationMessageToDto(message),
          },
          meta: createMeta(requestId, correlationId),
        });
      } catch {
        const result = failure(
          requestId,
          "INTERNAL_ERROR",
          "chat/messages/append 处理失败。",
          {
            statusCode: 500,
            ...(correlationId ? { correlationId } : {}),
          },
        );
        sendResult(response, result.body, result.statusCode);
      }
      return;
    }

    if (method === "POST" && url.pathname === "/chat/respond/stream") {
      try {
        const body = (await readJsonBody(request)) as {
          sessionId?: unknown;
        };
        if (typeof body.sessionId !== "string" || body.sessionId.trim().length === 0) {
          applyCorsHeaders(response);
          response.writeHead(400, {
            "Content-Type": "application/json; charset=utf-8",
          });
          response.end(
            JSON.stringify({
              ok: false,
              error: {
                code: "VALIDATION_ERROR",
                message: "chat/respond/stream 缺少 sessionId。",
                retryable: false,
              },
              meta: createMeta(requestId, correlationId),
            }),
          );
          return;
        }

        sendSseHeaders(response);
        writeSseEvent(response, {
          type: "started",
          requestId,
        });

        for await (const event of streamAssistantReply(runtime, {
          sessionId: body.sessionId,
        })) {
          if (event.type === "delta") {
            writeSseEvent(response, {
              type: "delta",
              delta: event.delta,
              text: event.text,
            });
            continue;
          }

          writeSseEvent(response, {
            type: "done",
            data: event.response,
          });
        }

        response.end();
      } catch (error) {
        if (!response.headersSent) {
          sendSseHeaders(response);
        }

        writeSseEvent(response, {
          type: "error",
          message: error instanceof Error ? error.message : "流式回复失败。",
        });
        response.end();
      }
      return;
    }

    if (method === "GET" && url.pathname === "/pet/state") {
      const latestSnapshot = await runtime.repositories.petStateRepository.getLatest();
      sendResult<PetStateSnapshot>(response, {
        ok: true,
        data: latestSnapshot
          ? mapPetStateRecordToDto(latestSnapshot)
          : createDefaultPetStateSnapshot(),
        meta: createMeta(requestId, correlationId),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/pet/state/update") {
      try {
        const parsed = petStateUpdateRequestSchema.safeParse(await readJsonBody(request));

        if (!parsed.success) {
          const result = failure(
            requestId,
            "VALIDATION_ERROR",
            "pet/state/update 请求体校验失败。",
            {
              fieldErrors: parsed.error.issues.map((issue) => ({
                field: issue.path.join(".") || "root",
                reason: issue.message,
              })),
              ...(correlationId ? { correlationId } : {}),
            },
          );
          sendResult(response, result.body, result.statusCode);
          return;
        }

        const payload: PetStateUpdateRequest = parsed.data;
        const snapshot: PetStateSnapshotRecord = {
          snapshotId: createPrefixedId("pet"),
          businessState: payload.businessState,
          visualState: payload.visualState,
          mood: payload.mood,
          trigger: payload.trigger,
          createdAt: nowIso(),
        };

        await runtime.repositories.petStateRepository.appendSnapshot(snapshot);

        sendResult<PetStateSnapshot>(response, {
          ok: true,
          data: mapPetStateRecordToDto(snapshot),
          meta: createMeta(requestId, correlationId),
        });
      } catch {
        const result = failure(
          requestId,
          "INTERNAL_ERROR",
          "pet/state/update 处理失败。",
          {
            statusCode: 500,
            ...(correlationId ? { correlationId } : {}),
          },
        );
        sendResult(response, result.body, result.statusCode);
      }
      return;
    }

    if (method === "GET" && url.pathname === "/system/context") {
      const settings = await runtime.repositories.settingsRepository.get();
      sendResult<SystemContextDto>(response, {
        ok: true,
        data: createDefaultSystemContextDto(settings),
        meta: createMeta(requestId, correlationId),
      });
      return;
    }

    // Memory list endpoint
    if (method === "GET" && url.pathname === "/memory/list") {
      const categoryInput = url.searchParams.get("category") ?? undefined;
      const limitInput = url.searchParams.get("limit");
      const parsed = memoryListQuerySchema.safeParse({
        category: categoryInput,
        limit: limitInput ? Number(limitInput) : undefined,
      });

      if (!parsed.success) {
        const result = failure(
          requestId,
          "VALIDATION_ERROR",
          "memory/list 查询参数校验失败。",
          {
            fieldErrors: parsed.error.issues.map((issue) => ({
              field: issue.path.join(".") || "root",
              reason: issue.message,
            })),
            ...(correlationId ? { correlationId } : {}),
          },
        );
        sendResult(response, result.body, result.statusCode);
        return;
      }

      const memories = await runtime.repositories.memoryRepository.listRelevantForChat({
        limit: parsed.data.limit ?? 50,
        ...(parsed.data.category ? { categories: [parsed.data.category] } : {}),
      });

      const memoryDtos = memories
        .filter((m) => m.status === "active")
        .map(mapMemoryRecordToDto);

      sendResult<MemoryListDto>(response, {
        ok: true,
        data: {
          memories: memoryDtos,
          total: memoryDtos.length,
        },
        meta: createMeta(requestId, correlationId),
      });
      return;
    }

    // Diary list endpoint
    if (method === "GET" && url.pathname === "/diary/list") {
      const limitInput = url.searchParams.get("limit");
      const parsed = diaryListQuerySchema.safeParse({
        limit: limitInput ? Number(limitInput) : undefined,
      });

      if (!parsed.success) {
        const result = failure(
          requestId,
          "VALIDATION_ERROR",
          "diary/list 查询参数校验失败。",
          {
            fieldErrors: parsed.error.issues.map((issue) => ({
              field: issue.path.join(".") || "root",
              reason: issue.message,
            })),
            ...(correlationId ? { correlationId } : {}),
          },
        );
        sendResult(response, result.body, result.statusCode);
        return;
      }

      const entries = await runtime.repositories.diaryRepository.listRecent(
        parsed.data.limit ?? 7,
      );

      sendResult<DiaryListDto>(response, {
        ok: true,
        data: {
          entries: entries.map(mapDiaryEntryToDto),
        },
        meta: createMeta(requestId, correlationId),
      });
      return;
    }

    // Diary get by date endpoint
    if (method === "GET" && url.pathname === "/diary/get") {
      const dateInput = url.searchParams.get("date");
      const parsed = diaryGetQuerySchema.safeParse({
        date: dateInput ?? "",
      });

      if (!parsed.success) {
        const result = failure(
          requestId,
          "VALIDATION_ERROR",
          "diary/get 查询参数校验失败。",
          {
            fieldErrors: parsed.error.issues.map((issue) => ({
              field: issue.path.join(".") || "root",
              reason: issue.message,
            })),
            ...(correlationId ? { correlationId } : {}),
          },
        );
        sendResult(response, result.body, result.statusCode);
        return;
      }

      const entry = await runtime.repositories.diaryRepository.getByDate(parsed.data.date);

      sendResult<DiaryEntryDto | null>(response, {
        ok: true,
        data: entry ? mapDiaryEntryToDto(entry) : null,
        meta: createMeta(requestId, correlationId),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/reminder/create") {
      try {
        const parsed = reminderCreateRequestSchema.safeParse(
          await readJsonBody(request),
        );
        if (!parsed.success) {
          const result = failure(
            requestId,
            "VALIDATION_ERROR",
            "reminder/create 请求体校验失败。",
            {
              fieldErrors: parsed.error.issues.map((issue) => ({
                field: issue.path.join(".") || "root",
                reason: issue.message,
              })),
              ...(correlationId ? { correlationId } : {}),
            },
          );
          sendResult(response, result.body, result.statusCode);
          return;
        }

        const dueAtMs = Date.parse(parsed.data.dueAt);
        if (!Number.isFinite(dueAtMs) || dueAtMs <= Date.now()) {
          const result = failure(
            requestId,
            "VALIDATION_ERROR",
            "提醒时间需要晚于当前时间。",
            { ...(correlationId ? { correlationId } : {}) },
          );
          sendResult(response, result.body, result.statusCode);
          return;
        }

        const record = {
          reminderId: createPrefixedId("reminder"),
          category: "task",
          source: "manual",
          priority: "medium",
          status: "pending",
          text: parsed.data.text.trim(),
          triggeredAt: parsed.data.dueAt,
        } as const;

        await runtime.repositories.reminderLogRepository.append(record);

        sendResult<ReminderCreateResponse>(response, {
          ok: true,
          data: mapReminderRecordToDto(record),
          meta: createMeta(requestId, correlationId),
        });
      } catch {
        const result = failure(
          requestId,
          "INTERNAL_ERROR",
          "reminder/create 处理失败。",
          {
            statusCode: 500,
            ...(correlationId ? { correlationId } : {}),
          },
        );
        sendResult(response, result.body, result.statusCode);
      }
      return;
    }

    if (method === "POST" && url.pathname === "/reminder/acknowledge") {
      try {
        const parsed = reminderAcknowledgeRequestSchema.safeParse(
          await readJsonBody(request),
        );
        if (!parsed.success) {
          const result = failure(
            requestId,
            "VALIDATION_ERROR",
            "reminder/acknowledge 请求体校验失败。",
            {
              fieldErrors: parsed.error.issues.map((issue) => ({
                field: issue.path.join(".") || "root",
                reason: issue.message,
              })),
              ...(correlationId ? { correlationId } : {}),
            },
          );
          sendResult(response, result.body, result.statusCode);
          return;
        }

        await runtime.repositories.reminderLogRepository.acknowledge({
          reminderId: parsed.data.reminderId,
          status:
            parsed.data.action === "dismiss"
              ? "dismissed"
              : "opened_chat",
          acknowledgedAt: nowIso(),
        });

        sendResult<ReminderAcknowledgeResponse>(response, {
          ok: true,
          data: {
            reminderId: parsed.data.reminderId,
            acknowledged: true,
          },
          meta: createMeta(requestId, correlationId),
        });
      } catch {
        const result = failure(
          requestId,
          "INTERNAL_ERROR",
          "reminder/acknowledge 处理失败。",
          {
            statusCode: 500,
            ...(correlationId ? { correlationId } : {}),
          },
        );
        sendResult(response, result.body, result.statusCode);
      }
      return;
    }

    if (method === "GET" && url.pathname === "/reminder/list") {
      const limitInput = url.searchParams.get("limit");
      const sinceInput = url.searchParams.get("since");
      const parsed = reminderListQuerySchema.safeParse({
        limit: limitInput ? Number(limitInput) : undefined,
        since: sinceInput ?? undefined,
      });
      if (!parsed.success) {
        const result = failure(
          requestId,
          "VALIDATION_ERROR",
          "reminder/list 查询参数校验失败。",
          {
            fieldErrors: parsed.error.issues.map((issue) => ({
              field: issue.path.join(".") || "root",
              reason: issue.message,
            })),
            ...(correlationId ? { correlationId } : {}),
          },
        );
        sendResult(response, result.body, result.statusCode);
        return;
      }

      const records = await runtime.repositories.reminderLogRepository.listRecent({
        limit: parsed.data.limit ?? 50,
        ...(parsed.data.since ? { since: parsed.data.since } : {}),
      });
      const reminders = records.map(mapReminderRecordToDto);

      sendResult<ReminderListDto>(response, {
        ok: true,
        data: {
          reminders,
          total: reminders.length,
        },
        meta: createMeta(requestId, correlationId),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/reminder/runtime-status") {
      try {
        sendResult<ReminderRuntimeStatusDto>(response, {
          ok: true,
          data: await getReminderRuntimeStatus(runtime),
          meta: createMeta(requestId, correlationId),
        });
      } catch {
        const result = failure(
          requestId,
          "INTERNAL_ERROR",
          "reminder/runtime-status 处理失败。",
          {
            statusCode: 500,
            ...(correlationId ? { correlationId } : {}),
          },
        );
        sendResult(response, result.body, result.statusCode);
      }
      return;
    }

    const result = failure(requestId, "NOT_FOUND", "未找到请求的本地服务接口。", {
      statusCode: 404,
      ...(correlationId ? { correlationId } : {}),
    });
    sendResult(response, result.body, result.statusCode);
  });
