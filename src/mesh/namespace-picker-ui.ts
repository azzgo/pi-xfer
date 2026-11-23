import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, SelectList, Text, matchesKey, type KeybindingsManager } from "@earendil-works/pi-tui";
import {
  NAMESPACE_ESCAPE_VALUE,
  emptyMatchNotice,
  filterRows,
  moveIndex,
  namespaceRows,
  pickerHeader,
  type NamespaceRow,
} from "./namespace-picker.ts";

export type NamespacePick = { kind: "session" | "default"; namespace: string };

export interface NamespacePickerInput {
  names: string[];
  current: string;
  defaultName: string;
  listingError: string | null;
}

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
      `↑↓ ctrl+p ctrl+n move · ${keyHint("tui.select.confirm", "this session")} · ${keyHint("app.models.save", "save as default")} · ${keyHint("tui.select.cancel", "cancel")}`,
    ),
  );
  container.addChild(hint);
  container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));

  let selectList: SelectList;
  let cursor = 0;
  let rowCount = 0;
  let visible = 1;

  const move = (delta: number) => {
    cursor = moveIndex(cursor, delta, rowCount);
    selectList.setSelectedIndex(cursor);
    tui.requestRender();
  };

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
    rowCount = shown.length;
    cursor = 0;
    visible = Math.max(1, Math.min(shown.length, 10));
    selectList = new SelectList(shown.map(toSelectItem), visible, {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    selectList.onSelect = () => resolve("session");
    selectList.onCancel = () => done(null);
    // Filtering is ours (substring); SelectList only matches prefixes.
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
      const up = keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.ctrl("p"));
      const down = keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.ctrl("n"));
      if (up) return move(-1);
      if (down) return move(1);
      if (keybindings.matches(data, "tui.select.pageUp")) return move(-visible);
      if (keybindings.matches(data, "tui.select.pageDown")) return move(visible);
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
