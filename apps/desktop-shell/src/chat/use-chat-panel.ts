import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import type {
  ChatMessageDto,
  ChatSessionDto,
} from "@zhuochong/ui-contracts";

import { formatSessionId, desktopLocalService } from "../services/local-service.js";
import { matchLocalSkill, runLocalSkill } from "./local-skills.js";

const syncIntervalMs = 4_000;
const historyLimit = 24;
const sessionListLimit = 20;
const initialComposerMessage = "Cmd + Enter 发送到当前会话。";

type StreamingPhase = "idle" | "waiting" | "streaming";

type SessionViewPayload = {
  session: ChatSessionDto;
  sessions: ChatSessionDto[];
  history: {
    messages: ChatMessageDto[];
    hasMore: boolean;
  };
};

export const quickPromptPresets = [
  "今天先给我一个简短问候",
  "提醒我下一个阶段该补什么",
  "现在这个桌宠界面还缺什么",
] as const;

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "聊天面板暂时不可用。";

const getLocalSkillPendingText = (skill: ReturnType<typeof matchLocalSkill>) => {
  if (skill?.skillId === "desktop_action") {
    return "消息已送出，正在执行桌面动作。";
  }

  if (skill?.skillId === "manual_reminder") {
    return "消息已送出，正在设置本地提醒。";
  }

  if (skill?.skillId === "productivity_info") {
    return "消息已送出，正在查询系统提醒事项。";
  }

  if (skill?.skillId === "reminder_runtime") {
    return "消息已送出，正在检查提醒运行状态。";
  }

  if (skill?.skillId === "reminder_history") {
    return "消息已送出，正在读取最近提醒记录。";
  }

  return "消息已送出，正在查询本机系统信息。";
};

const getLocalSkillSentText = (skill: ReturnType<typeof matchLocalSkill>) => {
  if (skill?.skillId === "desktop_action") {
    return "已发送，正在执行桌面动作。";
  }

  if (skill?.skillId === "manual_reminder") {
    return "已发送，正在设置本地提醒。";
  }

  if (skill?.skillId === "productivity_info") {
    return "已发送，正在查询系统提醒事项。";
  }

  if (skill?.skillId === "reminder_runtime") {
    return "已发送，正在检查提醒运行状态。";
  }

  if (skill?.skillId === "reminder_history") {
    return "已发送，正在读取最近提醒记录。";
  }

  return "已发送，正在查询本机系统信息。";
};

const formatStatusText = (
  session: ChatSessionDto,
  messages: ChatMessageDto[],
): string => {
  if (messages.length === 0) {
    return `会话 ${formatSessionId(session.sessionId)} 已创建，可以开始第一句。`;
  }

  return `已同步 ${messages.length} 条消息，本地会话持续保存在 local-service。`;
};

const mergeMessages = (
  current: ChatMessageDto[],
  incoming: ChatMessageDto[],
) => {
  const next = [...current];
  const seen = new Set(current.map((message) => message.messageId));

  for (const message of incoming) {
    if (seen.has(message.messageId)) {
      continue;
    }

    next.push(message);
    seen.add(message.messageId);
  }

  return next;
};

const prependMessages = (
  current: ChatMessageDto[],
  older: ChatMessageDto[],
) => {
  if (older.length === 0) {
    return current;
  }

  const seen = new Set(current.map((message) => message.messageId));
  const nextOlder = older.filter((message) => !seen.has(message.messageId));

  return [...nextOlder, ...current];
};

const mergeSessions = (
  current: ChatSessionDto[],
  incoming: ChatSessionDto[],
) => {
  const sessionMap = new Map(current.map((session) => [session.sessionId, session]));

  for (const session of incoming) {
    sessionMap.set(session.sessionId, session);
  }

  return [...sessionMap.values()]
    .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt))
    .slice(0, sessionListLimit);
};

const updateSessionList = (
  current: ChatSessionDto[],
  incoming: ChatSessionDto,
) => {
  const normalizedCurrent = current.map((session) =>
    session.sessionId !== incoming.sessionId && session.status === "active"
      ? { ...session, status: "archived" as const }
      : session,
  );

  return mergeSessions(normalizedCurrent, [incoming]);
};

const waitForNextPaint = () =>
  new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      resolve();
    });
  });

const areSessionsEqual = (
  left: ChatSessionDto[],
  right: ChatSessionDto[],
): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((session, index) => {
    const candidate = right[index];
    return (
      candidate !== undefined &&
      session.sessionId === candidate.sessionId &&
      session.status === candidate.status &&
      session.startedAt === candidate.startedAt &&
      session.lastMessageAt === candidate.lastMessageAt
    );
  });
};

