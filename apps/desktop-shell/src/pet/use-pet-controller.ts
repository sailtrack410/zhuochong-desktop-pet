import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import type {
  CompanionEventRecordRequest,
  PetMoveDistance,
  PetBusinessState,
  PetMood,
  PetMotionFrequency,
  PetSleepTendency,
  PetStateUpdateRequest,
  PetVisualState,
  ProactivityLevel,
} from "@zhuochong/ui-contracts";

import { desktopLocalService } from "../services/local-service.js";
import { subscribePetSettingsUpdates } from "../settings/pet-settings-sync.js";
import { pixelCatManifest, petStatusCopy } from "./manifest.js";

type DragState = {
  pointerId: number;
  offsetX: number;
  offsetY: number;
  hasMoved: boolean;
  lastScreenX: number;
};

type ServiceLevel = "connecting" | "online" | "degraded";
type FacingDirection = "left" | "right";

type PetViewState = {
  businessState: PetBusinessState;
  visualState: PetVisualState;
  mood: PetMood;
  trigger: PetStateUpdateRequest["trigger"];
};

type PetMetric = {
  key: "satiety" | "energy" | "affinity" | "health";
  label: string;
  value: number;
  tone: "meal" | "energy" | "heart" | "health";
  hint: string;
};

type PetResource = {
  key: "snackToken" | "playToken";
  label: string;
  value: number;
  hint: string;
};

type PetEventLog = {
  eventId: string;
  title: string;
  description: string;
  createdAt: string;
  tone: "positive" | "neutral" | "warning";
};

type PetActionAvailability = {
  canFeed: boolean;
  feedReason: string;
  canPlay: boolean;
  playReason: string;
  canRest: boolean;
  restReason: string;
};

type ChatAffinityAssessment = {
  delta: number;
  reason: string;
};

const assessChatAffinity = (text: string): ChatAffinityAssessment => {
  const normalized = text.trim();
  if (!normalized) {
    return { delta: 0, reason: "空消息不会影响关系。" };
  }

  if (/(滚|烦|闭嘴|别说|别烦我|讨厌|走开)/.test(normalized)) {
    return { delta: -1, reason: "刚才的话让它有点受伤。" };
  }

  if (/(谢谢|辛苦了|陪我|你好|早安|晚安|抱抱|喜欢你|可爱)/.test(normalized)) {
    return { delta: 1, reason: "刚才的话让它更愿意亲近你。" };
  }

  return { delta: 0, reason: "这次聊天没有直接改变关系。" };
};


type AffinityAdjustmentResult = {
  applied: boolean;
  delta: number;
  reason: string;
};

type AmbientMotionProfile = {
  minDelayMs: number;
  maxDelayMs: number;
  sleepDelayMs: number;
  minHorizontalOffset: number;
  maxHorizontalOffset: number;
  verticalOffsetRange: number;
  runDistanceThreshold: number;
  baseDurationMs: number;
  durationPerPixelMs: number;
};

export type PetRuntimeBehaviorSettings = {
  proactivityLevel: ProactivityLevel;
  motionFrequency: PetMotionFrequency;
  sleepTendency: PetSleepTendency;
  moveDistance: PetMoveDistance;
};

export const defaultPetRuntimeBehaviorSettings: PetRuntimeBehaviorSettings = {
  proactivityLevel: "medium",
  motionFrequency: "medium",
  sleepTendency: "balanced",
  moveDistance: "medium",
};

const distanceExceeded = (
  previous: Pick<DragState, "offsetX" | "offsetY">,
  event: ReactPointerEvent<HTMLElement>,
) => {
  const deltaX = Math.abs(event.clientX - previous.offsetX);
  const deltaY = Math.abs(event.clientY - previous.offsetY);
  return deltaX > 4 || deltaY > 4;
};

const clampMetric = (value: number) =>
  Math.min(100, Math.max(0, Math.round(value)));

const createPrefixedId = (prefix: string) => {
  const entropy = Math.random().toString(36).slice(2, 10);
  const timestamp = Date.now().toString(36);
  return `${prefix}_${timestamp}_${entropy}`;
};

const nowIso = () => new Date().toISOString();

const affinityCooldownMs = 60 * 60_000;

