import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import type {
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
  key: "satiety" | "energy" | "affinity";
  label: string;
  value: number;
  tone: "meal" | "energy" | "heart";
  hint: string;
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
} satisfies Record<"idle" | "sleep" | "click" | "drag" | "move" | "run", PetViewState>;

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
  const [affinity, setAffinity] = useState(64);

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
  }, []);

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
        key: "affinity",
        label: "亲密度",
        value: affinity,
        tone: "heart",
        hint: describeAffinity(affinity),
      },
    ],
    [affinity, energy, satiety],
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

  const feedPet = () => {
    setSatiety((current) => clampMetric(current + 16));
    setEnergy((current) => clampMetric(current + 4));
    setAffinity((current) => clampMetric(current + 3));
    playTransientState(petViewStates.click, petViewStates.idle, 780);
    scheduleSleep();
  };

  const playWithPet = () => {
    setSatiety((current) => clampMetric(current - 4));
    setEnergy((current) => clampMetric(current - 10));
    setAffinity((current) => clampMetric(current + 10));
    playTransientState(petViewStates.move, petViewStates.idle, 720);
    scheduleSleep();
  };

  const restPet = () => {
    clearTransitionTimer();
    setSatiety((current) => clampMetric(current - 2));
    setEnergy((current) => clampMetric(current + 18));
    setAffinity((current) => clampMetric(current + 2));
    applyPetViewState(petViewStates.sleep);
    scheduleSleep();
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
      await window.zhuochong?.petWindow.animateTo({
        x: currentPosition.x + horizontalOffset,
        y: currentPosition.y + verticalOffset,
      }, durationMs);
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
    consumePetClick,
    currentAsset,
    dragHint,
    feedPet,
    handlePointerCancel,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp: finishInteraction,
    isDragging,
    metrics,
    petName,
    pixelScale,
    playWithPet,
    restPet,
    runtimeVersion,
    serviceLabel,
    serviceLevel,
    statusText,
    visualState,
    facingDirection,
    wanderRandomly,
  };
};
