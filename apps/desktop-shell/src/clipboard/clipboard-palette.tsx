import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import {
  defaultClipboardAccelerator,
  formatAcceleratorLabel,
} from "./shortcut.js";
import { useShellAppearance } from "../appearance/use-shell-appearance.js";

const formatCopiedAt = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const formatTextMeta = (text: string) => {
  const lineCount = text.split(/\r?\n/).length;
  const length = text.length;
  return `${lineCount} 行 · ${length} 字`;
};

const formatImageMeta = (
  item: ZhuochongClipboardImageHistoryItem,
) => `${item.width} × ${item.height} 图片`;

const toClipboardImageSrc = (pngBase64: string) =>
  `data:image/png;base64,${pngBase64}`;

export const ClipboardPalette = () => {
  useShellAppearance();
  const [clipboardState, setClipboardState] =
    useState<ZhuochongClipboardState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [isClearing, setIsClearing] = useState(false);
  const [isUpdatingPanelPinned, setIsUpdatingPanelPinned] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());

  const shortcutLabel = useMemo(() => {
    const accelerator =
      clipboardState?.shortcut.accelerator ||
      clipboardState?.shortcut.defaultAccelerator ||
      defaultClipboardAccelerator;
    return formatAcceleratorLabel(accelerator);
  }, [clipboardState]);

  const history = clipboardState?.history ?? [];
  const clearableCount = useMemo(
    () => history.filter((item) => !item.pinnedAt).length,
    [history],
  );

  useEffect(() => {
    if (history.length === 0) {
      setSelectedItemId(null);
      return;
    }

    if (
      selectedItemId &&
      history.some((item) => item.itemId === selectedItemId)
    ) {
      return;
    }

    setSelectedItemId(history[0]?.itemId ?? null);
  }, [history, selectedItemId]);

  useEffect(() => {
    if (!selectedItemId) {
      return;
    }

    const target = itemRefs.current.get(selectedItemId);
    target?.scrollIntoView({
      block: "nearest",
    });
  }, [selectedItemId]);

  const loadState = async () => {
    try {
      const nextState = await window.zhuochong?.clipboard?.getState?.();
      if (!nextState) {
        throw new Error("剪贴板桥接不可用。");
      }

      setClipboardState(nextState);
      setErrorText(null);
    } catch (error) {
      setErrorText(
        error instanceof Error ? error.message : "读取剪贴板历史失败。",
      );
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadState();

    const unsubscribe = window.zhuochong?.clipboard?.subscribeStateChanged?.(
      (nextState) => {
        setClipboardState(nextState);
        setErrorText(null);
        setIsLoading(false);
      },
    );

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void window.zhuochong?.clipboard?.hidePanel?.();
        return;
      }

      if (history.length === 0) {
        return;
      }

      const selectedIndex = history.findIndex(
        (item) => item.itemId === selectedItemId,
      );
      const safeIndex = selectedIndex >= 0 ? selectedIndex : 0;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        const nextIndex = Math.min(history.length - 1, safeIndex + 1);
        setSelectedItemId(history[nextIndex]?.itemId ?? null);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        const nextIndex = Math.max(0, safeIndex - 1);
        setSelectedItemId(history[nextIndex]?.itemId ?? null);
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        const targetItem = history[safeIndex];
        if (targetItem) {
          void handleUseItem(targetItem.itemId);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      unsubscribe?.();
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [history, selectedItemId]);

  const handleUseItem = async (itemId: string) => {
    setPendingItemId(itemId);

    try {
      const result = await window.zhuochong?.clipboard?.writeHistoryItem?.(itemId);
      if (!result?.didAutoPaste) {
        setErrorText(
          result?.fallbackReason === "permission_required"
            ? "已写入剪贴板，但当前没有辅助功能权限，暂时还不能自动粘贴。"
            : "已写入剪贴板，当前没有完成自动粘贴。",
        );
      } else {
        setErrorText(null);
      }
    } catch (error) {
      setErrorText(
        error instanceof Error ? error.message : "写入剪贴板失败。",
      );
    } finally {
      setPendingItemId(null);
    }
  };

  const handleDeleteItem = async (
    event: ReactMouseEvent<HTMLButtonElement>,
    itemId: string,
  ) => {
    event.stopPropagation();
    setPendingItemId(itemId);

    try {
      const nextState = await window.zhuochong?.clipboard?.deleteHistoryItem?.(itemId);
      if (nextState) {
        setClipboardState(nextState);
        setErrorText(null);
      }
    } catch (error) {
      setErrorText(
        error instanceof Error ? error.message : "删除历史失败。",
      );
    } finally {
      setPendingItemId(null);
    }
  };

  const handleTogglePinned = async (
    event: ReactMouseEvent<HTMLButtonElement>,
    itemId: string,
  ) => {
    event.stopPropagation();
    setPendingItemId(itemId);

    try {
      const nextState = await window.zhuochong?.clipboard?.togglePinned?.(itemId);
      if (nextState) {
        setClipboardState(nextState);
        setErrorText(null);
      }
    } catch (error) {
      setErrorText(
        error instanceof Error ? error.message : "更新常用项失败。",
      );
    } finally {
      setPendingItemId(null);
    }
  };

  const handleClearHistory = async () => {
    setIsClearing(true);

    try {
      const nextState = await window.zhuochong?.clipboard?.clearHistory?.();
      if (nextState) {
        setClipboardState(nextState);
        setErrorText(null);
      }
    } catch (error) {
      setErrorText(
        error instanceof Error ? error.message : "清空剪贴板历史失败。",
      );
    } finally {
      setIsClearing(false);
    }
  };

  const handleTogglePanelPinned = async () => {
    setIsUpdatingPanelPinned(true);

    try {
      const nextState = await window.zhuochong?.clipboard?.togglePanelPinned?.();
      if (!nextState) {
        throw new Error("剪贴板桥接不可用。");
      }

      setClipboardState(nextState);
      setErrorText(null);
    } catch (error) {
      setErrorText(
        error instanceof Error ? error.message : "更新剪贴板面板状态失败。",
      );
    } finally {
      setIsUpdatingPanelPinned(false);
    }
  };

  return (
    <main className="pet-root mode-clipboard">
      <section className="clipboard-palette">
        <div className="clipboard-toolbar">
          <span className="clipboard-toolbar-hint">
            {clipboardState?.shortcut.isRegistered
              ? `剪贴板历史 · ${shortcutLabel} 呼出 · ↑ ↓ 选择 · Enter 粘贴 · Esc 关闭`
              : "剪贴板历史 · 快捷键未注册，请回设置页检查是否冲突"}
          </span>
          <div className="clipboard-toolbar-actions">
            <button
              type="button"
              className={`clipboard-toolbar-pin ${
                clipboardState?.panel.pinned ? "is-active" : ""
              }`}
              onClick={() => void handleTogglePanelPinned()}
              disabled={isUpdatingPanelPinned || !clipboardState}
              title="钉住后失去焦点也不会自动收起"
            >
              {isUpdatingPanelPinned
                ? "处理中..."
                : clipboardState?.panel.pinned
                  ? "已钉住"
                  : "钉在桌面"}
            </button>
            <button
              type="button"
              className="clipboard-clear-btn"
              onClick={() => void handleClearHistory()}
              disabled={isClearing || !clipboardState || clearableCount === 0}
              title="仅清空普通历史，常用项会保留"
            >
              {isClearing ? "清空中..." : "清空历史"}
            </button>
          </div>
        </div>

        {errorText ? (
          <p className="clipboard-error">{errorText}</p>
        ) : null}

        <section className="clipboard-list" aria-live="polite">
          {isLoading ? (
            <article className="clipboard-empty">
              <p className="clipboard-empty-title">正在读取剪贴板历史...</p>
            </article>
          ) : history.length > 0 ? (
            history.map((item) => (
              <article
                key={item.itemId}
                ref={(node) => {
                  if (node) {
                    itemRefs.current.set(item.itemId, node);
                    return;
                  }

                  itemRefs.current.delete(item.itemId);
                }}
                className={`clipboard-item ${
                  item.itemId === selectedItemId ? "is-selected" : ""
                }`}
              >
                <button
                  type="button"
                    className="clipboard-item-main"
                  onClick={() => void handleUseItem(item.itemId)}
                  onMouseEnter={() => setSelectedItemId(item.itemId)}
                  disabled={pendingItemId === item.itemId}
                  title={item.kind === "text" ? item.text : "图片剪贴板"}
                >
                  <div className="clipboard-item-body">
                    {item.kind === "text" ? (
                      <p className="clipboard-item-preview">{item.preview}</p>
                    ) : (
                      <div className="clipboard-item-image-shell">
                        <img
                          className="clipboard-item-image"
                          src={toClipboardImageSrc(item.pngBase64)}
                          alt={`剪贴板图片 ${item.width}x${item.height}`}
                        />
                      </div>
                    )}
                    <p className="clipboard-item-meta">
                      <span>
                        {item.kind === "text"
                          ? formatTextMeta(item.text)
                          : formatImageMeta(item)}
                      </span>
                      <span>{formatCopiedAt(item.copiedAt)}</span>
                    </p>
                  </div>
                </button>
                <div className="clipboard-item-actions">
                  <button
                    type="button"
                    className={`clipboard-item-pin ${
                      item.pinnedAt ? "is-active" : ""
                    }`}
                    onClick={(event) => void handleTogglePinned(event, item.itemId)}
                    disabled={pendingItemId === item.itemId}
                    aria-label={item.pinnedAt ? "取消置顶" : "置顶到常用项"}
                  >
                    {item.pinnedAt ? "已置顶" : "置顶"}
                  </button>
                  <span className="clipboard-item-use">
                    {pendingItemId === item.itemId ? "处理中..." : "粘贴"}
                  </span>
                  <button
                    type="button"
                    className="clipboard-item-delete"
                    onClick={(event) => void handleDeleteItem(event, item.itemId)}
                    disabled={pendingItemId === item.itemId}
                    aria-label="删除这一条"
                  >
                    删除
                  </button>
                </div>
              </article>
            ))
          ) : (
            <article className="clipboard-empty">
              <p className="clipboard-empty-title">还没有剪贴板历史</p>
              <p className="clipboard-empty-copy">
                先去复制一段文字或图片，再按 {shortcutLabel} 打开这里。
              </p>
            </article>
          )}
        </section>
      </section>
    </main>
  );
};