const getAutoEventDelayMs = (level: ProactivityLevel) => {
  if (level === "high") {
    return 12 * 60_000;
  }

  if (level === "low") {
    return 45 * 60_000;
  }

  return 24 * 60_000;
};


const applyAffinityDelta = (
  currentAffinity: number,
  delta: number,
  lastAffinityChangedAt: string | null,
): AffinityAdjustmentResult => {
  if (delta === 0) {
    return {
      applied: false,
      delta: 0,
      reason: "本次事件不会影响好感。",
    };
  }

  const nowMs = Date.now();
  const lastChangedMs = lastAffinityChangedAt ? Date.parse(lastAffinityChangedAt) : 0;
  if (lastChangedMs && Number.isFinite(lastChangedMs) && nowMs - lastChangedMs < affinityCooldownMs) {
    const remainMinutes = Math.max(1, Math.ceil((affinityCooldownMs - (nowMs - lastChangedMs)) / 60_000));
    return {
      applied: false,
      delta: 0,
      reason: `好感冷却中，还需约 ${remainMinutes} 分钟。`,
    };
  }

  const boundedDelta = delta > 0 ? Math.min(delta, 2) : Math.max(delta, -2);
  return {
    applied: true,
    delta: boundedDelta,
    reason: boundedDelta > 0 ? `好感上升 ${boundedDelta}。` : `好感下降 ${Math.abs(boundedDelta)}。`,
  };
};

export const getAmbientMotionProfile = (
  settings: PetRuntimeBehaviorSettings,
): AmbientMotionProfile => {
  const { proactivityLevel, motionFrequency, sleepTendency, moveDistance } =
    settings;
  const motionFrequencyFactor =
    motionFrequency === "high"
      ? 0.72
      : motionFrequency === "low"
        ? 1.38
        : 1;
  const motionFrequencySleepFactor =
    motionFrequency === "high"
      ? 1.2
      : motionFrequency === "low"
        ? 0.82
        : 1;
  const sleepTendencyFactor =
    sleepTendency === "late"
      ? 1.35
      : sleepTendency === "easy"
        ? 0.74
        : 1;
  const moveDistanceFactor =
    moveDistance === "long"
      ? 1.34
      : moveDistance === "short"
        ? 0.74
        : 1;

  const withTuning = (profile: AmbientMotionProfile): AmbientMotionProfile => ({
    ...profile,
    minDelayMs: Math.round(profile.minDelayMs * motionFrequencyFactor),
    maxDelayMs: Math.round(profile.maxDelayMs * motionFrequencyFactor),
    sleepDelayMs: Math.round(
      profile.sleepDelayMs * motionFrequencySleepFactor * sleepTendencyFactor,
    ),
    minHorizontalOffset: Math.round(
      profile.minHorizontalOffset * moveDistanceFactor,
    ),
    maxHorizontalOffset: Math.round(
      profile.maxHorizontalOffset * moveDistanceFactor,
    ),
    verticalOffsetRange: Math.round(
      profile.verticalOffsetRange * moveDistanceFactor,
    ),
  });

  if (proactivityLevel === "high") {
    return withTuning({
      minDelayMs: 18_000,
      maxDelayMs: 28_000,
      sleepDelayMs: 42_000,
      minHorizontalOffset: 220,
      maxHorizontalOffset: 420,
      verticalOffsetRange: 170,
      runDistanceThreshold: 360,
      baseDurationMs: 2_200,
      durationPerPixelMs: 3.2,
    });
  }

  if (proactivityLevel === "low") {
    return withTuning({
      minDelayMs: 52_000,
      maxDelayMs: 74_000,
      sleepDelayMs: 26_000,
      minHorizontalOffset: 120,
      maxHorizontalOffset: 220,
      verticalOffsetRange: 90,
      runDistanceThreshold: 999,
      baseDurationMs: 2_600,
      durationPerPixelMs: 3.8,
    });
  }

  return withTuning({
    minDelayMs: 30_000,
    maxDelayMs: 46_000,
    sleepDelayMs: 54_000,
    minHorizontalOffset: 160,
    maxHorizontalOffset: 300,
    verticalOffsetRange: 120,
    runDistanceThreshold: 330,
    baseDurationMs: 2_400,
    durationPerPixelMs: 3.4,
  });
};