const areMessagesEqual = (
  left: ChatMessageDto[],
  right: ChatMessageDto[],
): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((message, index) => {
    const candidate = right[index];
    return (
      candidate !== undefined &&
      message.messageId === candidate.messageId &&
      message.sessionId === candidate.sessionId &&
      message.role === candidate.role &&
      message.source === candidate.source &&
      message.text === candidate.text &&
      message.createdAt === candidate.createdAt &&
      message.relatedReminderId === candidate.relatedReminderId
    );
  });
};

export const useChatPanel = () => {
  const [activeSession, setActiveSession] = useState<ChatSessionDto | null>(null);
  const [sessions, setSessions] = useState<ChatSessionDto[]>([]);
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [draft, setDraft] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [switchingSessionId, setSwitchingSessionId] = useState<string | null>(null);
  const [composerMessage, setComposerMessage] = useState(initialComposerMessage);
  const [streamingAssistantText, setStreamingAssistantText] = useState("");
  const [streamingPhase, setStreamingPhase] =
    useState<StreamingPhase>("idle");
  const [sendErrorText, setSendErrorText] = useState<string | null>(null);

  const activeSessionRef = useRef<ChatSessionDto | null>(null);
  const sessionsRef = useRef<ChatSessionDto[]>([]);
  const messagesRef = useRef<ChatMessageDto[]>([]);
  const isSendingRef = useRef(false);
  const historyLoadingMoreRef = useRef(false);
  const streamingTextRef = useRef<HTMLParagraphElement | null>(null);

  const updateStreamingTextDOM = (text: string) => {
    if (streamingTextRef.current) {
      streamingTextRef.current.textContent = text;
    }
    setStreamingAssistantText(text);
  };

  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    isSendingRef.current = isSending;
  }, [isSending]);

  useEffect(() => {
    historyLoadingMoreRef.current = historyLoadingMore;
  }, [historyLoadingMore]);

  const readSessionView = useCallback(async (session: ChatSessionDto): Promise<SessionViewPayload> => {
    const [history, nextSessions] = await Promise.all([
      desktopLocalService.getChatHistory({
        sessionId: session.sessionId,
        limit: historyLimit,
      }),
      desktopLocalService.listChatSessions(sessionListLimit),
    ]);

    return {
      session:
        nextSessions.find((candidate) => candidate.sessionId === session.sessionId) ??
        session,
      sessions: nextSessions,
      history,
    };
  }, []);

  const applySessionView = useCallback(
    (
      payload: SessionViewPayload,
      options?: {
        background?: boolean;
      },
    ) => {
      const shouldPreserveLoadedPages =
        Boolean(options?.background) &&
        activeSessionRef.current?.sessionId === payload.session.sessionId &&
        messagesRef.current.length > payload.history.messages.length;
      const nextMessages = shouldPreserveLoadedPages
        ? mergeMessages(messagesRef.current, payload.history.messages)
        : payload.history.messages;
      const nextSessions = options?.background
        ? mergeSessions(sessionsRef.current, payload.sessions)
        : payload.sessions;
      const nextComposerMessage = formatStatusText(payload.session, payload.history.messages);
      const sessionUnchanged =
        activeSessionRef.current?.sessionId === payload.session.sessionId &&
        activeSessionRef.current?.status === payload.session.status &&
        activeSessionRef.current?.startedAt === payload.session.startedAt &&
        activeSessionRef.current?.lastMessageAt === payload.session.lastMessageAt;
      const sessionsUnchanged = areSessionsEqual(sessionsRef.current, nextSessions);
      const historyHasMoreUnchanged = shouldPreserveLoadedPages
        ? historyHasMore === historyHasMore
        : historyHasMore === payload.history.hasMore;
      const messagesUnchanged = areMessagesEqual(messagesRef.current, nextMessages);
      const composerUnchanged = composerMessage === nextComposerMessage;

      if (
        sessionUnchanged &&
        sessionsUnchanged &&
        historyHasMoreUnchanged &&
        messagesUnchanged &&
        composerUnchanged
      ) {
        return;
      }

      startTransition(() => {
        if (!sessionUnchanged) {
          setActiveSession(payload.session);
        }

        if (!sessionsUnchanged) {
          setSessions(nextSessions);
        }

        if (!historyHasMoreUnchanged) {
          setHistoryHasMore(shouldPreserveLoadedPages ? historyHasMore : payload.history.hasMore);
        }

        if (!messagesUnchanged) {
          setMessages(nextMessages);
        }

        if (!composerUnchanged) {
          setComposerMessage(nextComposerMessage);
        }
      });
    },
    [composerMessage, historyHasMore],
  );

  const loadConversation = useCallback(
    async (options?: { background?: boolean; session?: ChatSessionDto }) => {
      if (
        options?.background &&
        (isSendingRef.current || historyLoadingMoreRef.current)
      ) {
        return;
      }

      if (!options?.background) {
        setIsLoading(true);
      }

      try {
        const session =
          options?.session ?? (await desktopLocalService.getActiveChatSession());
        const payload = await readSessionView(session);
        applySessionView(payload, options);
      } catch (error) {
        if (!options?.background) {
          setComposerMessage(getErrorMessage(error));
        }
      } finally {
        if (!options?.background) {
          setIsLoading(false);
        }
      }
    },
    [applySessionView, readSessionView],
  );

  useEffect(() => {
    void loadConversation();

    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }

      void loadConversation({
        background: true,
      });
    }, syncIntervalMs);

    const handleFocus = () => {
      void loadConversation({
        background: true,
      });
    };

    window.addEventListener("focus", handleFocus);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
    };
  }, [loadConversation]);

  const sendMessage = async (input?: string, affinity?: number) => {
    const text = (input ?? draft).trim();
    if (!text || !activeSessionRef.current) {
      return;
    }

    const localSkillRequest = matchLocalSkill(text);

    setIsSending(true);
    setComposerMessage(
      localSkillRequest
        ? getLocalSkillPendingText(localSkillRequest)
        : "消息已送出，桌宠正在组织回复。",
    );
    updateStreamingTextDOM("");
    setStreamingPhase("waiting");
    setSendErrorText(null);

    try {
      const userResponse = await desktopLocalService.appendChatMessage({
        sessionId: activeSessionRef.current.sessionId,
        role: "user",
        source: "chat",
        text,
      });

      startTransition(() => {
        setActiveSession(userResponse.session);
        setSessions((current) => updateSessionList(current, userResponse.session));
        setMessages((current) => mergeMessages(current, [userResponse.message]));
        setDraft("");
        setComposerMessage(
          localSkillRequest
            ? getLocalSkillSentText(localSkillRequest)
            : "已发送，正在接收流式回复。",
        );
      });

      if (localSkillRequest) {
        let localSkillReplyText = "";
        let localSkillStatusText = "已通过本机系统查询完成回复。";

        try {
          if (localSkillRequest.skillId === "manual_reminder") {
            if (
              localSkillRequest.parseError ||
              !localSkillRequest.reminderText ||
              !localSkillRequest.dueAtIso ||
              !localSkillRequest.displayTimeText
            ) {
              localSkillReplyText =
                localSkillRequest.parseError ??
                "这句提醒我还没解析明白，你可以换一种说法。";
              localSkillStatusText = "提醒创建失败。";
            } else {
              const createdReminder = await desktopLocalService.createReminder({
                text: localSkillRequest.reminderText,
                dueAt: localSkillRequest.dueAtIso,
              });
              localSkillReplyText = `好，我会在${localSkillRequest.displayTimeText}提醒你${createdReminder.text}。`;
              localSkillStatusText = "已创建本地提醒。";
            }
          } else if (localSkillRequest.skillId === "explicit_remember") {
            if (
              localSkillRequest.parseError ||
              !localSkillRequest.memoryText
            ) {
              localSkillReplyText =
                localSkillRequest.parseError ??
                "你可以说“记住这个：我喜欢深色模式”。";
              localSkillStatusText = "记忆保存失败。";
            } else {
              const remembered = await desktopLocalService.rememberExplicitMemory({
                text: localSkillRequest.memoryText,
              });
              localSkillReplyText = `好，我记住了：${remembered.memory.valueText}`;
              localSkillStatusText = "已保存显式记忆。";
            }
          } else {
            const localSkillResult = await runLocalSkill(localSkillRequest);
            localSkillReplyText = localSkillResult.replyText;
            localSkillStatusText = localSkillResult.statusText;
          }
        } catch (error) {
          localSkillReplyText =
            error instanceof Error
              ? error.message
              : localSkillRequest.skillId === "manual_reminder"
                ? "我这次没把提醒设置成功。"
                : "我这次没查到系统信息。";
          localSkillStatusText =
            localSkillRequest.skillId === "manual_reminder"
              ? "提醒创建失败。"
              : "系统查询失败。";
        }

        const assistantResponse = await desktopLocalService.appendChatMessage({
          sessionId: userResponse.session.sessionId,
          role: "assistant",
          source: "system",
          text: localSkillReplyText,
        });

        await waitForNextPaint();

        startTransition(() => {
          setActiveSession(assistantResponse.session);
          setSessions((current) =>
            updateSessionList(current, assistantResponse.session)
          );
          setMessages((current) =>
            mergeMessages(current, [assistantResponse.message])
          );
          updateStreamingTextDOM("");
          setStreamingPhase("idle");
          setComposerMessage(localSkillStatusText);
        });

        return;
      }

      const assistantResponse = await desktopLocalService.streamAssistantReply({
        sessionId: userResponse.session.sessionId,
        ...(affinity !== undefined ? { affinity } : {}),
        onDelta: (nextText) => {
          setStreamingPhase("streaming");
          updateStreamingTextDOM(nextText);
        },
      });

      await waitForNextPaint();

      startTransition(() => {
        setActiveSession(assistantResponse.session);
        setSessions((current) => updateSessionList(current, assistantResponse.session));
        setMessages((current) =>
          mergeMessages(current, [assistantResponse.message])
        );
        updateStreamingTextDOM("");
        setStreamingPhase("idle");
        setComposerMessage("本次回复已完成，并写入本地历史。");
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      updateStreamingTextDOM("");
      setStreamingPhase("idle");
      setSendErrorText(errorMessage);
      setComposerMessage(errorMessage);
    } finally {
      setIsSending(false);
    }
  };

  const createNewSession = async () => {
    setIsLoading(true);
    setComposerMessage("正在创建新会话...");

    try {
      const session = await desktopLocalService.createNewSession();
      const payload = await readSessionView(session);
      applySessionView(payload);
    } catch (error) {
      setComposerMessage(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const switchSession = async (sessionId: string) => {
    if (
      sessionId === activeSessionRef.current?.sessionId ||
      isSendingRef.current
    ) {
      return;
    }

    setSwitchingSessionId(sessionId);
    setIsLoading(true);
    setComposerMessage(`正在切换到会话 ${formatSessionId(sessionId)}...`);

    try {
      const session = await desktopLocalService.switchChatSession({ sessionId });
      const payload = await readSessionView(session);
      applySessionView(payload);
    } catch (error) {
      setComposerMessage(getErrorMessage(error));
    } finally {
      setSwitchingSessionId(null);
      setIsLoading(false);
    }
  };

  const loadOlderMessages = async () => {
    const currentSession = activeSessionRef.current;
    const oldestMessage = messages[0];

    if (
      !currentSession ||
      !oldestMessage ||
      historyLoadingMoreRef.current ||
      !historyHasMore
    ) {
      return;
    }

    setHistoryLoadingMore(true);

    try {
      const history = await desktopLocalService.getChatHistory({
        sessionId: currentSession.sessionId,
        limit: historyLimit,
        beforeMessageId: oldestMessage.messageId,
      });

      startTransition(() => {
        setMessages((current) => prependMessages(current, history.messages));
        setHistoryHasMore(history.hasMore);
        setComposerMessage(
          history.messages.length > 0
            ? `已补载 ${history.messages.length} 条更早消息。`
            : "已经到底了，没有更早消息。",
        );
      });
    } catch (error) {
      setComposerMessage(getErrorMessage(error));
    } finally {
      setHistoryLoadingMore(false);
    }
  };

  const getSessionStats = useCallback(async () => {
    if (!activeSessionRef.current) {
      return { messageCount: 0, userTokens: 0, assistantTokens: 0 };
    }

    try {
      return await desktopLocalService.getSessionStats(
        activeSessionRef.current.sessionId,
      );
    } catch {
      return { messageCount: messages.length, userTokens: 0, assistantTokens: 0 };
    }
  }, [messages.length]);

  return {
    activeSession,
    composerMessage,
    createNewSession,
    draft,
    getSessionStats,
    historyHasMore,
    historyLoadingMore,
    isLoading,
    isSending,
    loadOlderMessages,
    messages,
    quickPrompts: quickPromptPresets,
    reloadConversation: loadConversation,
    sendMessage,
    sendErrorText,
    sessions,
    sessionsLoading: isLoading && sessions.length === 0,
    setDraft,
    setStreamingTextRef: (el: HTMLParagraphElement | null) => {
      streamingTextRef.current = el;
    },
    streamingAssistantText,
    streamingPhase,
    switchSession,
    switchingSessionId,
  };
};
