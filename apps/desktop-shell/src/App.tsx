import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import type {
  ChatMessageDto,
  ChatSessionDto,
  CompanionProfileSummaryDto,
  DiaryEntryDto,
  MemoryRecordDto,
  ReminderRecordDto,
  ReminderRuntimeStatusDto,
  SettingsDto,
  SettingsUpdateRequest,
} from "@zhuochong/ui-contracts";

import { desktopLocalService, formatSessionId } from "./services/local-service.js";
import {
  publishComposerActivity,
  subscribeComposerActivity,
} from "./chat/composer-sync.js";
import { useChatPanel } from "./chat/use-chat-panel.js";
import { pixelCatManifest } from "./pet/manifest.js";
import {
  defaultPetRuntimeBehaviorSettings,
  getAmbientMotionProfile,
  usePetController,
} from "./pet/use-pet-controller.js";
import {
  publishPetSettingsUpdate,
  subscribePetSettingsUpdates,
} from "./settings/pet-settings-sync.js";
import {
  clearPanelTabRequest,
  consumePanelTabRequest,
  subscribePanelTabRequests,
} from "./panel/panel-tab-sync.js";

export type PanelTab = "chat" | "memory" | "settings" | "status";

import { ClipboardPalette } from "./clipboard/clipboard-palette.js";
import {
  defaultClipboardAccelerator,
  formatAcceleratorLabel,
  getAcceleratorFromKeyEvent,
} from "./clipboard/shortcut.js";
import { useShellAppearance } from "./appearance/use-shell-appearance.js";

const speechBubbleDurationMs = 5_400;
const petComposerMinHeight = 30;
const petComposerMaxHeight = 132;
const petComposerBaseWidth = 212;
const petComposerMaxWidth = 320;
const recentReminderNotificationWindowMs = 20_000;

const formatSessionLabel = (sessionId?: string) =>
  sessionId ? formatSessionId(sessionId) : "未分配";

const formatMessageTime = (value: string) =>
  new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });

const formatSessionTime = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

const getSessionStatusLabel = (status: ChatSessionDto["status"]) =>
  status === "active" ? "当前" : "历史";

const formatRuntimeCheckedAt = (value: string) =>
  new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const getProactivityLevelLabel = (
  value: ReminderRuntimeStatusDto["proactivityLevel"],
) => {
  if (value === "high") {
    return "高";
  }

  if (value === "medium") {
    return "中";
  }

  return "低";
};

const getProactivityLevelHint = (
  value: SettingsDto["behavior"]["proactivityLevel"],
) => {
  if (value === "high") {
    return "高主动：桌宠会更常移动、更晚睡；主动提醒也更积极。";
  }

  if (value === "medium") {
    return "中主动：移动和睡眠频率保持平衡，提醒强度适中。";
  }

  return "低主动：桌宠更少移动、更容易先睡，提醒也会收敛。";
};

const getMotionFrequencyHint = (
  value: SettingsDto["pet"]["motionFrequency"],
) => {
  if (value === "high") {
    return "更常随机走动，也会相对更晚睡。";
  }

  if (value === "low") {
    return "更少走动，也会相对更容易睡下。";
  }

  return "维持当前默认的移动节奏。";
};

const getSleepTendencyHint = (
  value: SettingsDto["pet"]["sleepTendency"],
) => {
  if (value === "late") {
    return "在当前主动性基础上，更偏向晚一点入睡。";
  }

  if (value === "easy") {
    return "在当前主动性基础上，更偏向早一点入睡。";
  }

  return "不额外偏移睡眠时机。";
};

const getMoveDistanceHint = (
  value: SettingsDto["pet"]["moveDistance"],
) => {
  if (value === "long") {
    return "每次随机走动的步幅更大。";
  }

  if (value === "short") {
    return "每次随机走动更克制，落点更近。";
  }

  return "维持当前默认的走动距离。";
};

const getComposerAutoHideHint = (
  value: SettingsDto["pet"]["composerAutoHideSeconds"],
) => `展开后无输入、无回复时，约 ${value} 秒自动收起。`;

const getThemeModeHint = (
  themeMode: ZhuochongShellAppearanceMode,
  resolvedTheme: ZhuochongShellResolvedTheme,
) => {
  if (themeMode === "system") {
    return `跟随 mac 系统外观，当前会按${resolvedTheme === "dark" ? "深色" : "浅色"}显示。`;
  }

  if (themeMode === "dark") {
    return "始终使用深色界面，不跟随系统切换。";
  }

  return "始终使用浅色界面，不跟随系统切换。";
};

const getMetricToneLabel = (tone: "meal" | "energy" | "heart" | "health") => {
  if (tone === "meal") {
    return "饮食";
  }

  if (tone === "energy") {
    return "状态";
  }

  if (tone === "heart") {
    return "关系";
  }

  return "健康";
};


const reminderSilentReasonLabels: Record<
  ReminderRuntimeStatusDto["activeSilentReasons"][number],
  string
> = {
  fullscreen: "前台窗口处于全屏",
  focus_mode: "系统专注模式已开启",
};

type ReminderRuntimeView = {
  tone: "is-active" | "is-silent" | "is-disabled" | "is-pending" | "is-error";
  title: string;
  detail: string;
};

const handleClipboardSubscriptionState = (
  nextState: ZhuochongClipboardState,
  setClipboardState: (value: ZhuochongClipboardState) => void,
  setClipboardShortcutDraft: (value: string) => void,
) => {
  setClipboardState(nextState);
  setClipboardShortcutDraft(nextState.shortcut.accelerator);
};

const getPresentationMode = () => {
  const mode = new URLSearchParams(window.location.search).get("mode");
  if (mode === "panel") return "panel";
  if (mode === "float") return "float";
  if (mode === "clipboard") return "clipboard";
  return "pet";
};

type PresentationMode = ReturnType<typeof getPresentationMode>;

const getAuthorLabel = (
  role: ChatMessageDto["role"],
  petName: string,
) => {
  if (role === "user") {
    return "你";
  }

  if (role === "assistant") {
    return petName;
  }

  return "系统";
};

const findLatestMessage = (
  messages: ChatMessageDto[],
  role: ChatMessageDto["role"],
) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === role) {
      return message;
    }
  }

  return null;
};

const evaluateChatAffinityMessage = (message: ChatMessageDto) =>
  message.role === "user" && message.source === "chat";

const isProactiveReminderMessage = (
  message: ChatMessageDto,
  reminderRecords: Map<string, ReminderRecordDto>,
) => {
  if (message.source !== "reminder" || !message.relatedReminderId) {
    return false;
  }

  const reminder = reminderRecords.get(message.relatedReminderId);
  if (!reminder) {
    return true;
  }

  return (
    reminder.source === "time" ||
    reminder.source === "idle" ||
    reminder.source === "battery"
  );
};

const shouldRenderChatMessage = (
  message: ChatMessageDto,
  reminderRecords: Map<string, ReminderRecordDto>,
) => {
  if (message.source !== "reminder") {
    return true;
  }

  return !isProactiveReminderMessage(message, reminderRecords);
};

const getLongestLine = (value: string) =>
  value
    .split("\n")
    .reduce(
      (longest, current) =>
        current.length > longest.length ? current : longest,
      "",
    );

const randomBetween = (min: number, max: number) =>
  Math.round(min + Math.random() * Math.max(0, max - min));

type PetRuntimeSettings = typeof defaultPetRuntimeBehaviorSettings & {
  composerAutoHideSeconds: SettingsDto["pet"]["composerAutoHideSeconds"];
};

const defaultPetRuntimeSettings: PetRuntimeSettings = {
  ...defaultPetRuntimeBehaviorSettings,
  composerAutoHideSeconds: 9,
};

const extractPetRuntimeSettings = (
  settings: SettingsDto | null | undefined,
): PetRuntimeSettings => ({
  proactivityLevel:
    settings?.behavior.proactivityLevel ??
    defaultPetRuntimeSettings.proactivityLevel,
  motionFrequency:
    settings?.pet.motionFrequency ?? defaultPetRuntimeSettings.motionFrequency,
  sleepTendency:
    settings?.pet.sleepTendency ?? defaultPetRuntimeSettings.sleepTendency,
  moveDistance:
    settings?.pet.moveDistance ?? defaultPetRuntimeSettings.moveDistance,
  composerAutoHideSeconds:
    settings?.pet.composerAutoHideSeconds ??
    defaultPetRuntimeSettings.composerAutoHideSeconds,
});

