import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

const STORAGE_KEY = "paperclip:panel-visible";

interface PanelContextValue {
  panelContent: ReactNode | null;
  panelVisible: boolean;
  /** Optional header title for the pane; panel content sets it so the
   * classic pane's corner label can follow the active tab (Plan, Progress…).
   * Null falls back to the pane's default title. */
  panelTitle: string | null;
  setPanelTitle: (title: string | null) => void;
  openPanel: (content: ReactNode) => void;
  closePanel: () => void;
  setPanelVisible: (visible: boolean) => void;
  togglePanelVisible: () => void;
}

const PanelContext = createContext<PanelContextValue | null>(null);

function readPreference(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

function writePreference(visible: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, String(visible));
  } catch {
    // Ignore storage failures.
  }
}

export function PanelProvider({ children }: { children: ReactNode }) {
  const [panelContent, setPanelContent] = useState<ReactNode | null>(null);
  const [panelVisible, setPanelVisibleState] = useState(readPreference);
  const [panelTitle, setPanelTitleState] = useState<string | null>(null);

  const openPanel = useCallback((content: ReactNode) => {
    setPanelContent(content);
    setPanelTitleState(null);
  }, []);

  const closePanel = useCallback(() => {
    setPanelContent(null);
    setPanelTitleState(null);
  }, []);

  const setPanelTitle = useCallback((title: string | null) => {
    setPanelTitleState(title);
  }, []);

  const setPanelVisible = useCallback((visible: boolean) => {
    setPanelVisibleState(visible);
    writePreference(visible);
  }, []);

  const togglePanelVisible = useCallback(() => {
    setPanelVisibleState((prev) => {
      const next = !prev;
      writePreference(next);
      return next;
    });
  }, []);

  return (
    <PanelContext.Provider
      value={{ panelContent, panelVisible, panelTitle, setPanelTitle, openPanel, closePanel, setPanelVisible, togglePanelVisible }}
    >
      {children}
    </PanelContext.Provider>
  );
}

export function usePanel() {
  const ctx = useContext(PanelContext);
  if (!ctx) {
    throw new Error("usePanel must be used within PanelProvider");
  }
  return ctx;
}
