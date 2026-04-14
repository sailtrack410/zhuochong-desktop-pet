import { useEffect, useState } from "react";

const getFallbackResolvedTheme = (): ZhuochongShellResolvedTheme => {
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }

  return "light";
};

const defaultShellAppearanceState: ZhuochongShellAppearanceState = {
  themeMode: "system",
  resolvedTheme: getFallbackResolvedTheme(),
};

const applyDocumentTheme = (appearance: ZhuochongShellAppearanceState) => {
  document.documentElement.dataset.theme = appearance.resolvedTheme;
  document.documentElement.dataset.themeMode = appearance.themeMode;
};

export const useShellAppearance = () => {
  const [appearance, setAppearance] = useState<ZhuochongShellAppearanceState>(
    defaultShellAppearanceState,
  );
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    applyDocumentTheme(appearance);
  }, [appearance]);

  useEffect(() => {
    let isActive = true;

    const loadAppearance = async () => {
      try {
        const nextAppearance = await window.zhuochong?.desktop?.getAppearance?.();
        if (isActive && nextAppearance) {
          setAppearance(nextAppearance);
        }
      } finally {
        if (isActive) {
          setLoaded(true);
        }
      }
    };

    void loadAppearance();

    const unsubscribe = window.zhuochong?.desktop?.subscribeAppearanceChanged?.(
      (nextAppearance) => {
        if (!isActive) {
          return;
        }

        setAppearance(nextAppearance);
        setLoaded(true);
      },
    );

    return () => {
      isActive = false;
      unsubscribe?.();
    };
  }, []);

  return {
    appearance,
    loaded,
  };
};
