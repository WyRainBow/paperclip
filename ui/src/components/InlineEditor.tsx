import { useState, useRef, useEffect, useCallback } from "react";
import { Pencil } from "lucide-react";
import { cn } from "../lib/utils";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "./MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { useAutosaveIndicator } from "../hooks/useAutosaveIndicator";
import { FoldCurtain } from "./FoldCurtain";

interface InlineEditorProps {
  value: string;
  onSave: (value: string) => void | Promise<unknown>;
  as?: "h1" | "h2" | "p" | "span";
  className?: string;
  placeholder?: string;
  multiline?: boolean;
  imageUploadHandler?: (file: File) => Promise<string>;
  /** Called when a non-image file is dropped onto the editor. */
  onDropFile?: (file: File) => Promise<void>;
  mentions?: MentionOption[];
  nullable?: boolean;
  /** When true, long display-mode markdown is clipped with a fade curtain that expands on click. */
  foldable?: boolean;
  /**
   * Optional host-resolved external object metadata. Forwarded to the read-mode
   * `MarkdownBody` so resolved URLs render with the inline status icon prefix.
   */
  externalReferences?: MarkdownExternalReferenceMap;
  /**
   * Mount the multiline editor already in edit mode, focused — for hosts whose
   * own affordance opens the editor (the description bubble's pencil, PAP-375).
   */
  defaultEditing?: boolean;
  /** Notified when the multiline editor swaps between display and edit mode. */
  onEditingChange?: (editing: boolean) => void;
  /**
   * Require an explicit pencil press to start editing, instead of treating any
   * click on the content as one (MUL-461).
   *
   * Click-to-edit reads well on a short single-line field, where there is
   * nothing to select anyway. On a long body it fights the reader: selecting a
   * sentence, or missing a link, swaps the rendered markdown for a textarea
   * mid-gesture. The task-chat description bubble already worked this way, so
   * this brings the classic layout in line with it rather than inventing a
   * second interaction.
   */
  explicitEdit?: boolean;
}

/** Shared padding so display and edit modes occupy the exact same box. */
const pad = "px-1 -mx-1";
const markdownPad = "px-1";
const AUTOSAVE_DEBOUNCE_MS = 900;

export function queueContainedBlurCommit(container: HTMLDivElement, onCommit: () => void) {
  let frameId = requestAnimationFrame(() => {
    frameId = requestAnimationFrame(() => {
      frameId = 0;
      const active = document.activeElement;
      if (active instanceof Node && container.contains(active)) return;
      onCommit();
    });
  });

  return () => {
    if (frameId === 0) return;
    cancelAnimationFrame(frameId);
    frameId = 0;
  };
}

