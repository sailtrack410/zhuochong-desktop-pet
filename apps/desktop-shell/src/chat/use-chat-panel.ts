import { startTransition, useEffect, useRef, useState } from "react";

import type {
  ChatMessageDto,
  ChatSessionDto,
} from "@zhuochong/ui-contracts";

import { desktopLocalService } from "../services/local-service.js";
import { matchLocalSkill, runLocalSkill } from "./local-skills.js";

const syncIntervalMs = 4_000;
const historyLimit = 24;
const initialComposerMessage = "Cmd + Enter 发送到当前会话。";

type StreamingPhase = "idle" | "waiting" | "streaming";

export const quickPromptPresets = [
  "今天先给我一个简短问候",
  "提醒我下一个阶段该补什么",
  "现在这个桌宠界面还缺什么",
] as const;

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "聊天面板暂时不可用。";

const getLocalSkillPendingText = (skill: ReturnType<typeof matchLocalSkill>) => {
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
    return `会话 ${session.sessionId.slice(0, 8)} 已创建，可以开始第一句。`;
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

const waitForNextPaint = () =>
  new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      resolve();
    });
  });

export const useChatPanel = () => {
  const [activeSession, setActiveSession] = useState<ChatSessionDto | null>(null);
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [draft, setDraft] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [composerMessage, setComposerMessage] = useState(initialComposerMessage);
  // 仅用于 panel 模式，float 模式用 DOM ref 直接更新
  const [streamingAssistantText, setStreamingAssistantText] = useState("");
  const [streamingPhase, setStreamingPhase] =
    useState<StreamingPhase>("idle");
  const [sendErrorText, setSendErrorText] = useState<string | null>(null);

  const isSendingRef = useRef(false);
  // float 窗口的流式文本 DOM ref
  const streamingTextRef = useRef<HTMLParagraphElement | null>(null);

  // 直接写入 DOM，绕过 React 状态更新（用于 float 窗口）
  const updateStreamingTextDOM = (text: string) => {
    if (streamingTextRef.current) {
      streamingTextRef.current.textContent = text;
    }
    // 同时更新状态，用于 panel 模式
    setStreamingAssistantText(text);
  };

  useEffect(() => {
    isSendingRef.current = isSending;
  }, [isSending]);

  const loadConversation = async (options?: { background?: boolean }) => {
    if (options?.background && isSendingRef.current) {
      return;
    }

    if (!options?.background) {
      setIsLoading(true);
    }

    try {
      const session = await desktopLocalService.getActiveChatSession();
      const history = await desktopLocalService.getChatHistory({
        sessionId: session.sessionId,
        limit: historyLimit,
      });

      startTransition(() => {
        setActiveSession(session);
        setMessages(history.messages);
        setComposerMessage(formatStatusText(session, history.messages));
      });
    } catch (error) {
      if (!options?.background) {
        setComposerMessage(getErrorMessage(error));
      }
    } finally {
      if (!options?.background) {
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadConversation();

    const intervalId = window.setInterval(() => {
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
  }, []);

  const sendMessage = async (input?: string) => {
    const text = (input ?? draft).trim();
    if (!text) {
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
        ...(activeSession ? { sessionId: activeSession.sessionId } : {}),
        role: "user",
        source: "chat",
        text,
      });

      startTransition(() => {
        setActiveSession(userResponse.session);
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
          setMessages((current) =>
            mergeMessages(current, [
              userResponse.message,
              assistantResponse.message,
            ]),
          );
          updateStreamingTextDOM("");
          setStreamingPhase("idle");
          setComposerMessage(localSkillStatusText);
        });

        return;
      }

      const assistantResponse = await desktopLocalService.streamAssistantReply({
        sessionId: userResponse.session.sessionId,
        onDelta: (nextText) => {
          setStreamingPhase("streaming");
          // 直接更新 DOM，不触发 React 重渲染
          updateStreamingTextDOM(nextText);
        },
      });

      await waitForNextPaint();

      startTransition(() => {
        setActiveSession(assistantResponse.session);
        setMessages((current) =>
          mergeMessages(current, [assistantResponse.message]),
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
      startTransition(() => {
        setActiveSession(session);
        setMessages([]);
        setComposerMessage(`新会话已创建: ${session.sessionId.slice(0, 8)}...`);
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      setComposerMessage(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const getSessionStats = async () => {
    if (!activeSession) {
      return { messageCount: 0, userTokens: 0, assistantTokens: 0 };
    }
    
    try {
      return await desktopLocalService.getSessionStats(activeSession.sessionId);
    } catch {
      return { messageCount: messages.length, userTokens: 0, assistantTokens: 0 };
    }
  };

  return {
    activeSession,
    composerMessage,
    createNewSession,
    draft,
    getSessionStats,
    isLoading,
    isSending,
    messages,
    quickPrompts: quickPromptPresets,
    reloadConversation: loadConversation,
    sendMessage,
    sendErrorText,
    setDraft,
    setStreamingTextRef: (el: HTMLParagraphElement | null) => {
      streamingTextRef.current = el;
    },
    streamingAssistantText,
    streamingPhase,
  };
};
