/**
 * The namespace picker's terminal shell. Everything decided here is delegated to
 * `namespace-picker.ts`; this file only turns rows into a TUI component and maps
 * two keys onto two outcomes: **Enter** = this process, **ctrl+s** = the Default
 * namespace in `mesh.config.json` (ADR 0024).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Text, type KeybindingsManager } from "@earendil-works/pi-tui";
import {
  NAMESPACE_ESCAPE_VALUE,
  emptyMatchNotice,
  filterRows,
  namespaceRows,
  pickerHeader,
  type NamespaceRow,
} from "./namespace-picker.ts";

/** Which of the two outcomes the picker resolved to. */
export type NamespacePick = { kind: "session" | "default"; namespace: string };

export interface NamespacePickerInput {
  /** Namespaces the engine listed, sorted; ignored when `listingError` is set. */
  names: string[];
  current: string;
  defaultName: string;
  listingError: string | null;
}

/**
 * Open the picker and resolve to the chosen namespace, or `null` on cancel.
 * Caller owns the effects (session override or config write).
 */
export function pickNamespaceWithUi(
  ctx: ExtensionContext,
  input: NamespacePickerInput,
): Promise<NamespacePick | null> {
  return ctx.ui.custom<NamespacePick | null>(
    (tui, theme, keybindings, done) => namespacePickerComponent(input, tui, theme, keybindings, done),
    { blocked: { kind: "question", message: "Pick a mesh namespace" } },
  );
}

function namespacePickerComponent(
  input: NamespacePickerInput,
  tui: { requestRender(): void },
  theme: any,
  keybindings: KeybindingsManager,
  done: (value: NamespacePick | null) => void,
) {
  const container = new Container();
  container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));
  container.addChild(new Text(theme.fg("accent", theme.bold(pickerHeader(input.current, input.defaultName)))));
  if (input.listingError !== null) {
    container.addChild(new Text(theme.fg("warning", `namespace list unavailable — ${input.listingError}`)));
  }

  const filterInput = new Input({ placeholder: "filter…" });
  filterInput.focused = true;
  container.addChild(filterInput);

  const listHost = new Container();
  container.addChild(listHost);

  const hint = new Text(
    theme.fg(
      "dim",
      `${keyHint("tui.select.confirm", "this session")} · ${keyHint("app.models.save", "save as default")} · ${keyHint("tui.select.cancel", "cancel")}`,
    ),
  );
  container.addChild(hint);
  container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));

  let selectList: SelectList;

  const resolve = (kind: "session" | "default") => {
    const item = selectList?.getSelectedItem();
    if (!item) return;
    const namespace = item.value === NAMESPACE_ESCAPE_VALUE ? filterInput.getValue().trim() : item.value;
    if (namespace === "") return;
    done({ kind, namespace });
  };

  const rebuild = () => {
    const typed = filterInput.getValue();
    const rows = namespaceRows({
      names: input.names,
      current: input.current,
      defaultName: input.defaultName,
      listingError: input.listingError,
      typed,
    });
    const shown = filterRows(rows, typed);
    selectList = new SelectList(shown.map(toSelectItem), Math.min(shown.length, 10), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    selectList.onSelect = () => resolve("session");
    selectList.onCancel = () => done(null);
    selectList.setFilter("");
    listHost.clear();
    listHost.addChild(selectList);
    const notice = emptyMatchNotice(typed, input.listingError, rows);
    if (notice !== null) listHost.addChild(new Text(theme.fg("warning", `  ${notice}`)));
  };

  rebuild();

  return {
    get focused(): boolean {
      return filterInput.focused;
    },
    set focused(value: boolean) {
      filterInput.focused = value;
    },
    capturesViewportInput: true,
    render(width: number): readonly string[] {
      return container.render(width);
    },
    invalidate(): void {
      container.invalidate();
    },
    handleInput(data: string): void {
      if (keybindings.matches(data, "tui.select.confirm")) {
        resolve("session");
        tui.requestRender();
        return;
      }
      if (keybindings.matches(data, "app.models.save")) {
        resolve("default");
        tui.requestRender();
        return;
      }
      if (keybindings.matches(data, "tui.select.cancel")) {
        done(null);
        return;
      }
      filterInput.handleInput(data);
      rebuild();
      tui.requestRender();
    },
  };
}

function toSelectItem(row: NamespaceRow) {
  return {
    value: row.value,
    label: row.label,
    ...(row.description === undefined ? {} : { description: row.description }),
  };
}