export function InlineEditor({
  value,
  onSave,
  as: Tag = "span",
  className,
  placeholder = "Click to edit...",
  multiline = false,
  nullable = false,
  imageUploadHandler,
  onDropFile,
  mentions,
  foldable = false,
  externalReferences,
  defaultEditing = false,
  onEditingChange,
  explicitEdit = false,
}: InlineEditorProps) {
  const [editing, setEditing] = useState(false);
  const [multilineEditing, setMultilineEditing] = useState(multiline && defaultEditing);
  const [multilineFocused, setMultilineFocused] = useState(false);
  const [draft, setDraft] = useState(value);
  const lastPropValueRef = useRef(value);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const markdownRef = useRef<MarkdownEditorRef>(null);
  const autosaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurCommitFrameRef = useRef<(() => void) | null>(null);
  const pendingFocusFrameRef = useRef<number | null>(null);
  const justEnteredEditRef = useRef(multiline && defaultEditing);
  const hasBeenFocusedRef = useRef(false);
  const {
    state: autosaveState,
    markDirty,
    reset,
    runSave,
  } = useAutosaveIndicator();

  useEffect(() => {
    const previousValue = lastPropValueRef.current;
    lastPropValueRef.current = value;
    setDraft((currentDraft) => {
      if (multiline && multilineFocused && currentDraft !== previousValue) {
        return currentDraft;
      }
      return value;
    });
  }, [value, multiline, multilineFocused]);

  useEffect(() => {
    return () => {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
      if (blurCommitFrameRef.current !== null) {
        blurCommitFrameRef.current();
        blurCommitFrameRef.current = null;
      }
      if (pendingFocusFrameRef.current !== null) {
        cancelAnimationFrame(pendingFocusFrameRef.current);
        pendingFocusFrameRef.current = null;
      }
    };
  }, []);

  const autoSize = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
      if (inputRef.current instanceof HTMLTextAreaElement) {
        autoSize(inputRef.current);
      }
    }
  }, [editing, autoSize]);

  useEffect(() => {
    if (!multilineEditing || !multiline) return;
    if (!justEnteredEditRef.current) return;
    justEnteredEditRef.current = false;
    if (pendingFocusFrameRef.current !== null) {
      cancelAnimationFrame(pendingFocusFrameRef.current);
    }
    pendingFocusFrameRef.current = requestAnimationFrame(() => {
      pendingFocusFrameRef.current = null;
      markdownRef.current?.focus();
    });
    return () => {
      if (pendingFocusFrameRef.current !== null) {
        cancelAnimationFrame(pendingFocusFrameRef.current);
        pendingFocusFrameRef.current = null;
      }
    };
  }, [multilineEditing, multiline]);

  // Once the editor has been focused at least once, it's blurred, and any
  // autosave has settled, swap back to the MarkdownBody preview so inline
  // issue refs render with status + quicklook.
  useEffect(() => {
    if (multilineFocused) {
      hasBeenFocusedRef.current = true;
      return;
    }
    if (!multiline || !multilineEditing) return;
    if (!hasBeenFocusedRef.current) return;
    if (autosaveState !== "idle") return;
    hasBeenFocusedRef.current = false;
    setMultilineEditing(false);
    onEditingChange?.(false);
  }, [multiline, multilineEditing, multilineFocused, autosaveState, onEditingChange]);


  const commit = useCallback(async (nextValue = draft) => {
    const valueToSave = nextValue.trim();
    const valueChanged = valueToSave !== value;
    const shouldSave = nullable
      ? valueChanged
      : Boolean(valueToSave && valueChanged);
    if (shouldSave) {
      await Promise.resolve(onSave(valueToSave));
    } else {
      setDraft(value);
    }
    if (!multiline) {
      setEditing(false);
    }
  }, [draft, multiline, nullable, onSave, value]);

  /** Multiline blur/submit: show autosave indicator when persisting */
  const finalizeMultilineBlurOrSubmit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed === value) {
      reset();
      void commit();
      return;
    }
    if (!trimmed && !nullable) {
      reset();
      void commit();
      return;
    }
    void runSave(() => commit());
  }, [commit, draft, nullable, reset, runSave, value]);

  const cancelPendingBlurCommit = useCallback(() => {
    if (blurCommitFrameRef.current === null) return;
    blurCommitFrameRef.current();
    blurCommitFrameRef.current = null;
  }, []);

  const scheduleBlurCommit = useCallback((container: HTMLDivElement) => {
    cancelPendingBlurCommit();
    blurCommitFrameRef.current = queueContainedBlurCommit(container, () => {
      blurCommitFrameRef.current = null;
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
      setMultilineFocused(false);
      finalizeMultilineBlurOrSubmit();
    });
  }, [cancelPendingBlurCommit, finalizeMultilineBlurOrSubmit]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !multiline) {
      e.preventDefault();
      void commit();
    }
    if (e.key === "Escape") {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
      reset();
      setDraft(value);
      if (multiline) {
        setMultilineFocused(false);
        setMultilineEditing(false);
        onEditingChange?.(false);
        hasBeenFocusedRef.current = false;
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      } else {
        setEditing(false);
      }
    }
  }

  useEffect(() => {
    if (!multiline) return;
    if (!multilineFocused) return;
    const trimmed = draft.trim();
    // Nullable: empty draft can still be a real edit (clearing); only skip debounce when unchanged or empty is invalid.
    if (trimmed === value || (!trimmed && !nullable)) {
      if (autosaveState !== "saved") {
        reset();
      }
      return;
    }
    markDirty();
    if (autosaveDebounceRef.current) {
      clearTimeout(autosaveDebounceRef.current);
    }
    autosaveDebounceRef.current = setTimeout(() => {
      void runSave(() => commit(trimmed));
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
    };
  }, [autosaveState, commit, draft, markDirty, multiline, multilineFocused, nullable, reset, runSave, value]);

  if (multiline) {
    const previewValue = autosaveState === "saved" || autosaveState === "idle" ? draft : value;
    const hasValue = Boolean(previewValue.trim());
    const showEditor = multilineEditing || multilineFocused || !hasValue;

    if (!showEditor) {
      const enterEditMode = () => {
        if (multilineEditing) return;
        justEnteredEditRef.current = true;
        setMultilineEditing(true);
        onEditingChange?.(true);
      };
      // 显式编辑 (MUL-461): the body is read and copied far more often than it
      // is edited, and click-to-edit turned every text selection and every
      // missed link into an accidental edit. Under `explicitEdit` the preview
      // is inert — no click, no drag, no keyboard activation, and no textbox
      // role, because announcing an editable box that cannot be typed into is
      // worse than announcing nothing.
      const previewInteractions = explicitEdit
        ? {}
        : {
          onClick: (event: React.MouseEvent<HTMLDivElement>) => {
            if (event.defaultPrevented) return;
            const target = event.target as HTMLElement | null;
            if (target && target.closest("a,button,[data-mention-kind],[data-radix-popper-content-wrapper]")) {
              return;
            }
            enterEditMode();
          },
          onDragEnter: () => enterEditMode(),
          onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            enterEditMode();
          },
          role: "textbox" as const,
          "aria-multiline": "true" as const,
          "aria-label": placeholder,
          tabIndex: 0,
        };
      return (
        <div
          className={cn(
            markdownPad,
            "rounded",
            explicitEdit ? "group/inline-editor relative" : "transition-colors hover:bg-accent/20",
          )}
          {...previewInteractions}
        >
          {explicitEdit ? (
            // Dimmed rather than hidden: hover-only would hide the only way in
            // on touch, and this is now the only way in.
            <button
              type="button"
              className="absolute right-0 top-0 z-10 rounded-md bg-background/80 p-1 text-muted-foreground opacity-40 transition-opacity hover:bg-accent/50 hover:text-foreground hover:opacity-100 focus-visible:opacity-100 group-hover/inline-editor:opacity-100"
              onClick={enterEditMode}
              aria-label="编辑正文"
              title="编辑正文"
              data-testid="inline-editor-edit"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
          {foldable ? (
            // An issue's own description is the point of the screen, so it
            // opens read; the curtain stays available to collapse it.
            <FoldCurtain defaultExpanded>
              <MarkdownBody
                className={cn("paperclip-edit-in-place-content", className)}
                externalReferences={externalReferences}
              >
                {previewValue}
              </MarkdownBody>
            </FoldCurtain>
          ) : (
            <MarkdownBody
              className={cn("paperclip-edit-in-place-content", className)}
              externalReferences={externalReferences}
            >
              {previewValue}
            </MarkdownBody>
          )}
        </div>
      );
    }

    return (
      <div
        className={cn(
          markdownPad,
          "rounded transition-colors",
          multilineFocused ? "bg-transparent" : "hover:bg-accent/20",
        )}
        onFocusCapture={(event) => {
          // Ignore focus events where the active element isn't actually inside
          // the wrapper (React 19 can emit a synthetic focus after a blur).
          const active = document.activeElement;
          if (!(active instanceof Node) || !event.currentTarget.contains(active)) return;
          cancelPendingBlurCommit();
          setMultilineFocused(true);
        }}
        onBlurCapture={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          if (pendingFocusFrameRef.current !== null) {
            cancelAnimationFrame(pendingFocusFrameRef.current);
            pendingFocusFrameRef.current = null;
          }
          scheduleBlurCommit(event.currentTarget);
        }}
        onKeyDown={handleKeyDown}
      >
        <MarkdownEditor
          ref={markdownRef}
          value={draft}
          onChange={setDraft}
          placeholder={placeholder}
          bordered={false}
          className="bg-transparent"
          contentClassName={cn("paperclip-edit-in-place-content", className)}
          imageUploadHandler={imageUploadHandler}
          onDropFile={onDropFile}
          mentions={mentions}
          onSubmit={() => {
            finalizeMultilineBlurOrSubmit();
          }}
        />
        <div className="flex min-h-4 items-center justify-end pr-1">
          <span
            className={cn(
              "text-(length:--text-micro) transition-opacity duration-150",
              autosaveState === "error" ? "text-destructive" : "text-muted-foreground",
              autosaveState === "idle" ? "opacity-0" : "opacity-100",
            )}
          >
            {autosaveState === "saving"
              ? "Autosaving..."
              : autosaveState === "saved"
                ? "Saved"
                : autosaveState === "error"
                  ? "Could not save"
                  : "Idle"}
          </span>
        </div>
      </div>
    );
  }

  if (editing) {

    return (
      <textarea
        ref={inputRef}
        value={draft}
        rows={1}
        onChange={(e) => {
          setDraft(e.target.value);
          autoSize(e.target);
        }}
        onBlur={() => {
          void commit();
        }}
        onKeyDown={handleKeyDown}
        className={cn(
          "w-full bg-transparent rounded outline-none resize-none overflow-hidden",
          pad,
          className
        )}
      />
    );
  }

  // Use div instead of Tag when rendering markdown to avoid invalid nesting
  // (e.g. <p> cannot contain the <div>/<p> elements that markdown produces)
  const DisplayTag = value && multiline ? "div" : Tag;

  return (
    <DisplayTag
      className={cn(
        "cursor-pointer rounded hover:bg-accent/50 transition-colors overflow-hidden",
        pad,
        !value && "text-muted-foreground italic",
        className,
      )}
      onClick={() => setEditing(true)}
    >
      {value || placeholder}
    </DisplayTag>
  );
}