const isFiniteCoordinate = (value: number) => Number.isFinite(value);

const petViewStates = {
  idle: {
    businessState: "idle",
    visualState: "idle",
    mood: "neutral",
    trigger: "system",
  },
  sleep: {
    businessState: "sleeping",
    visualState: "sleep",
    mood: "sleepy",
    trigger: "system",
  },
  click: {
    businessState: "reacting",
    visualState: "click",
    mood: "happy",
    trigger: "manual",
  },
  drag: {
    businessState: "reacting",
    visualState: "drag",
    mood: "curious",
    trigger: "drag",
  },
  move: {
    businessState: "reacting",
    visualState: "move",
    mood: "happy",
    trigger: "drag",
  },
  run: {
    businessState: "reacting",
    visualState: "run",
    mood: "happy",
    trigger: "system",
  },
  hurt: {
    businessState: "reacting",
    visualState: "hurt",
    mood: "annoyed",
    trigger: "system",
  },
} satisfies Record<
  "idle" | "sleep" | "click" | "drag" | "move" | "run" | "hurt",
  PetViewState
>;

const normalizeRestoredVisualState = (
  visualState: PetVisualState,
): PetVisualState => {
  if (
    visualState === "sleep" ||
    visualState === "click" ||
    visualState === "drag" ||
    visualState === "move" ||
    visualState === "run" ||
    visualState === "hurt"
  ) {
    return "idle";
  }

  return visualState;
};

const deriveRestoredViewState = (visualState: PetVisualState): PetViewState => {
  const normalizedVisualState = normalizeRestoredVisualState(visualState);

  if (normalizedVisualState === "sleep") {
    return petViewStates.sleep;
  }

  return petViewStates.idle;
};

const describeSatiety = (value: number) => {
  if (value < 35) {
    return "该投喂了。";
  }

  if (value > 82) {
    return "刚好吃饱，很满足。";
  }

  return "胃口稳定，能继续陪你。";
};

const describeEnergy = (value: number) => {
  if (value < 35) {
    return "有点犯困，适合休息。";
  }

  if (value > 82) {
    return "精力很满，随时能互动。";
  }

  return "状态平稳，还能继续活动。";
};

const describeAffinity = (value: number) => {
  if (value < 40) {
    return "再多聊聊会更亲近。";
  }

  if (value > 82) {
    return "已经很黏你了。";
  }

  return "关系正在慢慢升温。";
};

const describeHealth = (value: number) => {
  if (value < 35) {
    return "需要好好照顾一下。";
  }

  if (value > 82) {
    return "状态很好，精神饱满。";
  }

  return "整体健康状况稳定。";
};

const createPetEventLog = (
  title: string,
  description: string,
  tone: PetEventLog["tone"],
): PetEventLog => ({
  eventId: createPrefixedId("petevent"),
  title,
  description,
  createdAt: nowIso(),
  tone,
});

const getAffinityStage = (value: number) => {
  if (value >= 80) {
    return "亲密无间";
  }

  if (value >= 60) {
    return "关系很好";
  }

  if (value >= 40) {
    return "逐渐熟悉";
  }

  if (value >= 20) {
    return "刚建立联系";
  }

  return "还在观察你";
};

const resolveAffinityStageAfterAdjustment = (
  currentAffinity: number,
  result: AffinityAdjustmentResult,
) => getAffinityStage(clampMetric(currentAffinity + (result.applied ? result.delta : 0)));

