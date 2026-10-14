/**
 * The two Monaco internals `src/lib/editorMenu.ts` reaches into.
 *
 * `monaco-editor` ships types only for its public entry: the exports map sends every other
 * subpath at the bare `.js`, so these have to be declared by hand. Each shape below is the slice
 * this app actually calls, read off the module it stands for — `MenuRegistry.appendMenuItem` and
 * `CommandsRegistry.registerCommand` both hand back a disposable this app never needs, because
 * the registrations live as long as the bundle does.
 */
declare module "monaco-editor/platform/actions/common/actions" {
  interface IMenuCommand {
    id: string;
    title: string;
    /** A context-key expression string; `undefined` means the item is always offered. */
    precondition?: unknown;
  }

  interface IMenuItem {
    command: IMenuCommand;
    /** Menu items are grouped, and groups are ordered by name; `9_cutcopypaste` is Monaco's own. */
    group?: string;
    order?: number;
    when?: unknown;
  }

  export const MenuId: {
    readonly EditorContext: unique symbol;
    readonly SimpleEditorContext: unique symbol;
    readonly CommandPalette: unique symbol;
  };

  export const MenuRegistry: {
    appendMenuItem(
      menuId: typeof MenuId.EditorContext,
      item: IMenuItem
    ): { dispose(): void };
  };
}

declare module "monaco-editor/platform/commands/common/commands" {
  export const CommandsRegistry: {
    /** Registering an id that is already taken puts this handler at the head of the list. */
    registerCommand(
      id: string,
      handler: (accessor: unknown, ...args: unknown[]) => unknown
    ): { dispose(): void };
    getCommand(id: string): unknown;
  };
}