const MainApp = ({
  presentationMode,
}: {
  presentationMode: Exclude<PresentationMode, "clipboard">;
}) => {
  const isPanelMode = presentationMode === "panel";
  const isFloatMode = presentationMode === "float";
  const isPetMode = presentationMode === "pet";
  const { appearance } = useShellAppearance();
  const [petRuntimeSettings, setPetRuntimeSettings] = useState<PetRuntimeSettings>(
    defaultPetRuntimeSettings,
  );
  const {
    actionAvailability,
    affinityCooldownRemainingMs,
    affinityStage,
    consumePetClick,
    currentAsset,
    dragHint,
    eventLogs,
    facingDirection,
    feedPet,
    handlePointerCancel,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleChatAffinity,
    isDragging,
    metrics,
    petName,
    pixelScale,
    playWithPet,
    resources,
    restPet,
    statusText,
    visualState,
    wanderRandomly,
  } = usePetController(petRuntimeSettings);
  const ambientMotionProfile = useMemo(
    () => getAmbientMotionProfile(petRuntimeSettings),
    [petRuntimeSettings],
  );
  const petComposerAutoHideDelayMs =
    petRuntimeSettings.composerAutoHideSeconds * 1_000;
  const {
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
    sendMessage,
    sendErrorText,
    sessions,
    sessionsLoading,
    setDraft,
    setStreamingTextRef,
    streamingAssistantText,
    streamingPhase,
    switchSession,
    switchingSessionId,
  } = useChatPanel();

  const panelComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const petComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const petComposerMeasureRef = useRef<HTMLSpanElement | null>(null);
  const clipboardShortcutInputRef = useRef<HTMLInputElement | null>(null);
  const floatContainerRef = useRef<HTMLElement | null>(null);
  const lastAssistantMessageIdRef = useRef<string | null>(null);
  const lastUserMessageIdRef = useRef<string | null>(null);
  const speechTimerRef = useRef<number | null>(null);
  const composerAutoHideTimerRef = useRef<number | null>(null);
  const ambientMoveTimerRef = useRef<number | null>(null);
  const reopenComposerAfterSpeechRef = useRef(false);
  const pointerPositionRef = useRef<{
    x: number;
    y: number;
  } | null>(null);
  const notifiedReminderIdsRef = useRef<Set<string>>(new Set());
  const hasPrimedReminderNotificationsRef = useRef(false);

  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [isPetComposerMultiline, setIsPetComposerMultiline] = useState(false);
  const [isPetComposerFocused, setIsPetComposerFocused] = useState(false);
  const [isPetComposerComposing, setIsPetComposerComposing] = useState(false);
  const [remoteComposerActivity, setRemoteComposerActivity] = useState({
    hasText: false,
    isFocused: false,
    isComposing: false,
  });
  const [petComposerWidth, setPetComposerWidth] =
    useState(petComposerBaseWidth);
  const [speechBubbleText, setSpeechBubbleText] = useState<string | null>(null);
  const [sessionStats, setSessionStats] = useState<{
    messageCount: number;
    userTokens: number;
    assistantTokens: number;
  }>({ messageCount: 0, userTokens: 0, assistantTokens: 0 });
  const [acknowledgingReminderIds, setAcknowledgingReminderIds] = useState<
    Set<string>
  >(new Set());
  const [acknowledgedReminderIds, setAcknowledgedReminderIds] = useState<
    Set<string>
  >(new Set());
  const [reminderRecordsById, setReminderRecordsById] = useState(
    () => new Map<string, ReminderRecordDto>(),
  );

  const latestAssistantMessage = useMemo(
    () => findLatestMessage(messages, "assistant"),
    [messages],
  );
  const reminderMessageIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) {
      if (message.source !== "reminder" || !message.relatedReminderId) {
        continue;
      }

      ids.add(message.relatedReminderId);
    }

    return Array.from(ids);
  }, [messages]);

  const activeSpeechText =
    streamingPhase === "streaming" ? null : speechBubbleText;
  const isSpeechStreaming = streamingPhase === "streaming" || streamingPhase === "waiting";
  // 控制台模式下不显示浮动窗口，只在桌宠模式下显示
  const isPetWindowExpanded =
    !isPanelMode && !isFloatMode && (isComposerOpen || Boolean(activeSpeechText) || isSpeechStreaming);
  const petSizingStyle = useMemo(() => {
    const safePixelScale = Math.max(1, Math.min(4, pixelScale));
    const spriteSize = 20 + safePixelScale * pixelCatManifest.frameSize.width;
    const buttonSize = spriteSize + 24;
    const shadowWidth = Math.round(spriteSize * 0.75);
    const shadowHeight = Math.max(12, Math.round(spriteSize * 0.155));

    return {
      "--pet-button-size": `${buttonSize}px`,
      "--pet-sprite-size": `${spriteSize}px`,
      "--pet-shadow-width": `${shadowWidth}px`,
      "--pet-shadow-height": `${shadowHeight}px`,
      "--pet-shadow-bottom": `${shadowHeight}px`,
    } as CSSProperties;
  }, [pixelScale]);

  useEffect(() => {
    return () => {
      if (speechTimerRef.current !== null) {
        window.clearTimeout(speechTimerRef.current);
      }

      if (composerAutoHideTimerRef.current !== null) {
        window.clearTimeout(composerAutoHideTimerRef.current);
      }

      if (ambientMoveTimerRef.current !== null) {
        window.clearTimeout(ambientMoveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const latestUserChatMessage = [...messages]
      .reverse()
      .find((message) => evaluateChatAffinityMessage(message));

    if (!latestUserChatMessage) {
      return;
    }

    if (lastUserMessageIdRef.current === latestUserChatMessage.messageId) {
      return;
    }

    lastUserMessageIdRef.current = latestUserChatMessage.messageId;
    const result = handleChatAffinity(latestUserChatMessage.text);
    if (result.delta !== 0) {
      setSpeechBubbleText(result.reason);
      if (speechTimerRef.current !== null) {
        window.clearTimeout(speechTimerRef.current);
      }
      speechTimerRef.current = window.setTimeout(() => {
        speechTimerRef.current = null;
        setSpeechBubbleText(null);
      }, 3_800);
    }
  }, [handleChatAffinity, messages]);

  useEffect(() => {
    if (
      isPanelMode ||
      !latestAssistantMessage ||
      streamingPhase !== "idle"
    ) {
      return;
    }

    if (lastAssistantMessageIdRef.current === latestAssistantMessage.messageId) {
      return;
    }

    lastAssistantMessageIdRef.current = latestAssistantMessage.messageId;
    setSpeechBubbleText(latestAssistantMessage.text);

    if (speechTimerRef.current !== null) {
      window.clearTimeout(speechTimerRef.current);
    }

    speechTimerRef.current = window.setTimeout(() => {
      speechTimerRef.current = null;
      setSpeechBubbleText(null);
      if (!isPanelMode && reopenComposerAfterSpeechRef.current) {
        reopenComposerAfterSpeechRef.current = false;
        setIsComposerOpen(true);
        focusPetComposer();
      }
    }, speechBubbleDurationMs);
  }, [isPanelMode, latestAssistantMessage, streamingPhase]);

  useEffect(() => {
    if (streamingPhase === "idle") {
      return;
    }

    if (speechTimerRef.current !== null) {
      window.clearTimeout(speechTimerRef.current);
      speechTimerRef.current = null;
    }

    setSpeechBubbleText(null);
  }, [streamingPhase]);

  useEffect(() => {
    if (isLoading || hasPrimedReminderNotificationsRef.current) {
      return;
    }

    const nowMs = Date.now();
    const recentReminderMessages: ChatMessageDto[] = [];

    for (const message of messages) {
      if (message.source !== "reminder" || !message.relatedReminderId) {
        continue;
      }

      notifiedReminderIdsRef.current.add(message.relatedReminderId);

      if (isProactiveReminderMessage(message, reminderRecordsById)) {
        continue;
      }

      const createdAtMs = Date.parse(message.createdAt);
      if (Number.isFinite(createdAtMs) && nowMs - createdAtMs <= recentReminderNotificationWindowMs) {
        recentReminderMessages.push(message);
      }
    }

    hasPrimedReminderNotificationsRef.current = true;

    for (const message of recentReminderMessages) {
      void window.zhuochong?.desktop.showSystemNotification?.({
        notificationId: message.relatedReminderId!,
        title: `${petName} 提醒`,
        body: message.text,
      });
    }
  }, [isLoading, messages, petName, reminderRecordsById]);

  useEffect(() => {
    if (isLoading || !hasPrimedReminderNotificationsRef.current) {
      return;
    }

    for (const message of messages) {
      if (message.source !== "reminder" || !message.relatedReminderId) {
        continue;
      }

      if (notifiedReminderIdsRef.current.has(message.relatedReminderId)) {
        continue;
      }

      notifiedReminderIdsRef.current.add(message.relatedReminderId);
      if (isProactiveReminderMessage(message, reminderRecordsById)) {
        continue;
      }

      void window.zhuochong?.desktop.showSystemNotification?.({
        notificationId: message.relatedReminderId,
        title: `${petName} 提醒`,
        body: message.text,
      });
    }
  }, [isLoading, messages, petName, reminderRecordsById]);

  useEffect(() => {
    if (isPanelMode || !sendErrorText) {
      return;
    }

    setSpeechBubbleText(sendErrorText);

    if (speechTimerRef.current !== null) {
      window.clearTimeout(speechTimerRef.current);
    }

    speechTimerRef.current = window.setTimeout(() => {
      speechTimerRef.current = null;
      setSpeechBubbleText(null);
    }, 3_800);
  }, [isPanelMode, sendErrorText]);

  useEffect(() => {
    if (!isComposerOpen) {
      return;
    }

    const input = petComposerRef.current;
    const measure = petComposerMeasureRef.current;
    if (!input || !measure) {
      return;
    }

    const measuringText =
      getLongestLine(draft || input.placeholder || "直接对它说话") || " ";
    measure.textContent = measuringText;
    const measuredWidth = Math.ceil(measure.getBoundingClientRect().width);
    const nextWidth = Math.min(
      petComposerMaxWidth,
      Math.max(petComposerBaseWidth, measuredWidth + 42),
    );
    setPetComposerWidth(nextWidth);

    input.style.height = "0px";
    const nextHeight = Math.min(petComposerMaxHeight, input.scrollHeight);
    input.style.height = `${Math.max(petComposerMinHeight, nextHeight)}px`;
    input.style.overflowY = "hidden";
    setIsPetComposerMultiline(nextHeight > petComposerMinHeight + 4);
  }, [draft, isComposerOpen]);

  useEffect(() => {
    const unsubscribeComposerActivity = subscribeComposerActivity((payload) => {
      setRemoteComposerActivity(payload);
    });

    return () => {
      unsubscribeComposerActivity();
    };
  }, []);

  useEffect(() => {
    if (!isFloatMode) {
      return;
    }

    publishComposerActivity({
      hasText: draft.trim().length > 0,
      isFocused: isPetComposerFocused,
      isComposing: isPetComposerComposing,
    });
  }, [draft, isFloatMode, isPetComposerComposing, isPetComposerFocused]);

  useEffect(() => {
    if (!isFloatMode) {
      return;
    }

    return () => {
      publishComposerActivity({
        hasText: false,
        isFocused: false,
        isComposing: false,
      });
    };
  }, [isFloatMode]);

  useEffect(() => {
    if (composerAutoHideTimerRef.current !== null) {
      window.clearTimeout(composerAutoHideTimerRef.current);
      composerAutoHideTimerRef.current = null;
    }

    const hasActiveDraft =
      draft.trim().length > 0 || remoteComposerActivity.hasText;
    const isComposerInteracting =
      isPetComposerFocused ||
      isPetComposerComposing ||
      remoteComposerActivity.isFocused ||
      remoteComposerActivity.isComposing;

    if (
      isPanelMode ||
      !isComposerOpen ||
      isSending ||
      Boolean(activeSpeechText) ||
      isSpeechStreaming ||
      hasActiveDraft ||
      isComposerInteracting
    ) {
      return;
    }

    composerAutoHideTimerRef.current = window.setTimeout(() => {
      composerAutoHideTimerRef.current = null;
      setIsComposerOpen(false);
    }, petComposerAutoHideDelayMs);

    return () => {
      if (composerAutoHideTimerRef.current !== null) {
        window.clearTimeout(composerAutoHideTimerRef.current);
        composerAutoHideTimerRef.current = null;
      }
    };
  }, [
    activeSpeechText,
    draft,
    isComposerOpen,
    isPanelMode,
    isPetComposerComposing,
    isPetComposerFocused,
    isSending,
    isSpeechStreaming,
    petComposerAutoHideDelayMs,
    remoteComposerActivity.hasText,
    remoteComposerActivity.isComposing,
    remoteComposerActivity.isFocused,
  ]);

  useEffect(() => {
    if (isComposerOpen) {
      return;
    }

    setPetComposerWidth(petComposerBaseWidth);
    setIsPetComposerMultiline(false);
  }, [isComposerOpen]);

  useEffect(() => {
    if (isPanelMode) {
      return;
    }

    // 使用浮动窗口显示/隐藏，而不是调整窗口大小
    if (isPetWindowExpanded) {
      void window.zhuochong?.floatWindow.show();
    } else {
      void window.zhuochong?.floatWindow.hide();
    }
  }, [isPanelMode, isPetWindowExpanded]);

  // 自适应窗口大小
  useEffect(() => {
    if (!isFloatMode) {
      return;
    }

    const container = floatContainerRef.current;
    if (!container) {
      return;
    }

    let lastWidth = 0;
    let lastHeight = 0;

    const doResize = (width: number, height: number) => {
      // 固定窗口大小，防止无限循环
      const w = Math.max(240, Math.min(300, Math.round(width + 24)));
      const h = Math.max(80, Math.min(200, Math.round(height + 24)));
      if (w !== lastWidth || h !== lastHeight) {
        lastWidth = w;
        lastHeight = h;
        void window.zhuochong?.floatWindow.resize(w, h);
      }
    };

    // 延迟初始调整，确保 CSS 加载完成
    const timer = window.setTimeout(() => {
      const { offsetWidth, offsetHeight } = container;
      // 强制最小高度
      doResize(offsetWidth, Math.max(80, offsetHeight));
    }, 150);

    return () => {
      window.clearTimeout(timer);
    };
  }, [isFloatMode]);

  useEffect(() => {
    if (isPanelMode) {
      return;
    }

    let lastIgnoreValue: boolean | null = null;

    const resolveInteractiveState = (target?: EventTarget | null) => {
      if (isDragging) {
        if (lastIgnoreValue === false) {
          return;
        }

        lastIgnoreValue = false;
        void window.zhuochong?.petWindow.setIgnoreMouseEvents(false);
        return;
      }

      const focusedElement =
        document.activeElement instanceof Element
          ? document.activeElement
          : null;
      const eventElement = target instanceof Element ? target : null;
      const pointerPosition = pointerPositionRef.current;
      const hoveredElement = pointerPosition
        ? document.elementFromPoint(pointerPosition.x, pointerPosition.y)
        : null;
      const isHoveringInteractive = Boolean(
        eventElement?.closest("[data-hit-region='active']") ||
          hoveredElement?.closest("[data-hit-region='active']"),
      );
      const isFocusedInteractive =
        !pointerPosition &&
        Boolean(focusedElement?.closest("[data-hit-region='active']"));
      const isInteractive = isHoveringInteractive || isFocusedInteractive;
      const nextIgnoreValue = !isInteractive;

      if (lastIgnoreValue === nextIgnoreValue) {
        return;
      }

      lastIgnoreValue = nextIgnoreValue;
      void window.zhuochong?.petWindow.setIgnoreMouseEvents(nextIgnoreValue);
    };

    const handlePointerMove = (event: PointerEvent) => {
      pointerPositionRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
      resolveInteractiveState(event.target);
    };

    const handleFocusIn = (event: FocusEvent) => {
      resolveInteractiveState(event.target);
    };

    const handleFocusOut = () => {
      window.setTimeout(() => {
        resolveInteractiveState();
      }, 0);
    };

    window.addEventListener("pointermove", handlePointerMove, true);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    resolveInteractiveState();

    return () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
      void window.zhuochong?.petWindow.setIgnoreMouseEvents(false);
    };
  }, [isDragging, isPanelMode]);

  useEffect(() => {
    if (ambientMoveTimerRef.current !== null) {
      window.clearTimeout(ambientMoveTimerRef.current);
      ambientMoveTimerRef.current = null;
    }

    if (
      !isPetMode ||
      isDragging ||
      isComposerOpen ||
      isSending ||
      Boolean(activeSpeechText) ||
      isSpeechStreaming ||
      visualState !== "idle"
    ) {
      return;
    }

    ambientMoveTimerRef.current = window.setTimeout(() => {
      ambientMoveTimerRef.current = null;
      void wanderRandomly();
    }, randomBetween(ambientMotionProfile.minDelayMs, ambientMotionProfile.maxDelayMs));

    return () => {
      if (ambientMoveTimerRef.current !== null) {
        window.clearTimeout(ambientMoveTimerRef.current);
        ambientMoveTimerRef.current = null;
      }
    };
  }, [
    activeSpeechText,
    isComposerOpen,
    isDragging,
    isPetMode,
    isSending,
    isSpeechStreaming,
    ambientMotionProfile.maxDelayMs,
    ambientMotionProfile.minDelayMs,
    visualState,
    wanderRandomly,
  ]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (draft.trim().length === 0 || isSending) {
      return;
    }

    if (!isPanelMode) {
      reopenComposerAfterSpeechRef.current = true;
      setIsComposerOpen(false);
    }

    void sendMessage();
  };

  const handlePanelComposerKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    // Enter 发送，Shift+Enter 换行
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const handlePetComposerKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    // 桌宠模式：Enter 发送，Shift+Enter 换行
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();

      if (draft.trim().length === 0 || isSending) {
        return;
      }

      reopenComposerAfterSpeechRef.current = true;
      setIsComposerOpen(false);
      void sendMessage();
    }
  };

  const focusPetComposer = () => {
    window.requestAnimationFrame(() => {
      petComposerRef.current?.focus();
      const length = petComposerRef.current?.value.length ?? 0;
      petComposerRef.current?.setSelectionRange(length, length);
    });
  };

  const handlePetDoubleClick = () => {
    if (isPanelMode) {
      return;
    }

    void window.zhuochong?.desktop.openControlPanel();
  };

  const handlePetContextMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    if (isPanelMode) {
      return;
    }

    event.preventDefault();
    void window.zhuochong?.desktop.showPetContextMenu();
  };

  const handlePetClick = () => {
    if (isPanelMode) {
      return;
    }

    if (consumePetClick()) {
      return;
    }

    setIsComposerOpen((current) => {
      const nextValue = !current;
      if (nextValue) {
        focusPetComposer();
      }
      return nextValue;
    });
  };


  const [activePanelTab, setActivePanelTab] = useState<PanelTab>(() =>
    isPanelMode ? consumePanelTabRequest("chat") : "chat",
  );

  // 设置页状态
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [settingsMessageType, setSettingsMessageType] = useState<"success" | "error" | "info">("success");
  const [reminderRuntimeStatus, setReminderRuntimeStatus] =
    useState<ReminderRuntimeStatusDto | null>(null);
  const [reminderRuntimeLoading, setReminderRuntimeLoading] = useState(false);
  const [reminderRuntimeError, setReminderRuntimeError] = useState<string | null>(null);
  
  // API Key 编辑状态
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [clipboardState, setClipboardState] =
    useState<ZhuochongClipboardState | null>(null);
  const [clipboardLoading, setClipboardLoading] = useState(false);
  const [clipboardShortcutDraft, setClipboardShortcutDraft] = useState(
    defaultClipboardAccelerator,
  );
  const [themeModeDraft, setThemeModeDraft] =
    useState<ZhuochongShellAppearanceMode>("system");
  const [isRecordingClipboardShortcut, setIsRecordingClipboardShortcut] =
    useState(false);

  useEffect(() => {
    setThemeModeDraft(appearance.themeMode);
  }, [appearance.themeMode]);

  useEffect(() => {
    if (!isPanelMode) {
      return;
    }

    return subscribePanelTabRequests((nextTab) => {
      setActivePanelTab(nextTab);
      clearPanelTabRequest();
    });
  }, [isPanelMode]);

  // 加载设置
  const loadSettings = async () => {
    setSettingsLoading(true);
    try {
      const data = await desktopLocalService.getSettings();
      setSettings(data);
      setPetRuntimeSettings(extractPetRuntimeSettings(data));
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "加载设置失败");
      setSettingsMessageType("error");
    } finally {
      setSettingsLoading(false);
    }
  };

  const loadClipboardState = async (options?: {
    quiet?: boolean;
  }) => {
    if (!options?.quiet) {
      setClipboardLoading(true);
    }

    try {
      const data = await window.zhuochong?.clipboard?.getState?.();
      if (!data) {
        throw new Error("剪贴板工具暂时不可用。");
      }

      setClipboardState(data);
      setClipboardShortcutDraft(data.shortcut.accelerator);
    } catch (error) {
      setClipboardState(null);
      setSettingsMessage(
        error instanceof Error ? error.message : "读取剪贴板设置失败",
      );
      setSettingsMessageType("error");
    } finally {
      if (!options?.quiet) {
        setClipboardLoading(false);
      }
    }
  };

  const loadReminderRuntimeStatus = async (options?: {
    quiet?: boolean;
  }) => {
    if (!options?.quiet) {
      setReminderRuntimeLoading(true);
    }

    try {
      const data = await desktopLocalService.getReminderRuntimeStatus();
      setReminderRuntimeStatus(data);
      setReminderRuntimeError(null);
    } catch (error) {
      setReminderRuntimeStatus(null);
      setReminderRuntimeError(
        error instanceof Error ? error.message : "读取提醒运行状态失败",
      );
    } finally {
      if (!options?.quiet) {
        setReminderRuntimeLoading(false);
      }
    }
  };

  // 保存设置
  const saveSettings = async () => {
    if (!settings) return;
    setSettingsSaving(true);
    setSettingsMessage(null);
    
    try {
      const patch: SettingsUpdateRequest["patch"] = {
        model: {
          baseUrl: settings.model.baseUrl,
          modelName: settings.model.modelName,
        },
        behavior: settings.behavior,
        pet: settings.pet,
        capabilities: {
          calendar: settings.capabilities.calendar === "ok",
          weather: settings.capabilities.weather === "ok",
          foregroundApp: settings.capabilities.foregroundApp === "ok",
          tts: settings.capabilities.tts === "ok",
        },
      };
      
      // 如果有新输入的 API Key，一起保存
      if (apiKeyInput.trim()) {
        patch.model = { ...patch.model, apiKeyInput: apiKeyInput.trim() };
      }
      
      const updated = await desktopLocalService.updateSettings({ patch });
      setSettings(updated);
      setPetRuntimeSettings(extractPetRuntimeSettings(updated));
      setApiKeyInput("");
      const syncedPetSettings = {
        displayName: updated.pet.displayName,
        pixelScale: updated.pet.pixelScale,
        motionFrequency: updated.pet.motionFrequency,
        sleepTendency: updated.pet.sleepTendency,
        moveDistance: updated.pet.moveDistance,
        composerAutoHideSeconds: updated.pet.composerAutoHideSeconds,
        proactivityLevel: updated.behavior.proactivityLevel,
      };
      publishPetSettingsUpdate(syncedPetSettings);
      void loadReminderRuntimeStatus({
        quiet: true,
      });

      const partialFailures: string[] = [];
      const partialSuccesses: string[] = [];
      const currentClipboardAccelerator = clipboardState?.shortcut.accelerator;
      const themeUpdateNeeded = themeModeDraft !== appearance.themeMode;
      const shortcutUpdateNeeded =
        Boolean(currentClipboardAccelerator) &&
        Boolean(clipboardShortcutDraft.trim()) &&
        clipboardShortcutDraft.trim() !== currentClipboardAccelerator;

      const [themeResult, shortcutResult] = await Promise.allSettled([
        themeUpdateNeeded
          ? window.zhuochong?.desktop?.updateThemeMode?.(themeModeDraft)
          : Promise.resolve(undefined),
        shortcutUpdateNeeded
          ? window.zhuochong?.clipboard?.updateShortcut?.(
              clipboardShortcutDraft.trim(),
            )
          : Promise.resolve(undefined),
      ]);

      if (themeUpdateNeeded) {
        if (themeResult.status === "fulfilled" && themeResult.value) {
          partialSuccesses.push("界面主题已更新");
        } else {
          partialFailures.push(
            `界面主题没有更新：${
              themeResult.status === "rejected"
                ? themeResult.reason instanceof Error
                  ? themeResult.reason.message
                  : "更新失败"
                : "界面主题桥接不可用。"
            }`,
          );
        }
      }

      if (shortcutUpdateNeeded) {
        if (shortcutResult.status === "fulfilled" && shortcutResult.value) {
          handleClipboardSubscriptionState(
            shortcutResult.value,
            setClipboardState,
            setClipboardShortcutDraft,
          );
          partialSuccesses.push("剪贴板快捷键已更新");
        } else {
          await loadClipboardState({
            quiet: true,
          });
          partialFailures.push(
            `剪贴板快捷键没有更新：${
              shortcutResult.status === "rejected"
                ? shortcutResult.reason instanceof Error
                  ? shortcutResult.reason.message
                  : "注册失败"
                : "剪贴板快捷键桥接不可用。"
            }`,
          );
        }
      }

      if (partialFailures.length > 0) {
        setSettingsMessage(`其他设置已保存，但${partialFailures.join("；")}`);
        setSettingsMessageType("error");
        window.setTimeout(() => setSettingsMessage(null), 5000);
        return;
      }

      const successMessage =
        partialSuccesses.length > 0
          ? `设置已保存，${partialSuccesses.join("，")}`
          : "设置已保存";

      setSettingsMessage(successMessage);
      setSettingsMessageType("success");
      window.setTimeout(() => setSettingsMessage(null), 3000);
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "保存设置失败");
      setSettingsMessageType("error");
    } finally {
      setSettingsSaving(false);
    }
  };

  // 测试 API 连接
  const testConnection = async () => {
    if (!settings) return;
    setTestingConnection(true);
    setSettingsMessage("正在测试连接...");
    setSettingsMessageType("info");
    
    try {
      // 尝试访问 API 的 models 端点
      const baseUrl = settings.model.baseUrl.replace(/\/$/, "");
      const response = await fetch(`${baseUrl}/models`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });
      
      if (response.ok) {
        setSettingsMessage("连接成功！API 地址可访问");
        setSettingsMessageType("success");
      } else if (response.status === 401 || response.status === 403) {
        setSettingsMessage("地址可达，但需要认证 (API Key)");
        setSettingsMessageType("success");
      } else {
        setSettingsMessage(`连接失败: HTTP ${response.status}`);
        setSettingsMessageType("error");
      }
    } catch (error) {
      // 可能是 CORS 问题，尝试基本连接测试
      if (error instanceof TypeError && error.message.includes("fetch")) {
        setSettingsMessage("无法连接 (可能是 CORS 限制或地址错误)");
        setSettingsMessageType("error");
      } else {
        setSettingsMessage(error instanceof Error ? `连接失败: ${error.message}` : "连接失败");
        setSettingsMessageType("error");
      }
    } finally {
      setTestingConnection(false);
      window.setTimeout(() => setSettingsMessage(null), 4000);
    }
  };

  const startClipboardShortcutRecording = () => {
    setIsRecordingClipboardShortcut(true);
    window.requestAnimationFrame(() => {
      clipboardShortcutInputRef.current?.focus();
      clipboardShortcutInputRef.current?.select();
    });
  };

  const stopClipboardShortcutRecording = () => {
    setIsRecordingClipboardShortcut(false);
  };

  const handleClipboardShortcutKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
  ) => {
    if (!isRecordingClipboardShortcut) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      stopClipboardShortcutRecording();
      return;
    }

    const nextAccelerator = getAcceleratorFromKeyEvent(event);
    if (!nextAccelerator) {
      return;
    }

    setClipboardShortcutDraft(nextAccelerator);
    stopClipboardShortcutRecording();
  };

  // 记忆/日记页状态
  const [memories, setMemories] = useState<MemoryRecordDto[]>([]);
  const [diaries, setDiaries] = useState<DiaryEntryDto[]>([]);
  const [profileSummaryData, setProfileSummaryData] =
    useState<CompanionProfileSummaryDto | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryLoadError, setMemoryLoadError] = useState<string | null>(null);
  const [activeMemoryTab, setActiveMemoryTab] = useState<"memories" | "diaries">("diaries");
  const [memoryCategoryFilter, setMemoryCategoryFilter] = useState<
    "all" | MemoryRecordDto["category"]
  >("all");
  const [memorySortMode, setMemorySortMode] = useState<"recent" | "confidence">(
    "recent",
  );
  const [collapsedMemoryGroups, setCollapsedMemoryGroups] = useState<
    Partial<Record<MemoryRecordDto["category"] | "other", boolean>>
  >({});

  const loadProfileSummaryData = async () => {
    try {
      const profileSummary = await desktopLocalService.getCompanionProfileSummary();
      setProfileSummaryData(profileSummary);
      setMemoryLoadError((current) =>
        current === "陪伴记录暂时不可用，请稍后再试。" ? null : current,
      );
      return profileSummary;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "获取陪伴摘要失败。";
      setMemoryLoadError((current) => current ?? message);
      return null;
    }
  };

  // 加载记忆和日记
  const loadMemoryData = async () => {
    setMemoryLoading(true);
    setMemoryLoadError(null);
    try {
      const [memoryResult, diaryResult, profileResult] = await Promise.allSettled([
        desktopLocalService.getMemoryList({ limit: 50 }),
        desktopLocalService.getDiaryList(7),
        desktopLocalService.getCompanionProfileSummary(),
      ]);

      const nextErrors: string[] = [];

      if (memoryResult.status === "fulfilled") {
        setMemories(memoryResult.value.memories);
      } else {
        nextErrors.push(
          memoryResult.reason instanceof Error
            ? memoryResult.reason.message
            : "获取记忆列表失败。",
        );
      }

      if (diaryResult.status === "fulfilled") {
        setDiaries(diaryResult.value.entries);
      } else {
        nextErrors.push(
          diaryResult.reason instanceof Error
            ? diaryResult.reason.message
            : "获取日记列表失败。",
        );
      }

      if (profileResult.status === "fulfilled") {
        setProfileSummaryData(profileResult.value);
      } else {
        nextErrors.push(
          profileResult.reason instanceof Error
            ? profileResult.reason.message
            : "获取陪伴摘要失败。",
        );
      }

      if (nextErrors.length > 0) {
        setMemoryLoadError(nextErrors[0] ?? "陪伴记录暂时不可用，请稍后再试。");
      }

      if (
        memoryResult.status !== "fulfilled" &&
        diaryResult.status !== "fulfilled" &&
        profileResult.status !== "fulfilled"
      ) {
        setMemoryLoadError(nextErrors[0] ?? "陪伴记录暂时不可用，请稍后再试。");
      }
    } finally {
      setMemoryLoading(false);
    }
  };

  // 标签页切换时加载数据
  useEffect(() => {
    if (!isPetMode || settings || settingsLoading) {
      return;
    }

    void loadSettings();
  }, [isPetMode, settings, settingsLoading]);

  useEffect(() => {
    const unsubscribeSettings = subscribePetSettingsUpdates((payload) => {
      setPetRuntimeSettings({
        proactivityLevel: payload.proactivityLevel,
        motionFrequency: payload.motionFrequency,
        sleepTendency: payload.sleepTendency,
        moveDistance: payload.moveDistance,
        composerAutoHideSeconds: payload.composerAutoHideSeconds,
      });
      setSettings((current) =>
        current
          ? {
              ...current,
              behavior: {
                ...current.behavior,
                proactivityLevel: payload.proactivityLevel,
              },
              pet: {
                ...current.pet,
                displayName: payload.displayName,
                pixelScale: payload.pixelScale,
                motionFrequency: payload.motionFrequency,
                sleepTendency: payload.sleepTendency,
                moveDistance: payload.moveDistance,
                composerAutoHideSeconds: payload.composerAutoHideSeconds,
              },
            }
          : current,
      );
    });

    return () => {
      unsubscribeSettings();
    };
  }, []);

  useEffect(() => {
    if (!isPanelMode || activePanelTab !== "settings") {
      return;
    }

    if (!settings) {
      void loadSettings();
    }

    if (!clipboardState) {
      void loadClipboardState();
    }

    const unsubscribeClipboard = window.zhuochong?.clipboard?.subscribeStateChanged?.(
      (nextState) => {
        handleClipboardSubscriptionState(
          nextState,
          setClipboardState,
          setClipboardShortcutDraft,
        );
      },
    );

    return () => {
      unsubscribeClipboard?.();
    };
  }, [activePanelTab, clipboardState, isPanelMode, settings]);

  useEffect(() => {
    if (!isPanelMode || activePanelTab !== "memory") {
      return;
    }

    void loadMemoryData();
  }, [activePanelTab, isPanelMode]);

  useEffect(() => {
    if (!isPanelMode || activePanelTab !== "status") {
      return;
    }

    if (profileSummaryData) {
      return;
    }

    void loadProfileSummaryData();
  }, [activePanelTab, isPanelMode, profileSummaryData]);

  // 会话变化时更新统计数据
  useEffect(() => {
    if (!activeSession || !isPanelMode) {
      return;
    }

    const loadStats = async () => {
      try {
        const stats = await getSessionStats();
        setSessionStats(stats);
      } catch {
        // 静默失败，使用消息数量作为备用
        setSessionStats({
          messageCount: messages.length,
          userTokens: 0,
          assistantTokens: 0,
        });
      }
    };

    void loadStats();
  }, [activeSession, messages.length, isPanelMode, getSessionStats]);

  useEffect(() => {
    if (!isPanelMode || reminderMessageIds.length === 0) {
      return;
    }

    const unresolvedReminderIds = reminderMessageIds.filter(
      (reminderId) => !reminderRecordsById.get(reminderId),
    );

    if (unresolvedReminderIds.length === 0) {
      return;
    }

    let disposed = false;

    const loadReminderRecords = async () => {
      try {
        const result = await desktopLocalService.getReminderList({
          limit: 200,
        });

        if (disposed) {
          return;
        }

        setReminderRecordsById((current) => {
          const next = new Map(current);
          for (const reminder of result.reminders) {
            next.set(reminder.reminderId, reminder);
          }
          return next;
        });
      } catch {
        // Keep local reminder record cache when sync fails.
      }
    };

    void loadReminderRecords();

    return () => {
      disposed = true;
    };
  }, [isPanelMode, reminderMessageIds, reminderRecordsById]);

  useEffect(() => {
    if (!isPanelMode || reminderMessageIds.length === 0) {
      return;
    }

    const unresolvedReminderIds = reminderMessageIds.filter(
      (reminderId) => !acknowledgedReminderIds.has(reminderId),
    );

    if (unresolvedReminderIds.length === 0) {
      return;
    }

    let disposed = false;

    const loadAcknowledgedReminders = async () => {
      try {
        const result = await desktopLocalService.getReminderList({
          limit: 200,
        });

        if (disposed) {
          return;
        }

        setReminderRecordsById((current) => {
          const next = new Map(current);
          for (const reminder of result.reminders) {
            next.set(reminder.reminderId, reminder);
          }
          return next;
        });

        const unresolvedSet = new Set(unresolvedReminderIds);
        const matchedIds = result.reminders
          .filter(
            (reminder) =>
              reminder.status !== "ready" &&
              unresolvedSet.has(reminder.reminderId),
          )
          .map((reminder) => reminder.reminderId);

        if (matchedIds.length === 0) {
          return;
        }

        setAcknowledgedReminderIds((current) => {
          const next = new Set(current);
          for (const reminderId of matchedIds) {
            next.add(reminderId);
          }
          return next;
        });
      } catch {
        // Keep local state when reminder status sync fails.
      }
    };

    void loadAcknowledgedReminders();

    return () => {
      disposed = true;
    };
  }, [isPanelMode, reminderMessageIds, acknowledgedReminderIds]);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("zh-CN", {
      month: "short",
      day: "numeric",
      weekday: "short",
    });
  };

  const getProfileToneLead = (stage: string) => {
    if (stage === "亲密无间") {
      return `${petName} 已经把你划进最熟悉的领地里，很多小反应都会优先朝你这边偏。`;
    }

    if (stage === "关系很好") {
      return `${petName} 对你已经明显放松下来，遇到顺手的事也更愿意主动靠近。`;
    }

    if (stage === "逐渐熟悉") {
      return `${petName} 正在慢慢摸清你的节奏，偶尔会主动把注意力放到你身上。`;
    }

    if (stage === "刚建立联系") {
      return `${petName} 还在试着确认你的照料方式，但已经愿意留下第一批陪伴记录。`;
    }

    return `${petName} 还在观察你，很多反应都偏谨慎，图鉴信息也会长得比较慢。`;
  };

  const compactMemoryClue = (value: string) => {
    const [head] = value.split(/[：:]/);
    return (head || value).trim();
  };

  const joinSummaryParts = (parts: Array<string | null | undefined>) =>
    parts.filter((part): part is string => Boolean(part && part.trim())).join("");

  const getLatestMemoryByKey = (
    memoryKey: string,
  ) => memories.find((memory) => memory.key === memoryKey) ?? null;

  const profileSummary = useMemo(
    () => {
      const currentStageMemory = getLatestMemoryByKey("当前关系阶段");
      const relationChangeMemory = getLatestMemoryByKey("最近关系变化");
      const careMemory = getLatestMemoryByKey("最近照料");
      const eventMemory = getLatestMemoryByKey("最近随机事件");
      const chatMemory = getLatestMemoryByKey("最近聊天");
      const latestDiary = diaries[0] ?? null;
      const resolvedStage = currentStageMemory?.valueText ?? affinityStage;

      if (!latestDiary && memories.length === 0) {
        return joinSummaryParts([
          getProfileToneLead(resolvedStage),
          `${petName} 还在继续积累陪伴记录，最近的互动会慢慢补全它对你的印象。`,
        ]);
      }

      return joinSummaryParts([
        getProfileToneLead(resolvedStage),
        latestDiary?.diaryText,
        latestDiary ? null : `它目前把你们的关系记作「${resolvedStage}」。`,
        relationChangeMemory
          ? `最近一次关系变化是：${relationChangeMemory.valueText}`
          : null,
        careMemory ? `它也记得你最近的照料：${careMemory.valueText}` : null,
        !careMemory && eventMemory
          ? `最近留下的事件印象是：${eventMemory.valueText}`
          : null,
        !careMemory && !eventMemory && chatMemory
          ? `它最近记住的一段聊天是：${chatMemory.valueText}`
          : null,
      ]);
    },
    [affinityStage, diaries, memories, petName],
  );

  const profileHighlights = useMemo(() => {
    const relationChangeMemory = getLatestMemoryByKey("最近关系变化");
    const careMemory = getLatestMemoryByKey("最近照料");
    const eventMemory = getLatestMemoryByKey("最近随机事件");
    const chatMemory = getLatestMemoryByKey("最近聊天");

    return [
      ...(diaries[0]?.highlights ?? []).slice(0, 2),
      relationChangeMemory ? compactMemoryClue(relationChangeMemory.valueText) : null,
      careMemory ? compactMemoryClue(careMemory.valueText) : null,
      eventMemory ? compactMemoryClue(eventMemory.valueText) : null,
      !eventMemory && chatMemory ? compactMemoryClue(chatMemory.valueText) : null,
    ]
      .filter(
        (value, index, array): value is string =>
          Boolean(value) && array.indexOf(value) === index,
      )
      .slice(0, 4);
  }, [diaries, memories]);

  const getCategoryLabel = (category: string) => {
    const labels: Record<string, string> = {
      preference: "偏好",
      habit: "习惯",
      profile: "档案",
      event: "事件",
      relationship: "关系",
    };
    return labels[category] ?? category;
  };

  type MemoryGroupKey = MemoryRecordDto["category"] | "other";

  type MemoryGroup = {
    category: MemoryGroupKey;
    title: string;
    items: MemoryRecordDto[];
  };

  const groupedMemories = useMemo<MemoryGroup[]>(() => {
    const categoryOrder: Array<MemoryRecordDto["category"]> = [
      "profile",
      "relationship",
      "habit",
      "event",
      "preference",
    ];
    const filteredMemories =
      memoryCategoryFilter === "all"
        ? memories
        : memories.filter((memory) => memory.category === memoryCategoryFilter);
    const sortedMemories = [...filteredMemories].sort((left, right) => {
      if (memorySortMode === "confidence") {
        return right.confidence - left.confidence;
      }

      return (
        Date.parse(right.lastConfirmedAt) - Date.parse(left.lastConfirmedAt)
      );
    });

    const groups: MemoryGroup[] = categoryOrder
      .map((category) => ({
        category,
        title: getCategoryLabel(category),
        items: sortedMemories.filter((memory) => memory.category === category),
      }))
      .filter((group) => group.items.length > 0);

    const uncategorized = sortedMemories.filter(
      (memory) => !categoryOrder.includes(memory.category),
    );

    if (uncategorized.length > 0) {
      groups.push({
        category: "other",
        title: "其他",
        items: uncategorized,
      });
    }

    return groups;
  }, [memories, memoryCategoryFilter, memorySortMode]);

  const toggleMemoryGroup = (groupKey: MemoryGroupKey) => {
    setCollapsedMemoryGroups((current) => ({
      ...current,
      [groupKey]: !current[groupKey],
    }));
  };

  const handleReminderAction = async (
    reminderId: string,
    action: "dismiss" | "open_chat",
  ) => {
    setAcknowledgingReminderIds((current) => {
      if (current.has(reminderId)) {
        return current;
      }

      const next = new Set(current);
      next.add(reminderId);
      return next;
    });

    try {
      await desktopLocalService.acknowledgeReminder({
        reminderId,
        action,
      });
      setAcknowledgedReminderIds((current) => {
        const next = new Set(current);
        next.add(reminderId);
        return next;
      });

      if (action === "open_chat") {
        panelComposerRef.current?.focus();
      }
    } catch {
      // Ignore action errors in panel UI; message will remain actionable.
    } finally {
      setAcknowledgingReminderIds((current) => {
        if (!current.has(reminderId)) {
          return current;
        }

        const next = new Set(current);
        next.delete(reminderId);
        return next;
      });
    }
  };

  const reminderRuntimeView = useMemo<ReminderRuntimeView>(() => {
    if (reminderRuntimeStatus) {
      const unavailableChecks: string[] = [];
      if (
        reminderRuntimeStatus.silentWhenFocusMode &&
        !reminderRuntimeStatus.detected.focusModeDetectionAvailable
      ) {
        unavailableChecks.push("专注模式检测不可用");
      }

      if (!reminderRuntimeStatus.remindersEnabled) {
        return {
          tone: "is-disabled",
          title: "主动提醒已关闭",
          detail: "提醒调度器不会主动发出提醒。",
        };
      }

      if (reminderRuntimeStatus.isSilent) {
        return {
          tone: "is-silent",
          title: "当前处于静默状态",
          detail: `当前命中静默规则：${reminderRuntimeStatus.activeSilentReasons
            .map((reason) => reminderSilentReasonLabels[reason])
            .join("、")}`,
        };
      }

      if (unavailableChecks.length > 0) {
        return {
          tone: "is-pending",
          title: "部分静默检测不可用",
          detail: `${unavailableChecks.join("、")}，当前结果仅基于可用检测项。`,
        };
      }

      return {
        tone: "is-active",
        title: "当前可以正常提醒",
        detail: `没有命中静默规则，${getProactivityLevelHint(
          reminderRuntimeStatus.proactivityLevel,
        )}`,
      };
    }

    if (reminderRuntimeLoading) {
      return {
        tone: "is-pending",
        title: "正在检测提醒状态",
        detail: "正在读取提醒静默状态，请稍等。",
      };
    }

    if (reminderRuntimeError) {
      return {
        tone: "is-error",
        title: "提醒状态读取失败",
        detail: reminderRuntimeError,
      };
    }

    if (settings && !settings.behavior.remindersEnabled) {
      return {
        tone: "is-disabled",
        title: "主动提醒已关闭",
        detail: "当前设置已经关闭主动提醒，保存后会保持此状态。",
      };
    }

    return {
      tone: "is-pending",
      title: "等待状态检测",
      detail: "请点击“刷新状态”或稍等几秒，系统会返回当前静默检测结果。",
    };
  }, [reminderRuntimeError, reminderRuntimeLoading, reminderRuntimeStatus, settings]);

  return (
    <main className={`pet-root mode-${presentationMode}`}>
      {isFloatMode ? (
        <section ref={floatContainerRef} className="float-container">
          <section
            className={`pet-speech-bubble ${
              isSpeechStreaming ? "is-streaming" : ""
            } ${activeSpeechText || isSpeechStreaming ? "is-visible" : "is-hidden"}`}
            aria-live="polite"
          >
            <p
              ref={setStreamingTextRef}
              className="pet-speech-text"
            >
              {activeSpeechText ?? ""}
            </p>
          </section>

          {/* 输出时隐藏输入框，避免重叠 */}
          {!activeSpeechText && !isSpeechStreaming ? (
            <form
              data-hit-region="active"
              className={`pet-inline-composer ${
                isPetComposerMultiline ? "is-multiline" : ""
              } ${isSending ? "is-sending" : ""}`}
              onSubmit={handleSubmit}
              style={{
                width: `${petComposerWidth}px`,
              }}
            >
              <textarea
                ref={petComposerRef}
                id="pet-composer"
                className="pet-inline-input"
                placeholder="说点什么"
                rows={1}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                }}
                onCompositionStart={() => {
                  setIsPetComposerComposing(true);
                }}
                onCompositionEnd={(event) => {
                  setIsPetComposerComposing(false);
                  setDraft(event.currentTarget.value);
                }}
                onFocus={() => {
                  setIsPetComposerFocused(true);
                }}
                onBlur={() => {
                  setIsPetComposerFocused(false);
                  setIsPetComposerComposing(false);
                }}
                onKeyDown={handlePetComposerKeyDown}
              />
            </form>
          ) : null}

          <span
            ref={petComposerMeasureRef}
            className="pet-inline-measure"
            aria-hidden="true"
          />
        </section>
      ) : null}

      {isPanelMode ? (
        <section className="desk-panel">
          {/* 侧边栏导航 */}
          <nav className="panel-sidebar">
            <div className="sidebar-logo">猫</div>
            
            <div className="sidebar-nav">
              <button
                type="button"
                className={`sidebar-nav-item ${activePanelTab === "chat" ? "is-active" : ""}`}
                onClick={() => setActivePanelTab("chat")}
                title="聊天"
              >
                <span className="sidebar-nav-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </span>
                <span className="sidebar-nav-label">聊天</span>
              </button>
              
              <button
                type="button"
                className={`sidebar-nav-item ${activePanelTab === "memory" ? "is-active" : ""}`}
                onClick={() => setActivePanelTab("memory")}
                title="记忆"
              >
                <span className="sidebar-nav-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z" />
                    <path d="M12 6v6l4 2" />
                  </svg>
                </span>
                <span className="sidebar-nav-label">记忆</span>
              </button>
              
              <button
                type="button"
                className={`sidebar-nav-item ${activePanelTab === "status" ? "is-active" : ""}`}
                onClick={() => setActivePanelTab("status")}
                title="状态"
              >
                <span className="sidebar-nav-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M4 19h16" />
                    <path d="M7 15l3-3 3 2 4-6" />
                  </svg>
                </span>
                <span className="sidebar-nav-label">状态</span>
              </button>

              <button
                type="button"
                className={`sidebar-nav-item ${activePanelTab === "settings" ? "is-active" : ""}`}
                onClick={() => setActivePanelTab("settings")}
                title="设置"
              >
                <span className="sidebar-nav-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                  </svg>
                </span>
                <span className="sidebar-nav-label">设置</span>
              </button>
            </div>

            <div className="sidebar-spacer" />

            <div className="sidebar-version">v0.1.0</div>
          </nav>

          {/* 主内容区 */}
          <div className={`panel-main ${activePanelTab === "chat" ? "is-chat-tab" : ""}`}>
            <header className="panel-header">
              <div className="panel-header-left">
                <p className="panel-kicker">
                  {activePanelTab === "chat"
                    ? "Chat"
                    : activePanelTab === "memory"
                      ? "Memory"
                      : activePanelTab === "status"
                        ? "Companion"
                        : "Settings"}
                </p>
                <h1 className="panel-title">
                  {activePanelTab === "chat"
                    ? "对话记录"
                    : activePanelTab === "memory"
                      ? "记忆与日记"
                      : activePanelTab === "status"
                        ? "桌宠状态"
                        : "应用设置"}
                </h1>
              </div>
              {activePanelTab === "chat" ? (
                <div className="panel-header-actions">
                  <span className="token-stats">
                    <span className="token-stat-item">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M12 6v6l4 2" />
                      </svg>
                      {sessionStats.messageCount} 条
                    </span>
                    <span className="token-stat-divider">|</span>
                    <span className="token-stat-item" title="用户输入 Token">
                      你: {sessionStats.userTokens}
                    </span>
                    <span className="token-stat-item" title="AI 输出 Token">
                      猫: {sessionStats.assistantTokens}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="new-session-btn"
                    onClick={async () => {
                      await createNewSession();
                      setSessionStats({ messageCount: 0, userTokens: 0, assistantTokens: 0 });
                    }}
                    disabled={isSending || isLoading || Boolean(switchingSessionId)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                    新会话
                  </button>
                </div>
              ) : null}
            </header>

            <div className={`panel-content ${activePanelTab === "chat" ? "is-chat-tab" : ""}`}>
              {/* 聊天标签页 */}
              {activePanelTab === "chat" ? (
                <section className="chat-workspace">
                  <aside className="chat-session-pane">
                    <div className="chat-session-pane-header">
                      <div className="chat-session-sidebar-header">
                        <div>
                          <p className="chat-session-sidebar-title">最近会话</p>
                          <p className="chat-session-sidebar-copy">
                            选中后会切换为当前活动会话
                          </p>
                        </div>
                        <span className="chat-session-sidebar-count">
                          {sessions.length}
                        </span>
                      </div>
                    </div>

                    <div className="chat-session-list">
                      {sessionsLoading ? (
                        <article className="chat-session-empty">
                          正在载入会话...
                        </article>
                      ) : sessions.length === 0 ? (
                        <article className="chat-session-empty">
                          还没有历史会话
                        </article>
                      ) : (
                        sessions.map((session) => {
                          const isActiveChatSession =
                            session.sessionId === activeSession?.sessionId;
                          const isSwitchingChatSession =
                            switchingSessionId === session.sessionId;

                          return (
                            <button
                              key={session.sessionId}
                              type="button"
                              className={`chat-session-item ${isActiveChatSession ? "is-active" : ""}`}
                              disabled={
                                isLoading ||
                                isSending ||
                                isSwitchingChatSession
                              }
                              onClick={() => {
                                void switchSession(session.sessionId);
                              }}
                            >
                              <div className="chat-session-item-top">
                                <span className="chat-session-item-id">
                                  {formatSessionLabel(session.sessionId)}
                                </span>
                                <span
                                  className={`chat-session-item-status ${session.status === "active" ? "is-active" : ""}`}
                                >
                                  {isSwitchingChatSession
                                    ? "切换中"
                                    : getSessionStatusLabel(session.status)}
                                </span>
                              </div>
                              <time
                                className="chat-session-item-time"
                                dateTime={session.lastMessageAt}
                              >
                                {formatSessionTime(session.lastMessageAt)}
                              </time>
                              <span className="chat-session-item-meta">
                                创建于 {formatSessionTime(session.startedAt)}
                              </span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </aside>

                  <section className="chat-conversation-pane">
                    <div className="chat-conversation-topbar">
                      <div className="chat-history-toolbar-copy">
                        <p className="chat-history-toolbar-title">
                          {activeSession
                            ? `当前会话 ${formatSessionLabel(activeSession.sessionId)}`
                            : "当前会话"}
                        </p>
                        <p className="chat-history-toolbar-subtitle">
                          {historyHasMore
                            ? "可以继续向上补载更早消息。"
                            : "已经是这个会话的最早记录。"}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="chat-history-load-more"
                        onClick={() => {
                          void loadOlderMessages();
                        }}
                        disabled={
                          isLoading ||
                          historyLoadingMore ||
                          !historyHasMore
                        }
                      >
                        {historyLoadingMore
                          ? "载入中..."
                          : historyHasMore
                            ? "加载更早消息"
                            : "没有更早消息"}
                      </button>
                    </div>

                    <div className="message-feed">
                      {isLoading ? (
                        <article className="message-empty">
                          <p className="message-empty-title">正在载入会话</p>
                        </article>
                      ) : messages.filter((message) =>
                          shouldRenderChatMessage(message, reminderRecordsById),
                        ).length === 0 ? (
                        <article className="message-empty">
                          <p className="message-empty-title">当前没有需要在聊天区显示的内容</p>
                          <p className="message-empty-copy">
                            主动关心会走桌宠侧输出，不再直接出现在聊天记录里
                          </p>
                        </article>
                      ) : (
                        (() => {
                          let cumulativeTokens = 0;
                          return messages
                            .filter((message) =>
                              shouldRenderChatMessage(message, reminderRecordsById),
                            )
                            .map((message) => {
                              const msgTokens = Math.ceil(message.text.length / 2);
                              cumulativeTokens += msgTokens;
                              const reminderId =
                                message.source === "reminder"
                                  ? message.relatedReminderId
                                  : undefined;
                              const hasReminderActions = Boolean(
                                reminderId &&
                                  !acknowledgedReminderIds.has(reminderId),
                              );
                              const reminderActionLoading = Boolean(
                                reminderId &&
                                  acknowledgingReminderIds.has(reminderId),
                              );
                              return (
                                <article
                                  key={message.messageId}
                                  className={`message-card role-${message.role}`}
                                >
                                  <div className="message-meta">
                                    <span className="message-author">
                                      {getAuthorLabel(message.role, petName)}
                                    </span>
                                    <div className="message-meta-right">
                                      <span className="message-tokens" title={`本条: ${msgTokens} tokens`}>
                                        {msgTokens} tk
                                      </span>
                                      <time
                                        className="message-time"
                                        dateTime={message.createdAt}
                                      >
                                        {formatMessageTime(message.createdAt)}
                                      </time>
                                    </div>
                                  </div>
                                  <p className="message-text">{message.text}</p>
                                  <div className="message-footer">
                                    <span className="message-cumulative">
                                      累计: {cumulativeTokens} tokens
                                    </span>
                                    {hasReminderActions && reminderId ? (
                                      <div className="message-footer-actions">
                                        <button
                                          type="button"
                                          className="reminder-action-btn"
                                          disabled={reminderActionLoading}
                                          onClick={() => {
                                            void handleReminderAction(
                                              reminderId,
                                              "dismiss",
                                            );
                                          }}
                                        >
                                          知道了
                                        </button>
                                        <button
                                          type="button"
                                          className="reminder-action-btn is-primary"
                                          disabled={reminderActionLoading}
                                          onClick={() => {
                                            void handleReminderAction(
                                              reminderId,
                                              "open_chat",
                                            );
                                          }}
                                        >
                                          去聊天
                                        </button>
                                      </div>
                                    ) : null}
                                  </div>
                                </article>
                              );
                            });
                        })()
                      )}

                      {streamingPhase !== "idle" ? (
                        <article className="message-card role-assistant is-streaming">
                          <div className="message-meta">
                            <span className="message-author">{petName}</span>
                            <span className="message-time">
                              {streamingPhase === "waiting" ? "等待首字" : "流式中"}
                            </span>
                          </div>
                          <p className="message-text">
                            {streamingPhase === "waiting"
                              ? "正在思考..."
                              : streamingAssistantText}
                          </p>
                        </article>
                      ) : null}
                    </div>

                    <form className="composer composer-chat" onSubmit={handleSubmit}>
                      <textarea
                        ref={panelComposerRef}
                        id="panel-composer"
                        className="composer-input"
                        placeholder="输入消息..."
                        rows={2}
                        value={draft}
                        disabled={isLoading || Boolean(switchingSessionId)}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={handlePanelComposerKeyDown}
                      />

                      <div className="composer-footer">
                        <p className="composer-status">{composerMessage}</p>
                        <button
                          type="submit"
                          className="composer-submit"
                          disabled={
                            isLoading ||
                            isSending ||
                            Boolean(switchingSessionId) ||
                            draft.trim().length === 0
                          }
                        >
                          {isSending ? "发送中..." : "发送"}
                        </button>
                      </div>
                    </form>
                  </section>
                </section>
              ) : null}

              {/* 记忆标签页 */}
              {activePanelTab === "memory" ? (
                <>
                  <div className="memory-tabs">
                    <button
                      type="button"
                      className={`memory-tab ${activeMemoryTab === "diaries" ? "is-active" : ""}`}
                      onClick={() => setActiveMemoryTab("diaries")}
                    >
                      日记
                    </button>
                    <button
                      type="button"
                      className={`memory-tab ${activeMemoryTab === "memories" ? "is-active" : ""}`}
                      onClick={() => setActiveMemoryTab("memories")}
                    >
                      记忆
                    </button>
                  </div>

                  {memoryLoading ? (
                    <div className="memory-loading">
                      <p>加载中...</p>
                    </div>
                  ) : (
                    <>
                      {memoryLoadError ? (
                        <article className="message-empty">
                          <p className="message-empty-title">陪伴记录加载不完整</p>
                          <p className="message-empty-copy">{memoryLoadError}</p>
                          <button
                            type="button"
                            className="memory-filter-chip"
                            onClick={() => void loadMemoryData()}
                          >
                            重新加载
                          </button>
                        </article>
                      ) : null}
                      {activeMemoryTab === "diaries" ? (
                        <div className="diary-list">
                          {diaries.length === 0 ? (
                            <article className="message-empty">
                              <p className="message-empty-title">还没有日记</p>
                              <p className="message-empty-copy">
                                与桌宠聊天后会自动生成日记
                              </p>
                            </article>
                          ) : (
                            diaries.map((diary) => (
                              <article key={diary.diaryId} className="diary-card">
                                <header className="diary-header">
                                  <h3 className="diary-date">{formatDate(diary.date)}</h3>
                                  <span className="diary-memory-count">
                                    {diary.memoryCount} 条记忆
                                  </span>
                                </header>
                                <p className="diary-text">{diary.diaryText}</p>
                                {diary.highlights.length > 0 ? (
                                  <div className="diary-highlights">
                                    {diary.highlights.map((highlight, index) => (
                                      <span key={index} className="diary-highlight">
                                        {highlight}
                                      </span>
                                    ))}
                                  </div>
                                ) : null}
                              </article>
                            ))
                          )}
                        </div>
                      ) : (
                        <>
                          <div className="memory-filter-row">
                            {([
                              ["all", "全部"],
                              ["profile", "档案"],
                              ["relationship", "关系"],
                              ["habit", "习惯"],
                              ["event", "事件"],
                              ["preference", "偏好"],
                            ] as const).map(([category, label]) => (
                              <button
                                key={category}
                                type="button"
                                className={`memory-filter-chip ${memoryCategoryFilter === category ? "is-active" : ""}`}
                                onClick={() => setMemoryCategoryFilter(category)}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                          <div className="memory-toolbar-row">
                            <span className="memory-toolbar-label">排序</span>
                            <button
                              type="button"
                              className={`memory-filter-chip ${memorySortMode === "recent" ? "is-active" : ""}`}
                              onClick={() => setMemorySortMode("recent")}
                            >
                              最近更新
                            </button>
                            <button
                              type="button"
                              className={`memory-filter-chip ${memorySortMode === "confidence" ? "is-active" : ""}`}
                              onClick={() => setMemorySortMode("confidence")}
                            >
                              置信度
                            </button>
                          </div>
                          <div className="memory-list">
                            {memories.length === 0 ? (
                              <article className="message-empty">
                                <p className="message-empty-title">还没有记忆</p>
                                <p className="message-empty-copy">
                                  与桌宠互动后会自动形成记忆
                                </p>
                              </article>
                            ) : groupedMemories.length === 0 ? (
                              <article className="message-empty">
                                <p className="message-empty-title">这个分类还没有内容</p>
                                <p className="message-empty-copy">
                                  换个分类看看，或者继续和桌宠互动。
                                </p>
                              </article>
                            ) : (
                              groupedMemories.map((group) => (
                                <section key={group.title} className="memory-group">
                                  <button
                                    type="button"
                                    className="memory-group-header memory-group-toggle"
                                    onClick={() => toggleMemoryGroup(group.category)}
                                  >
                                    <h3 className="memory-group-title">{group.title}</h3>
                                    <div className="memory-group-header-right">
                                      <span className="memory-group-count">{group.items.length}</span>
                                      <span className="memory-group-caret">
                                        {collapsedMemoryGroups[group.category] ? "展开" : "收起"}
                                      </span>
                                    </div>
                                  </button>
                                  {!collapsedMemoryGroups[group.category] ? (
                                    <div className="memory-group-list">
                                      {group.items.map((memory) => (
                                        <article key={memory.memoryId} className="memory-card">
                                          <header className="memory-header">
                                            <span className={`memory-category category-${memory.category}`}>
                                              {getCategoryLabel(memory.category)}
                                            </span>
                                            <span className="memory-key">{memory.key}</span>
                                          </header>
                                          <p className="memory-value">{memory.valueText}</p>
                                          <footer className="memory-footer">
                                            <span className="memory-confidence">
                                              置信度 {Math.round(memory.confidence * 100)}%
                                            </span>
                                            <time className="memory-updated-at" dateTime={memory.lastConfirmedAt}>
                                              {formatDate(memory.lastConfirmedAt)}
                                            </time>
                                          </footer>
                                        </article>
                                      ))}
                                    </div>
                                  ) : null}
                                </section>
                              ))
                            )}
                          </div>
                        </>
                      )}
                    </>
                  )}
                </>
              ) : null}

              {/* 状态标签页 */}
              {activePanelTab === "status" ? (
                <section className="status-page">
                  <section className="status-hero-card">
                    <div className="status-hero-art">
                      <img
                        className="status-hero-image"
                        draggable={false}
                        src={currentAsset.src}
                        alt={petName}
                      />
                    </div>
                    <div className="status-hero-copy">
                      <p className="status-kicker">Companion Dex</p>
                      <h2 className="status-name">{petName}</h2>
                      <p className="status-summary">
                        目前的陪伴记录显示，它正以「{statusText}」的状态陪着你。下面这段图鉴说明会根据最近的互动、记忆和日记持续刷新。
                      </p>
                      <div className="status-tags">
                        <span className="status-tag">当前动作 · {visualState}</span>
                        <span className="status-tag">关系阶段 · {affinityStage}</span>
                        <span className="status-tag">像素缩放 · {pixelScale}x</span>
                        <span className="status-tag">交互提示 · {dragHint}</span>
                        <span className="status-tag">
                          好感冷却 · {affinityCooldownRemainingMs > 0 ? `${Math.ceil(affinityCooldownRemainingMs / 60_000)} 分钟` : "已结束"}
                        </span>
                      </div>
                    </div>
                  </section>

                  <section className="status-metrics-grid">
                    {metrics.map((metric) => (
                      <article
                        key={metric.key}
                        className={`status-metric-card tone-${metric.tone}`}
                      >
                        <header className="status-metric-header">
                          <span className="status-metric-label">{metric.label}</span>
                          <span className="status-metric-badge">
                            {getMetricToneLabel(metric.tone)}
                          </span>
                        </header>
                        <div className="status-metric-value-row">
                          <strong className="status-metric-value">{metric.value}</strong>
                          <span className="status-metric-unit">/ 100</span>
                        </div>
                        <div className="status-metric-bar">
                          <span
                            className="status-metric-bar-fill"
                            style={{ width: `${metric.value}%` }}
                          />
                        </div>
                        <p className="status-metric-hint">{metric.hint}</p>
                      </article>
                    ))}
                  </section>

                  <section className="status-resources-card">
                    <div className="status-section-copy">
                      <p className="status-section-kicker">Resource Case</p>
                      <h3 className="status-section-title">携带物与条件判定</h3>
                    </div>
                    <div className="status-resource-list">
                      {resources.map((resource) => (
                        <article key={resource.key} className="status-resource-item">
                          <div>
                            <p className="status-resource-label">{resource.label}</p>
                            <p className="status-resource-hint">{resource.hint}</p>
                          </div>
                          <strong className="status-resource-value">{resource.value}</strong>
                        </article>
                      ))}
                    </div>
                    <div className="status-condition-list">
                      <p className="status-condition-item">喂食：{actionAvailability.feedReason}</p>
                      <p className="status-condition-item">玩耍：{actionAvailability.playReason}</p>
                      <p className="status-condition-item">休息：{actionAvailability.restReason}</p>
                    </div>
                  </section>

                  <section className="status-actions-card">
                    <div className="status-section-copy">
                      <p className="status-section-kicker">Care Command</p>
                      <h3 className="status-section-title">照料指令</h3>
                      <p className="status-section-text">
                        喂食、玩耍与休息都需要满足当前状态与资源条件；随机事件会在系统判断合适时自动触发。
                      </p>
                    </div>
                    <div className="status-action-list">
                      <button type="button" className="status-action-btn" onClick={feedPet}>
                        喂点东西
                      </button>
                      <button type="button" className="status-action-btn" onClick={playWithPet}>
                        陪它玩耍
                      </button>
                      <button type="button" className="status-action-btn" onClick={restPet}>
                        让它休息
                      </button>
                    </div>
                  </section>

                  <section className="status-events-card">
                    <div className="status-section-copy">
                      <p className="status-section-kicker">Field Log</p>
                      <h3 className="status-section-title">近期观察记录</h3>
                    </div>
                    {eventLogs.length === 0 ? (
                      <p className="status-profile-text">
                        目前还没有记录。等系统在合适时机触发随机事件后，这里会留下最近的陪伴观察。
                      </p>
                    ) : (
                      <div className="status-event-list">
                        {eventLogs.map((event) => (
                          <article key={event.eventId} className={`status-event-item tone-${event.tone}`}>
                            <div className="status-event-main">
                              <strong className="status-event-title">{event.title}</strong>
                              <p className="status-event-description">{event.description}</p>
                            </div>
                            <time className="status-event-time" dateTime={event.createdAt}>
                              {formatMessageTime(event.createdAt)}
                            </time>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="status-profile-card">
                    <div className="status-section-copy">
                      <p className="status-section-kicker">Dex Note</p>
                      <h3 className="status-section-title">个体图鉴说明</h3>
                    </div>
                    <p className="status-profile-text">
                      {profileSummaryData?.summaryText ?? profileSummary}
                    </p>
                    {(profileSummaryData?.highlights ?? profileHighlights).length > 0 ? (
                      <div className="status-profile-highlights">
                        {(profileSummaryData?.highlights ?? profileHighlights).map((highlight: string, index: number) => (
                          <span key={`${highlight}-${index}`} className="status-profile-highlight">
                            {highlight}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </section>
                </section>
              ) : null}

              {/* 设置标签页 */}
              {activePanelTab === "settings" ? (
                settingsLoading ? (
                  <div className="settings-loading">
                    <p>加载设置中...</p>
                  </div>
                ) : settings ? (
                  <div className="settings-form">
                    <div className="settings-section">
                      <h3 className="settings-section-title">模型配置</h3>
                      <div className="settings-field">
                        <label className="settings-label">API 地址</label>
                        <div className="settings-input-with-button">
                          <input
                            type="text"
                            className="settings-input"
                            value={settings.model.baseUrl}
                            onChange={(event) => {
                              setSettings({
                                ...settings,
                                model: { ...settings.model, baseUrl: event.target.value },
                              });
                            }}
                            placeholder="https://api.openai.com/v1"
                          />
                          <button
                            type="button"
                            className="settings-test-btn"
                            onClick={() => void testConnection()}
                            disabled={testingConnection || !settings.model.baseUrl}
                          >
                            {testingConnection ? "测试中..." : "测试连接"}
                          </button>
                        </div>
                      </div>
                      <div className="settings-field">
                        <label className="settings-label">模型名称</label>
                        <input
                          type="text"
                          className="settings-input"
                          value={settings.model.modelName}
                          onChange={(event) => {
                            setSettings({
                              ...settings,
                              model: { ...settings.model, modelName: event.target.value },
                            });
                          }}
                          placeholder="gpt-4o-mini"
                        />
                      </div>
                      <div className="settings-field">
                        <label className="settings-label">API Key</label>
                        <div className="settings-input-with-button">
                          <input
                            type={showApiKey ? "text" : "password"}
                            className="settings-input"
                            value={apiKeyInput}
                            onChange={(event) => {
                              setApiKeyInput(event.target.value);
                            }}
                            placeholder={settings.model.apiKeyState === "configured" ? "已保存 (输入新值覆盖)" : "请输入 API Key"}
                          />
                          <button
                            type="button"
                            className="settings-toggle-visibility"
                            onClick={() => setShowApiKey(!showApiKey)}
                            title={showApiKey ? "隐藏" : "显示"}
                          >
                            {showApiKey ? (
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                                <line x1="1" y1="1" x2="23" y2="23" />
                              </svg>
                            ) : (
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                <circle cx="12" cy="12" r="3" />
                              </svg>
                            )}
                          </button>
                        </div>
                        <p className="settings-hint">
                          {settings.model.apiKeyState === "configured" 
                            ? "API Key 已保存，输入新值将覆盖" 
                            : "请输入 API Key"}
                        </p>
                      </div>
                    </div>

                    <div className="settings-section">
                      <h3 className="settings-section-title">桌宠行为</h3>
                      <div className="settings-field">
                        <label className="settings-label">主动性</label>
                        <select
                          className="settings-select"
                          value={settings.behavior.proactivityLevel}
                          onChange={(event) => {
                            const value = event.target.value as "low" | "medium" | "high";
                            setSettings({
                              ...settings,
                              behavior: { ...settings.behavior, proactivityLevel: value },
                            });
                          }}
                        >
                          <option value="low">低 - 少动多睡</option>
                          <option value="medium">中 - 平衡</option>
                          <option value="high">高 - 多动少睡</option>
                        </select>
                        <p className="settings-hint">
                          {getProactivityLevelHint(settings.behavior.proactivityLevel)}
                        </p>
                      </div>
                      <div className="settings-field">
                        <label className="settings-label">移动频率</label>
                        <select
                          className="settings-select"
                          value={settings.pet.motionFrequency}
                          onChange={(event) => {
                            const value =
                              event.target.value as SettingsDto["pet"]["motionFrequency"];
                            setSettings({
                              ...settings,
                              pet: { ...settings.pet, motionFrequency: value },
                            });
                          }}
                        >
                          <option value="low">低 - 更少走动</option>
                          <option value="medium">中 - 默认节奏</option>
                          <option value="high">高 - 更常走动</option>
                        </select>
                        <p className="settings-hint">
                          {getMotionFrequencyHint(settings.pet.motionFrequency)}
                        </p>
                      </div>
                      <div className="settings-field">
                        <label className="settings-label">睡眠倾向</label>
                        <select
                          className="settings-select"
                          value={settings.pet.sleepTendency}
                          onChange={(event) => {
                            const value =
                              event.target.value as SettingsDto["pet"]["sleepTendency"];
                            setSettings({
                              ...settings,
                              pet: { ...settings.pet, sleepTendency: value },
                            });
                          }}
                        >
                          <option value="easy">更容易睡</option>
                          <option value="balanced">平衡</option>
                          <option value="late">更晚睡</option>
                        </select>
                        <p className="settings-hint">
                          {getSleepTendencyHint(settings.pet.sleepTendency)}
                        </p>
                      </div>
                      <div className="settings-field">
                        <label className="settings-label">移动距离</label>
                        <select
                          className="settings-select"
                          value={settings.pet.moveDistance}
                          onChange={(event) => {
                            const value =
                              event.target.value as SettingsDto["pet"]["moveDistance"];
                            setSettings({
                              ...settings,
                              pet: { ...settings.pet, moveDistance: value },
                            });
                          }}
                        >
                          <option value="short">短 - 附近走动</option>
                          <option value="medium">中 - 默认步幅</option>
                          <option value="long">长 - 更大步幅</option>
                        </select>
                        <p className="settings-hint">
                          {getMoveDistanceHint(settings.pet.moveDistance)}
                        </p>
                      </div>
                      <div className="settings-field">
                        <label className="settings-label">输入框自动收起</label>
                        <select
                          className="settings-select"
                          value={settings.pet.composerAutoHideSeconds}
                          onChange={(event) => {
                            const value = Number(
                              event.target.value,
                            ) as SettingsDto["pet"]["composerAutoHideSeconds"];
                            setSettings({
                              ...settings,
                              pet: {
                                ...settings.pet,
                                composerAutoHideSeconds: value,
                              },
                            });
                          }}
                        >
                          <option value={5}>5 秒</option>
                          <option value={9}>9 秒</option>
                          <option value={15}>15 秒</option>
                        </select>
                        <p className="settings-hint">
                          {getComposerAutoHideHint(
                            settings.pet.composerAutoHideSeconds,
                          )}
                        </p>
                      </div>
                      <div className="settings-field">
                        <label className="settings-checkbox-label">
                          <input
                            type="checkbox"
                            className="settings-checkbox"
                            checked={settings.behavior.remindersEnabled}
                            onChange={(event) => {
                              const value = event.target.checked;
                              setSettings({
                                ...settings,
                                behavior: { ...settings.behavior, remindersEnabled: value },
                              });
                            }}
                          />
                          启用主动提醒
                        </label>
                      </div>
                      <div className="settings-field">
                        <label className="settings-checkbox-label">
                          <input
                            type="checkbox"
                            className="settings-checkbox"
                            checked={settings.behavior.silentWhenFocusMode}
                            onChange={(event) => {
                              const value = event.target.checked;
                              setSettings({
                                ...settings,
                                behavior: {
                                  ...settings.behavior,
                                  silentWhenFocusMode: value,
                                },
                              });
                            }}
                          />
                          专注模式时静默
                          <span className="settings-checkbox-hint">
                            检测到系统专注模式后，主动提醒会进入抑制状态
                          </span>
                        </label>
                      </div>
                      <div className="settings-field">
                        <div className="settings-runtime-card">
                          <div className="settings-runtime-header">
                            <div className="settings-runtime-header-copy">
                              <p className="settings-runtime-title">提醒运行状态</p>
                              <p className="settings-runtime-meta">
                                {reminderRuntimeStatus
                                  ? `最近检测 ${formatRuntimeCheckedAt(reminderRuntimeStatus.checkedAt)}`
                                  : "进入设置页后会自动检测当前静默状态"}
                              </p>
                            </div>
                            <button
                              type="button"
                              className="settings-test-btn settings-test-btn-compact"
                              onClick={() => void loadReminderRuntimeStatus()}
                              disabled={reminderRuntimeLoading}
                            >
                              {reminderRuntimeLoading ? "检测中..." : "刷新状态"}
                            </button>
                          </div>
                          {reminderRuntimeStatus ? (
                            <>
                              <span className={`settings-runtime-badge ${reminderRuntimeView.tone}`}>
                                {reminderRuntimeView.title}
                              </span>
                              <p className="settings-runtime-copy">
                                {reminderRuntimeView.detail}
                              </p>
                              <div className="settings-runtime-flags">
                                <span className="settings-runtime-flag">
                                  主动性 {getProactivityLevelLabel(reminderRuntimeStatus.proactivityLevel)}
                                </span>
                                <span className="settings-runtime-flag">
                                  专注模式 {!reminderRuntimeStatus.detected.focusModeDetectionAvailable
                                    ? "检测不可用"
                                    : reminderRuntimeStatus.detected.focusModeEnabled
                                      ? "已开启"
                                    : "未开启"}
                                </span>
                              </div>
                            </>
                          ) : (
                            <>
                              <span className={`settings-runtime-badge ${reminderRuntimeView.tone}`}>
                                {reminderRuntimeView.title}
                              </span>
                              <p className="settings-runtime-copy">
                                {reminderRuntimeView.detail}
                              </p>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="settings-section">
                      <h3 className="settings-section-title">快捷键与工具</h3>
                      <div className="settings-field">
                        <label className="settings-label">剪贴板面板快捷键</label>
                        <div className="settings-shortcut-row">
                          <input
                            ref={clipboardShortcutInputRef}
                            type="text"
                            className={`settings-input settings-shortcut-input ${
                              isRecordingClipboardShortcut ? "is-recording" : ""
                            }`}
                            value={
                              isRecordingClipboardShortcut
                                ? "请直接按下新的组合键，按 Esc 取消"
                                : formatAcceleratorLabel(
                                    clipboardShortcutDraft ||
                                      clipboardState?.shortcut.accelerator ||
                                      defaultClipboardAccelerator,
                                  )
                            }
                            onKeyDown={handleClipboardShortcutKeyDown}
                            onBlur={() => {
                              if (isRecordingClipboardShortcut) {
                                stopClipboardShortcutRecording();
                              }
                            }}
                            readOnly
                          />
                          <button
                            type="button"
                            className="settings-test-btn"
                            onClick={() => {
                              if (isRecordingClipboardShortcut) {
                                stopClipboardShortcutRecording();
                                return;
                              }

                              startClipboardShortcutRecording();
                            }}
                          >
                            {isRecordingClipboardShortcut ? "取消录制" : "录制快捷键"}
                          </button>
                          <button
                            type="button"
                            className="settings-test-btn"
                            onClick={() => {
                              setClipboardShortcutDraft(
                                clipboardState?.shortcut.defaultAccelerator ??
                                  defaultClipboardAccelerator,
                              );
                              stopClipboardShortcutRecording();
                            }}
                          >
                            恢复默认
                          </button>
                          <button
                            type="button"
                            className="settings-test-btn"
                            onClick={() =>
                              void window.zhuochong?.clipboard?.showPanel?.()
                            }
                            disabled={!clipboardState && clipboardLoading}
                          >
                            打开面板
                          </button>
                          <button
                            type="button"
                            className="settings-test-btn"
                            onClick={async () => {
                              try {
                                const granted =
                                  await window.zhuochong?.desktop.requestAccessibilityPermission?.();
                                setSettingsMessage(
                                  granted
                                    ? "辅助功能权限已可用，剪贴板现在可以尝试自动粘贴。"
                                    : "还没有获得辅助功能权限，请在系统设置里完成授权。",
                                );
                                setSettingsMessageType(granted ? "success" : "info");
                              } catch (error) {
                                setSettingsMessage(
                                  error instanceof Error
                                    ? error.message
                                    : "请求辅助功能权限失败",
                                );
                                setSettingsMessageType("error");
                              }
                            }}
                          >
                            开启自动粘贴
                          </button>
                        </div>
                        <p className="settings-hint">
                          {clipboardLoading
                            ? "正在读取当前快捷键..."
                            : clipboardState?.shortcut.isRegistered
                              ? "快捷键已注册。按下后会弹出最近复制的文字或图片；若已开启辅助功能权限，点选一条会直接自动粘贴。"
                              : "快捷键当前未注册，通常是和系统或其他应用冲突，换一个组合后再保存。"}
                        </p>
                      </div>
                    </div>

                    <div className="settings-section">
                      <h3 className="settings-section-title">桌宠外观</h3>
                      <div className="settings-field">
                        <label className="settings-label">界面主题</label>
                        <select
                          className="settings-select"
                          value={themeModeDraft}
                          onChange={(event) => {
                            setThemeModeDraft(
                              event.target.value as ZhuochongShellAppearanceMode,
                            );
                          }}
                        >
                          <option value="system">跟随系统</option>
                          <option value="light">浅色</option>
                          <option value="dark">深色</option>
                        </select>
                        <p className="settings-hint">
                          {getThemeModeHint(themeModeDraft, appearance.resolvedTheme)}
                        </p>
                      </div>
                      <div className="settings-field">
                        <label className="settings-label">显示名称</label>
                        <input
                          type="text"
                          className="settings-input"
                          value={settings.pet.displayName}
                          onChange={(event) => {
                            setSettings({
                              ...settings,
                              pet: { ...settings.pet, displayName: event.target.value },
                            });
                          }}
                          placeholder="像素猫"
                        />
                      </div>
                      <div className="settings-field">
                        <label className="settings-label">像素缩放</label>
                        <select
                          className="settings-select"
                          value={settings.pet.pixelScale}
                          onChange={(event) => {
                            const value = Number(event.target.value) as 1 | 2 | 3 | 4;
                            setSettings({
                              ...settings,
                              pet: { ...settings.pet, pixelScale: value },
                            });
                          }}
                        >
                          <option value={1}>1x</option>
                          <option value={2}>2x</option>
                          <option value={3}>3x</option>
                          <option value={4}>4x</option>
                        </select>
                      </div>
                    </div>

                    <div className="settings-section">
                      <h3 className="settings-section-title">系统能力</h3>
                      <p className="settings-section-hint">
                        允许桌宠获取以下系统信息，用于提供更智能的上下文感知服务
                      </p>
                      <div className="settings-field">
                        <label className="settings-checkbox-label">
                          <input
                            type="checkbox"
                            className="settings-checkbox"
                            checked={settings.capabilities.foregroundApp === "ok"}
                            onChange={(event) => {
                              setSettings({
                                ...settings,
                                capabilities: {
                                  ...settings.capabilities,
                                  foregroundApp: event.target.checked ? "ok" : "disabled",
                                },
                              });
                            }}
                          />
                          获取前台应用
                          <span className="settings-checkbox-hint">
                            桌宠可以知道你正在使用什么应用
                          </span>
                        </label>
                      </div>
                      <div className="settings-field">
                        <label className="settings-checkbox-label">
                          <input
                            type="checkbox"
                            className="settings-checkbox"
                            checked={settings.capabilities.calendar === "ok"}
                            onChange={(event) => {
                              setSettings({
                                ...settings,
                                capabilities: {
                                  ...settings.capabilities,
                                  calendar: event.target.checked ? "ok" : "disabled",
                                },
                              });
                            }}
                          />
                          日历访问
                          <span className="settings-checkbox-hint">
                            桌宠可以查看日程安排
                          </span>
                        </label>
                      </div>
                      <div className="settings-field">
                        <label className="settings-checkbox-label">
                          <input
                            type="checkbox"
                            className="settings-checkbox"
                            checked={settings.capabilities.weather === "ok"}
                            onChange={(event) => {
                              setSettings({
                                ...settings,
                                capabilities: {
                                  ...settings.capabilities,
                                  weather: event.target.checked ? "ok" : "disabled",
                                },
                              });
                            }}
                          />
                          天气查询
                          <span className="settings-checkbox-hint">
                            桌宠可以获取当前天气信息
                          </span>
                        </label>
                      </div>
                      <div className="settings-field">
                        <button
                          type="button"
                          className="settings-test-btn"
                          onClick={async () => {
                            try {
                              const info = await window.zhuochong?.desktop.getSystemInfo();
                              if (info) {
                                setSettingsMessage(
                                  `当前时间: ${info.currentTime}\n` +
                                  `前台应用: ${info.foregroundApp?.name || "未知"}\n` +
                                  `电池: ${info.battery ? `${info.battery.level}% ${info.battery.isCharging ? "充电中" : "放电中"}` : "未知"}`
                                );
                                setSettingsMessageType("success");
                              }
                            } catch (error) {
                              setSettingsMessage("获取系统信息失败");
                              setSettingsMessageType("error");
                            }
                            window.setTimeout(() => setSettingsMessage(null), 5000);
                          }}
                        >
                          测试系统信息获取
                        </button>
                      </div>
                    </div>

                    {settingsMessage ? (
                      <p className={`settings-message is-${settingsMessageType}`}>
                        {settingsMessage}
                      </p>
                    ) : null}

                    <div className="settings-actions">
                      <button
                        type="button"
                        className="settings-save-btn"
                        onClick={() => void saveSettings()}
                        disabled={settingsSaving}
                      >
                        {settingsSaving ? "保存中..." : "保存设置"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <article className="message-empty">
                    <p className="message-empty-title">无法加载设置</p>
                  </article>
                )
              ) : null}
            </div>

          </div>
        </section>
      ) : null}

      <section className="pet-shell">
        {isPetMode ? (
          <section className={`pet-stage is-pet-mode ${
            isPetWindowExpanded ? "is-expanded" : "is-compact"
          }`}>
            <div className="pet-avatar-stack">
              <button
                type="button"
                data-hit-region="active"
                aria-label="桌宠像素猫"
                aria-pressed={isComposerOpen}
                className={`pet-button state-${visualState}`}
                style={petSizingStyle}
                title={`${petName} · ${statusText} · 单击展开输入，双击打开控制台，右键更多操作`}
                onClick={handlePetClick}
                onContextMenu={handlePetContextMenu}
                onDoubleClick={handlePetDoubleClick}
                onPointerCancel={handlePointerCancel}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
              >
                <span className="pet-shadow" aria-hidden="true" />
                <span
                  className={`pet-sprite-frame is-facing-${facingDirection}`}
                  aria-hidden="true"
                >
                  <img
                    className="pet-sprite"
                    draggable={false}
                    src={currentAsset.src}
                    alt={petName}
                  />
                </span>
                {visualState === "sleep" ? (
                  <span className="pet-badge pet-badge-sleep" aria-hidden="true">
                    <span className="pet-badge-z">Z</span>
                    <span className="pet-badge-z">z</span>
                    <span className="pet-badge-z">z</span>
                  </span>
                ) : null}
                {visualState === "idle" ? (
                  <span className="pet-sparkle pet-sparkle-1" aria-hidden="true">✦</span>
                ) : null}
                {visualState === "idle" ? (
                  <span className="pet-sparkle pet-sparkle-2" aria-hidden="true">✦</span>
                ) : null}
              </button>
            </div>
          </section>
        ) : null}
      </section>
    </main>
  );
};

export const App = () => {
  const presentationMode = getPresentationMode();
  if (presentationMode === "clipboard") {
    return (
      <AppErrorBoundary>
        <ClipboardPalette />
      </AppErrorBoundary>
    );
  }

  return (
    <AppErrorBoundary>
      <MainApp presentationMode={presentationMode} />
    </AppErrorBoundary>
  );
};

type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = { hasError: boolean; error: Error | null };

class AppErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[AppErrorBoundary] 渲染异常:", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        padding: 32,
        fontFamily: "system-ui, sans-serif",
        color: "#333",
        background: "#fafafa",
        textAlign: "center",
      }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>😵</div>
        <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>界面出了点问题</h2>
        <p style={{ margin: "0 0 16px", color: "#666", fontSize: 14 }}>
          {this.state.error?.message ?? "发生了未知错误"}
        </p>
        <button
          type="button"
          onClick={() => this.setState({ hasError: false, error: null })}
          style={{
            padding: "8px 24px",
            borderRadius: 8,
            border: "1px solid #ddd",
            background: "#fff",
            cursor: "pointer",
            fontSize: 14,
          }}
        >
          重试
        </button>
      </div>
    );
  }
}