export const usePetController = (
  behaviorSettings: PetRuntimeBehaviorSettings = defaultPetRuntimeBehaviorSettings,
) => {
  const ambientMotionProfile = useMemo(
    () => getAmbientMotionProfile(behaviorSettings),
    [behaviorSettings],
  );
  const [visualState, setVisualState] = useState<PetVisualState>(
    pixelCatManifest.defaultState,
  );
  const [isDragging, setIsDragging] = useState(false);
  const [facingDirection, setFacingDirection] = useState<FacingDirection>("right");
  const [isSleepSettled, setIsSleepSettled] = useState(false);
  const [petName, setPetName] = useState(pixelCatManifest.displayName);
  const [pixelScale, setPixelScale] = useState<1 | 2 | 3 | 4>(3);
  const [runtimeVersion, setRuntimeVersion] = useState("dev");
  const [serviceLevel, setServiceLevel] = useState<ServiceLevel>("connecting");
  const [serviceLabel, setServiceLabel] = useState(
    "正在连接 local-service。",
  );
  const [satiety, setSatiety] = useState(76);
  const [energy, setEnergy] = useState(68);
  const [health, setHealth] = useState(88);
  const [affinity, setAffinity] = useState(20);
  const [snackToken, setSnackToken] = useState(1);
  const [playToken, setPlayToken] = useState(1);
  const [eventLogs, setEventLogs] = useState<PetEventLog[]>([]);
  const [lastAffinityChangedAt, setLastAffinityChangedAt] = useState<string | null>(null);

  const dragStateRef = useRef<DragState | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const transitionTimerRef = useRef<number | null>(null);
  const bootstrapRetryTimerRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);
  const lastSyncedSignatureRef = useRef<string | null>(null);
  const lastMotionProfileSignatureRef = useRef(
    JSON.stringify(ambientMotionProfile),
  );
  const suppressNextClickRef = useRef(false);
  const ambientMoveInFlightRef = useRef(false);
  const randomEventTimerRef = useRef<number | null>(null);

  const currentAsset = useMemo(() => {
    if (visualState === "sleep" && isSleepSettled) {
      return {
        ...pixelCatManifest.states.sleep,
        src: pixelCatManifest.sleepLoopSrc,
      };
    }

    return pixelCatManifest.states[visualState];
  }, [isSleepSettled, visualState]);
  const statusText = petStatusCopy[visualState];

  const setDraggingState = (nextValue: boolean) => {
    isDraggingRef.current = nextValue;
    setIsDragging(nextValue);
  };

  const clearTransitionTimer = () => {
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
  };

  const clearBootstrapRetryTimer = () => {
    if (bootstrapRetryTimerRef.current !== null) {
      window.clearTimeout(bootstrapRetryTimerRef.current);
      bootstrapRetryTimerRef.current = null;
    }
  };

  const syncPetState = (nextState: PetViewState) => {
    const signature = JSON.stringify(nextState);
    if (signature === lastSyncedSignatureRef.current) {
      return;
    }

    lastSyncedSignatureRef.current = signature;

    void desktopLocalService
      .updatePetState({
        businessState: nextState.businessState,
        visualState: nextState.visualState,
        mood: nextState.mood,
        trigger: nextState.trigger,
      })
      .catch((error) => {
        lastSyncedSignatureRef.current = null;
        setServiceLevel("degraded");
        setServiceLabel(
          error instanceof Error
            ? error.message
            : "local-service 同步失败。",
        );
        clearBootstrapRetryTimer();
        bootstrapRetryTimerRef.current = window.setTimeout(() => {
          void desktopLocalService.getBootstrap().then((bootstrap) => {
            setServiceLevel(bootstrap.status.level);
            setServiceLabel(bootstrap.status.label);
          });
        }, 3_000);
      });
  };

  const applyPetViewState = (
    nextState: PetViewState,
    options?: {
      persist?: boolean;
    },
  ) => {
    setVisualState(nextState.visualState);

    if (options?.persist === false) {
      return;
    }

    syncPetState(nextState);
  };

  const scheduleSleep = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
    }

    idleTimerRef.current = window.setTimeout(() => {
      if (!isDraggingRef.current) {
        applyPetViewState(petViewStates.sleep);
      }
    }, ambientMotionProfile.sleepDelayMs);
  }, [ambientMotionProfile.sleepDelayMs]);

  const playTransientState = (
    state: PetViewState,
    fallbackState: PetViewState = petViewStates.idle,
    durationMs?: number,
  ) => {
    clearTransitionTimer();
    applyPetViewState(state);

    transitionTimerRef.current = window.setTimeout(() => {
      applyPetViewState(fallbackState);
    }, durationMs ?? pixelCatManifest.states[state.visualState].durationHintMs ?? 700);
  };

  useEffect(() => {
    let disposed = false;

    const loadBootstrap = () => {
      void desktopLocalService.getBootstrap().then((bootstrap) => {
        if (disposed) {
          return;
        }

        setServiceLevel(bootstrap.status.level);
        setServiceLabel(bootstrap.status.label);

        if (bootstrap.settings) {
          setPetName(bootstrap.settings.pet.displayName);
          setPixelScale(bootstrap.settings.pet.pixelScale);
        }

        if (bootstrap.petState) {
          const restoredState = deriveRestoredViewState(
            bootstrap.petState.visualState,
          );
          applyPetViewState(restoredState, {
            persist: false,
          });
        }

        clearBootstrapRetryTimer();
        if (bootstrap.status.level !== "online") {
          bootstrapRetryTimerRef.current = window.setTimeout(() => {
            loadBootstrap();
          }, 3_000);
        }
      });
    };

    scheduleSleep();

    const runtimeInfoPromise = window.zhuochong?.runtime.getInfo();
    if (runtimeInfoPromise) {
      void runtimeInfoPromise.then((info) => {
        if (disposed) {
          return;
        }

        setRuntimeVersion(`${info.version} · ${info.platform}`);
      });
    }

    loadBootstrap();

    const unsubscribePetSettings = subscribePetSettingsUpdates((payload) => {
      if (disposed) {
        return;
      }

      setPetName(payload.displayName);
      setPixelScale(payload.pixelScale);
    });

    return () => {
      disposed = true;
      unsubscribePetSettings();

      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
      }

      clearTransitionTimer();
      clearBootstrapRetryTimer();
    };
  }, [scheduleSleep]);

  useEffect(() => {
    if (visualState !== "sleep") {
      setIsSleepSettled(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setIsSleepSettled(true);
    }, pixelCatManifest.states.sleep.durationHintMs ?? 1_200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [visualState]);

  const motionProfileSignature = JSON.stringify(ambientMotionProfile);

  useEffect(() => {
    if (lastMotionProfileSignatureRef.current === motionProfileSignature) {
      return;
    }

    lastMotionProfileSignatureRef.current = motionProfileSignature;
    if (visualState === "sleep" || isDraggingRef.current) {
      return;
    }

    scheduleSleep();
  }, [motionProfileSignature, scheduleSleep, visualState]);

  const metrics = useMemo<PetMetric[]>(
    () => [
      {
        key: "satiety",
        label: "饱食度",
        value: satiety,
        tone: "meal",
        hint: describeSatiety(satiety),
      },
      {
        key: "energy",
        label: "精力",
        value: energy,
        tone: "energy",
        hint: describeEnergy(energy),
      },
      {
        key: "health",
        label: "健康度",
        value: health,
        tone: "health",
        hint: describeHealth(health),
      },
      {
        key: "affinity",
        label: "好感度",
        value: affinity,
        tone: "heart",
        hint: describeAffinity(affinity),
      },
    ],
    [affinity, energy, health, satiety],
  );

  const resources = useMemo<PetResource[]>(
    () => [
      {
        key: "snackToken",
        label: "点心券",
        value: snackToken,
        hint: snackToken > 0 ? "可以拿来喂它。" : "需要靠随机事件获得。",
      },
      {
        key: "playToken",
        label: "玩耍券",
        value: playToken,
        hint: playToken > 0 ? "可以拿来陪它玩。" : "需要靠随机事件获得。",
      },
    ],
    [playToken, snackToken],
  );

  const affinityStage = useMemo(() => getAffinityStage(affinity), [affinity]);

  const affinityCooldownRemainingMs = useMemo(() => {
    if (!lastAffinityChangedAt) {
      return 0;
    }

    const lastChangedMs = Date.parse(lastAffinityChangedAt);
    if (!Number.isFinite(lastChangedMs)) {
      return 0;
    }

    return Math.max(0, affinityCooldownMs - (Date.now() - lastChangedMs));
  }, [lastAffinityChangedAt, eventLogs.length]);

  const actionAvailability = useMemo<PetActionAvailability>(
    () => ({
      canFeed: snackToken > 0,
      feedReason:
        snackToken > 0
          ? "有点心券，可以喂食。"
          : "缺少点心券，先等随机事件掉落。",
      canPlay: playToken > 0 && energy >= 25,
      playReason:
        playToken <= 0
          ? "缺少玩耍券，先等随机事件掉落。"
          : energy < 25
            ? "精力太低了，先让它休息一下。"
            : "可以玩耍，会消耗玩耍券和精力。",
      canRest: energy < 96,
      restReason:
        energy < 96
          ? "休息可以恢复精力和健康。"
          : "它现在精神很好，暂时不用强制休息。",
    }),
    [energy, playToken, snackToken],
  );

  const dragHint = useMemo(
    () =>
      isDragging
        ? "松手后会把窗口位置写回本地。"
        : serviceLevel === "online"
          ? "当前交互会写入 local-service。"
          : serviceLevel === "degraded"
            ? "local-service 未连通，当前先保留本地交互。"
            : "正在连接 local-service。",
    [isDragging, serviceLevel],
  );

  const appendEventLog = (event: PetEventLog) => {
    setEventLogs((current) => [event, ...current].slice(0, 6));
  };

  const persistCompanionEvent = useCallback(
    (request: CompanionEventRecordRequest) => {
      void desktopLocalService.recordCompanionEvent(request).catch(() => {
        // Companion memory sync is best-effort.
      });
    },
    [],
  );

  const applyAffinityChange = useCallback(
    (delta: number, reason: string) => {
      const result = applyAffinityDelta(affinity, delta, lastAffinityChangedAt);
      if (!result.applied) {
        return result;
      }

      const changedAt = nowIso();
      const nextAffinity = clampMetric(affinity + result.delta);
      setAffinity(nextAffinity);
      setLastAffinityChangedAt(changedAt);
      appendEventLog(
        createPetEventLog(
          result.delta > 0 ? "关系变化" : "关系波动",
          `${reason} ${result.reason}`,
          result.delta > 0 ? "positive" : "warning",
        ),
      );
      return result;
    },
    [affinity, lastAffinityChangedAt],
  );

  const triggerRandomEvent = useCallback(() => {
    const eventPool: Array<() => { event: PetEventLog; affinityDelta: number }> = [
      () => {
        setSnackToken((current) => current + 1);
        return {
          event: createPetEventLog(
            "捡到点心券",
            "它在桌边晃来晃去，竟然替你翻出了一张点心券。",
            "positive",
          ),
          affinityDelta: 1,
        };
      },
      () => {
        setPlayToken((current) => current + 1);
        setEnergy((current) => clampMetric(current + 6));
        return {
          event: createPetEventLog(
            "拿到玩耍券",
            "它自己兴奋了一阵，顺手攒出一张玩耍券。",
            "positive",
          ),
          affinityDelta: 1,
        };
      },
      () => {
        setSatiety((current) => clampMetric(current - 8));
        return {
          event: createPetEventLog(
            "有点饿了",
            "它悄悄提醒你：今天还没认真照顾它。",
            "warning",
          ),
          affinityDelta: -1,
        };
      },
      () => {
        setHealth((current) => clampMetric(current - 6));
        return {
          event: createPetEventLog(
            "状态波动",
            "它今天精神不太稳，需要你多关照一下。",
            "warning",
          ),
          affinityDelta: -2,
        };
      },
      () => ({
        event: createPetEventLog(
          "情绪平稳",
          "它今天没有特别的变化，只是安静陪着你。",
          "neutral",
        ),
        affinityDelta: 0,
      }),
    ];

    const result = eventPool[Math.floor(Math.random() * eventPool.length)]!();
    appendEventLog(result.event);
    const affinityResult = applyAffinityChange(
      result.affinityDelta,
      result.event.description,
    );
    persistCompanionEvent({
      type: "random_event",
      title: result.event.title,
      description: result.event.description,
      relationStage: resolveAffinityStageAfterAdjustment(affinity, affinityResult),
      affinityDelta: affinityResult.applied ? affinityResult.delta : 0,
      occurredAt: result.event.createdAt,
    });
    return result.event;
  }, [affinity, applyAffinityChange, persistCompanionEvent]);

  const handleChatAffinity = useCallback(
    (text: string) => {
      const assessment = assessChatAffinity(text);
      if (assessment.delta === 0) {
        return assessment;
      }

      const result = applyAffinityChange(assessment.delta, assessment.reason);
      persistCompanionEvent({
        type: "chat_affinity",
        title: result.delta > 0 ? "聊天升温" : "聊天波动",
        description: assessment.reason,
        relationStage: resolveAffinityStageAfterAdjustment(affinity, result),
        affinityDelta: result.applied ? result.delta : 0,
      });
      return {
        delta: result.delta,
        reason: result.reason,
      };
    },
    [affinity, applyAffinityChange, persistCompanionEvent],
  );

  const feedPet = () => {
    if (!actionAvailability.canFeed) {
      const failedEvent = createPetEventLog(
        "喂食失败",
        actionAvailability.feedReason,
        "warning",
      );
      appendEventLog(failedEvent);
      playTransientState(petViewStates.hurt, petViewStates.idle, 720);
      return failedEvent;
    }

    setSnackToken((current) => Math.max(0, current - 1));
    setSatiety((current) => clampMetric(current + 16));
    setEnergy((current) => clampMetric(current + 4));
    setHealth((current) => clampMetric(current + 3));
    playTransientState(petViewStates.click, petViewStates.idle, 780);
    scheduleSleep();
    const successEvent = createPetEventLog(
      "喂食成功",
      "它吃得很满足，但关系要慢慢培养。",
      "positive",
    );
    appendEventLog(successEvent);
    const affinityResult = applyAffinityChange(1, "你认真喂了它。");
    persistCompanionEvent({
      type: "care_action",
      title: successEvent.title,
      description: successEvent.description,
      relationStage: resolveAffinityStageAfterAdjustment(affinity, affinityResult),
      affinityDelta: affinityResult.applied ? affinityResult.delta : 0,
      occurredAt: successEvent.createdAt,
    });
    return successEvent;
  };

  const playWithPet = () => {
    if (!actionAvailability.canPlay) {
      const failedEvent = createPetEventLog(
        "玩耍失败",
        actionAvailability.playReason,
        "warning",
      );
      appendEventLog(failedEvent);
      playTransientState(petViewStates.hurt, petViewStates.idle, 720);
      return failedEvent;
    }

    setPlayToken((current) => Math.max(0, current - 1));
    setSatiety((current) => clampMetric(current - 4));
    setEnergy((current) => clampMetric(current - 10));
    setHealth((current) => clampMetric(current + 2));
    playTransientState(petViewStates.move, petViewStates.idle, 720);
    scheduleSleep();
    const successEvent = createPetEventLog(
      "玩耍成功",
      "它玩得很开心，但真正亲近需要长期积累。",
      "positive",
    );
    appendEventLog(successEvent);
    const affinityResult = applyAffinityChange(2, "你陪它玩了一会儿。");
    persistCompanionEvent({
      type: "care_action",
      title: successEvent.title,
      description: successEvent.description,
      relationStage: resolveAffinityStageAfterAdjustment(affinity, affinityResult),
      affinityDelta: affinityResult.applied ? affinityResult.delta : 0,
      occurredAt: successEvent.createdAt,
    });
    return successEvent;
  };

  const restPet = () => {
    if (!actionAvailability.canRest) {
      const skippedEvent = createPetEventLog(
        "暂时不用休息",
        actionAvailability.restReason,
        "neutral",
      );
      appendEventLog(skippedEvent);
      return skippedEvent;
    }

    clearTransitionTimer();
    setSatiety((current) => clampMetric(current - 2));
    setEnergy((current) => clampMetric(current + 18));
    setHealth((current) => clampMetric(current + 8));
    applyPetViewState(petViewStates.sleep);
    scheduleSleep();
    const successEvent = createPetEventLog(
      "休息恢复",
      "它安静睡了一会儿，精神和健康都恢复了一些。",
      "neutral",
    );
    appendEventLog(successEvent);
    persistCompanionEvent({
      type: "care_action",
      title: successEvent.title,
      description: successEvent.description,
      relationStage: affinityStage,
      affinityDelta: 0,
      occurredAt: successEvent.createdAt,
    });
    return successEvent;
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }

    void window.zhuochong?.petWindow.cancelMotion();
    suppressNextClickRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX,
      offsetY: event.clientY,
      hasMoved: false,
      lastScreenX: event.screenX,
    };

    scheduleSleep();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const shouldStartDrag =
      dragState.hasMoved || distanceExceeded(dragState, event);

    if (!shouldStartDrag) {
      return;
    }

    dragState.hasMoved = true;

    if (!isDragging) {
      clearTransitionTimer();
      setDraggingState(true);
      applyPetViewState(petViewStates.drag);
    }

    if (event.screenX !== dragState.lastScreenX) {
      setFacingDirection(event.screenX < dragState.lastScreenX ? "left" : "right");
      dragState.lastScreenX = event.screenX;
    }

    const nextX = Math.round(event.screenX - dragState.offsetX);
    const nextY = Math.round(event.screenY - dragState.offsetY);
    if (!isFiniteCoordinate(nextX) || !isFiniteCoordinate(nextY)) {
      return;
    }

    void window.zhuochong?.petWindow.moveTo({
      x: nextX,
      y: nextY,
    });
  };

  const finishInteraction = (event: ReactPointerEvent<HTMLElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (dragState.hasMoved) {
      suppressNextClickRef.current = true;
      setDraggingState(false);
      playTransientState(petViewStates.move, petViewStates.idle, 540);
    } else {
      playTransientState(petViewStates.click, petViewStates.idle);
    }

    scheduleSleep();
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLElement>) => {
    dragStateRef.current = null;
    suppressNextClickRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraggingState(false);
    applyPetViewState(petViewStates.idle);
    scheduleSleep();
  };

  const consumePetClick = () => {
    if (!suppressNextClickRef.current) {
      return false;
    }

    suppressNextClickRef.current = false;
    return true;
  };

  useEffect(() => {
    if (randomEventTimerRef.current !== null) {
      window.clearTimeout(randomEventTimerRef.current);
      randomEventTimerRef.current = null;
    }

    if (visualState === "sleep" || isDragging) {
      return;
    }

    randomEventTimerRef.current = window.setTimeout(() => {
      randomEventTimerRef.current = null;
      triggerRandomEvent();
    }, getAutoEventDelayMs(behaviorSettings.proactivityLevel));

    return () => {
      if (randomEventTimerRef.current !== null) {
        window.clearTimeout(randomEventTimerRef.current);
        randomEventTimerRef.current = null;
      }
    };
  }, [behaviorSettings.proactivityLevel, isDragging, triggerRandomEvent, visualState]);

  const wanderRandomly = useCallback(async () => {
    if (isDraggingRef.current || ambientMoveInFlightRef.current) {
      return false;
    }

    const currentPosition = await window.zhuochong?.petWindow.getPosition();
    if (!currentPosition) {
      return false;
    }

    const horizontalOffset =
      (Math.random() < 0.5 ? -1 : 1) *
      Math.round(
        ambientMotionProfile.minHorizontalOffset +
          Math.random() *
            Math.max(
              0,
              ambientMotionProfile.maxHorizontalOffset -
                ambientMotionProfile.minHorizontalOffset,
            ),
      );
    const verticalOffset = Math.round(
      -ambientMotionProfile.verticalOffsetRange +
        Math.random() * ambientMotionProfile.verticalOffsetRange * 2,
    );
    const distance = Math.hypot(horizontalOffset, verticalOffset);
    const movingState =
      distance >= ambientMotionProfile.runDistanceThreshold
        ? petViewStates.run
        : petViewStates.move;
    const durationMs = Math.round(
      ambientMotionProfile.baseDurationMs +
        distance * ambientMotionProfile.durationPerPixelMs,
    );

    ambientMoveInFlightRef.current = true;
    clearTransitionTimer();
    setFacingDirection(horizontalOffset < 0 ? "left" : "right");
    applyPetViewState(movingState, {
      persist: false,
    });

    try {
      await window.zhuochong?.petWindow.animateTo(
        {
          x: currentPosition.x + horizontalOffset,
          y: currentPosition.y + verticalOffset,
        },
        durationMs,
      );
      return true;
    } catch {
      return false;
    } finally {
      ambientMoveInFlightRef.current = false;
      if (!isDraggingRef.current) {
        applyPetViewState(petViewStates.idle, {
          persist: false,
        });
      }
    }
  }, [ambientMotionProfile]);

  return {
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
    handlePointerUp: finishInteraction,
    handleChatAffinity,
    isDragging,
    metrics,
    petName,
    pixelScale,
    playWithPet,
    resources,
    restPet,
    runtimeVersion,
    serviceLabel,
    serviceLevel,
    statusText,
    triggerRandomEvent,
    visualState,
    wanderRandomly,
  };
};
