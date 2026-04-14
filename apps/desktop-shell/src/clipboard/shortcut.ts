import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export const defaultClipboardAccelerator =
  navigator.platform.toLowerCase().includes("mac")
    ? "Control+Alt+V"
    : "CommandOrControl+Shift+V";

const modifierLabelMap: Record<string, string> = {
  Command: "Cmd",
  CommandOrControl: navigator.platform.toLowerCase().includes("mac")
    ? "Cmd"
    : "Ctrl",
  Control: "Ctrl",
  Alt: navigator.platform.toLowerCase().includes("mac") ? "Option" : "Alt",
  Option: "Option",
  Shift: "Shift",
  Super: "Super",
};

const keyLabelMap: Record<string, string> = {
  Up: "Up",
  Down: "Down",
  Left: "Left",
  Right: "Right",
  Escape: "Esc",
  Space: "Space",
  Return: "Enter",
};

const reservedModifierKeys = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "Command",
  "CommandOrControl",
]);

const normalizeAcceleratorKey = (
  event: ReactKeyboardEvent<HTMLInputElement>,
): string | null => {
  const key = event.key;

  if (!key || reservedModifierKeys.has(key)) {
    return null;
  }

  if (key === " ") {
    return "Space";
  }

  if (key === "ArrowUp") {
    return "Up";
  }

  if (key === "ArrowDown") {
    return "Down";
  }

  if (key === "ArrowLeft") {
    return "Left";
  }

  if (key === "ArrowRight") {
    return "Right";
  }

  if (/^F\d{1,2}$/i.test(key)) {
    return key.toUpperCase();
  }

  if (/^[a-z0-9]$/i.test(key)) {
    return key.toUpperCase();
  }

  if (
    key === "Tab" ||
    key === "Enter" ||
    key === "Escape" ||
    key === "Backspace" ||
    key === "Delete" ||
    key === "Home" ||
    key === "End" ||
    key === "PageUp" ||
    key === "PageDown"
  ) {
    return key === "Enter" ? "Return" : key;
  }

  return null;
};

export const getAcceleratorFromKeyEvent = (
  event: ReactKeyboardEvent<HTMLInputElement>,
): string | null => {
  const key = normalizeAcceleratorKey(event);
  const modifiers: string[] = [];

  if (navigator.platform.toLowerCase().includes("mac")) {
    if (event.metaKey) {
      modifiers.push("Command");
    }

    if (event.ctrlKey) {
      modifiers.push("Control");
    }
  } else if (event.ctrlKey || event.metaKey) {
    modifiers.push("CommandOrControl");
  }

  if (event.altKey) {
    modifiers.push("Alt");
  }

  if (event.shiftKey) {
    modifiers.push("Shift");
  }

  if (!key || modifiers.length === 0) {
    return null;
  }

  return [...modifiers, key].join("+");
};

export const formatAcceleratorLabel = (accelerator: string): string =>
  accelerator
    .split("+")
    .map((segment) => modifierLabelMap[segment] ?? keyLabelMap[segment] ?? segment)
    .join(" + ");
