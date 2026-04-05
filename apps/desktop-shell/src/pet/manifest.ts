import type { PetVisualState } from "@zhuochong/ui-contracts";

import rawManifest from "../../../../assets/pets/pixel-cat/manifest.json";
import clickGif from "../../../../assets/pets/pixel-cat/runtime/states/click.gif";
import dragGif from "../../../../assets/pets/pixel-cat/runtime/states/drag.gif";
import hidePng from "../../../../assets/pets/pixel-cat/runtime/states/hide.png";
import hurtGif from "../../../../assets/pets/pixel-cat/runtime/states/hurt.gif";
import idleGif from "../../../../assets/pets/pixel-cat/runtime/states/idle.gif";
import moveGif from "../../../../assets/pets/pixel-cat/runtime/states/move.gif";
import runGif from "../../../../assets/pets/pixel-cat/runtime/states/run.gif";
import sleepGif from "../../../../assets/pets/pixel-cat/runtime/states/sleep.gif";
import sleepRestGif from "../../../../assets/pets/pixel-cat/runtime/states/sleep-rest.gif";

type RuntimeStateConfig = {
  src: string;
  loop: boolean;
  durationHintMs?: number;
  nextState?: PetVisualState;
};

type RuntimeManifest = {
  characterId: string;
  displayName: string;
  version: number;
  frameSize: {
    width: number;
    height: number;
  };
  defaultState: PetVisualState;
  chatStateFallback: PetVisualState;
  states: Record<PetVisualState, RuntimeStateConfig>;
  uiMappings: Record<string, PetVisualState>;
};

type ResolvedRuntimeManifest = RuntimeManifest & {
  sleepLoopSrc: string;
};

const sourceManifest = rawManifest as RuntimeManifest;

const assetBySource: Record<string, string> = {
  "./runtime/states/click.gif": clickGif,
  "./runtime/states/drag.gif": dragGif,
  "./runtime/states/hide.png": hidePng,
  "./runtime/states/hurt.gif": hurtGif,
  "./runtime/states/idle.gif": idleGif,
  "./runtime/states/move.gif": moveGif,
  "./runtime/states/run.gif": runGif,
  "./runtime/states/sleep.gif": sleepGif,
};

const resolveStateAsset = (src: string): string => {
  const asset = assetBySource[src];

  if (!asset) {
    throw new Error(`Pet asset is not mapped: ${src}`);
  }

  return asset;
};

export const pixelCatManifest: ResolvedRuntimeManifest = {
  ...sourceManifest,
  sleepLoopSrc: sleepRestGif,
  states: Object.fromEntries(
    Object.entries(sourceManifest.states).map(([stateName, config]) => [
      stateName,
      {
        ...config,
        src: resolveStateAsset(config.src),
      },
    ]),
  ) as Record<PetVisualState, RuntimeStateConfig>,
};

export const petStatusCopy: Record<PetVisualState, string> = {
  idle: "单击摸摸头，拖拽换个落点。",
  sleep: "暂时安静一下，等你回来。",
  move: "重新落位中。",
  run: "快速切换位置。",
  drag: "拖动中，松手后会记住这里。",
  click: "收到互动了。",
  hurt: "这一步先不做强打扰反馈。",
  hide: "缩在角落里待机。",
};
